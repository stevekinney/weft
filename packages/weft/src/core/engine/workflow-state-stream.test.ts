import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { flush } from '../../testing/storage-backends.test-support.ts';
import type { ListFilter, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';
import {
  queryChildWorkflowIndex,
  queryScheduleRunIndex,
  streamMatchingWorkflowStates,
} from './workflow-state-stream.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

async function collectMatchingWorkflowIds(engine: Engine, filter: ListFilter): Promise<string[]> {
  const ids: string[] = [];

  for await (const state of streamMatchingWorkflowStates(getInternals(engine), filter)) {
    ids.push(state.id);
  }

  return ids;
}

class ConcurrentWorkflowStateReadCountingStorage extends MemoryStorage {
  workflowReadCount = 0;
  activeWorkflowReadCount = 0;
  maxConcurrentWorkflowReadCount = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (!key.startsWith('wf:stream-batched-')) {
      return super.get(key);
    }

    this.workflowReadCount += 1;
    this.activeWorkflowReadCount += 1;
    this.maxConcurrentWorkflowReadCount = Math.max(
      this.maxConcurrentWorkflowReadCount,
      this.activeWorkflowReadCount,
    );
    try {
      await Promise.resolve();
      return await super.get(key);
    } finally {
      this.activeWorkflowReadCount -= 1;
    }
  }

  resetWorkflowReadCounts(): void {
    this.workflowReadCount = 0;
    this.activeWorkflowReadCount = 0;
    this.maxConcurrentWorkflowReadCount = 0;
  }
}

class OversizedIndexStorage extends MemoryStorage {
  constructor(private readonly indexPrefix: string) {
    super();
  }

  override async *scan(prefix: string): AsyncIterableIterator<[string, Uint8Array]> {
    if (prefix !== this.indexPrefix) return;
    for (let index = 0; index <= MAX_LIST_SCAN_ROWS; index += 1) {
      yield [`${prefix}${String(index)}`, new Uint8Array()];
    }
  }
}

describe('streamMatchingWorkflowStates', () => {
  it('batches constrained workflow-state reads across chunk boundaries', async () => {
    const storage = new ConcurrentWorkflowStateReadCountingStorage();
    const engine = new Engine({ storage });
    const echoWorkflow2 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow2);

    try {
      const handles = await Promise.all(
        Array.from({ length: 130 }, (_, index) =>
          engine.start('echo', `value-${index}`, {
            id: `stream-batched-${String(index).padStart(3, '0')}`,
            tags: ['selected'],
          }),
        ),
      );
      await Promise.all(handles.map((handle) => handle.result()));
      storage.resetWorkflowReadCounts();

      const ids = await collectMatchingWorkflowIds(engine, { tags: ['selected'] });

      expect(ids.toSorted()).toEqual(
        Array.from(
          { length: 130 },
          (_, index) => `stream-batched-${String(index).padStart(3, '0')}`,
        ),
      );
      expect(storage.workflowReadCount).toBe(130);
      expect(storage.maxConcurrentWorkflowReadCount).toBeGreaterThan(1);
      expect(storage.maxConcurrentWorkflowReadCount).toBeLessThanOrEqual(64);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('streams workflows from the shared constrained-id scan path', async () => {
    const engine = new Engine();
    const echoWorkflow2 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow2);

    try {
      const firstHandle = await engine.start('echo', 'first', {
        id: 'stream-selected-a',
        tags: ['selected'],
      });
      const otherHandle = await engine.start('echo', 'second', {
        id: 'stream-other',
        tags: ['other'],
      });
      const secondHandle = await engine.start('echo', 'third', {
        id: 'stream-selected-b',
        tags: ['selected'],
      });
      await firstHandle.result();
      await otherHandle.result();
      await secondHandle.result();

      await expect(collectMatchingWorkflowIds(engine, { tags: ['selected'] })).resolves.toEqual([
        'stream-selected-a',
        'stream-selected-b',
      ]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('streams workflows constrained by search attributes', async () => {
    const engine = new Engine();
    const echoWorkflow3 = workflow({ name: 'echo' })
      .searchAttributes({ customerId: { type: 'string' } })
      .execute(waitForSignalWorkflow);
    engine.register(echoWorkflow3);

    try {
      await engine.start('echo', 'first', {
        id: 'stream-attribute-alpha-a',
        searchAttributes: { customerId: 'alpha' },
      });
      await engine.start('echo', 'second', {
        id: 'stream-attribute-beta',
        searchAttributes: { customerId: 'beta' },
      });
      await engine.start('echo', 'third', {
        id: 'stream-attribute-alpha-b',
        searchAttributes: { customerId: 'alpha' },
      });
      await flush();

      const matchingIds = await collectMatchingWorkflowIds(engine, {
        attributes: [{ key: 'customerId', value: 'alpha' }],
      });
      const emptyIds = await collectMatchingWorkflowIds(engine, {
        attributes: [{ key: 'customerId', value: 'missing' }],
      });

      expect(matchingIds.toSorted()).toEqual([
        'stream-attribute-alpha-a',
        'stream-attribute-alpha-b',
      ]);
      expect(emptyIds).toEqual([]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('intersects tag and search attribute filters', async () => {
    const engine = new Engine();
    const echoWorkflow4 = workflow({ name: 'echo' })
      .searchAttributes({ customerId: { type: 'string' } })
      .execute(waitForSignalWorkflow);
    engine.register(echoWorkflow4);

    try {
      await engine.start('echo', 'first', {
        id: 'stream-intersection-selected-alpha',
        tags: ['selected'],
        searchAttributes: { customerId: 'alpha' },
      });
      await engine.start('echo', 'second', {
        id: 'stream-intersection-untagged-alpha',
        searchAttributes: { customerId: 'alpha' },
      });
      await engine.start('echo', 'third', {
        id: 'stream-intersection-selected-beta',
        tags: ['selected'],
        searchAttributes: { customerId: 'beta' },
      });
      await flush();

      const matchingIds = await collectMatchingWorkflowIds(engine, {
        tags: ['selected'],
        attributes: [{ key: 'customerId', value: 'alpha' }],
      });

      expect(matchingIds).toEqual(['stream-intersection-selected-alpha']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('workflow reverse-index scan caps', () => {
  it('rejects a direct-child index that exceeds the bounded scan cap', async () => {
    const prefix = KEYS.childWorkflowByParentPrefix('parent-id', 'parent-token');
    await using engine = new Engine({ storage: new OversizedIndexStorage(prefix) });

    await expect(
      queryChildWorkflowIndex(getInternals(engine), 'parent-id', 'parent-token'),
    ).rejects.toBeInstanceOf(WorkflowListScanCapExceededError);
  });

  it('rejects a schedule-run index that exceeds the bounded scan cap', async () => {
    const prefix = KEYS.scheduleRunBySchedulePrefix('schedule-id');
    await using engine = new Engine({ storage: new OversizedIndexStorage(prefix) });

    await expect(queryScheduleRunIndex(getInternals(engine), 'schedule-id')).rejects.toBeInstanceOf(
      WorkflowListScanCapExceededError,
    );
  });
});
