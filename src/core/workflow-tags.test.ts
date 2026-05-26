import { describe, expect, it } from 'bun:test';
import { sleepForTesting, waitForRealTimersForTesting } from '../testing/fake-timers.ts';

import { KEYS, type BatchOperation, type ScanOptions, type Storage } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { Engine } from './engine.ts';
import {
  coerceStartWorkflowTags,
  MAX_WORKFLOW_TAG_BYTES,
  MAX_WORKFLOW_TAGS,
} from './start-workflow-validation.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';
import {
  buildWorkflowTagIndexOperations,
  isWorkflowTagArray,
  matchesWorkflowTagFilter,
  normalizeWorkflowTags,
} from './workflow-tags.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

async function collectKeys(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  const iterable = storage.keys
    ? storage.keys(prefix)
    : (async function* (): AsyncIterable<string> {
        for await (const [key] of storage.scan(prefix)) {
          yield key;
        }
      })();

  for await (const key of iterable) {
    keys.push(key);
  }

  return keys;
}

class WorkflowStateWriteTrackingStorage implements Storage {
  readonly #storage = new MemoryStorage();
  readonly #trackedWorkflowKey: string;

  activeWorkflowWrites = 0;
  maxConcurrentWorkflowWrites = 0;

  constructor(workflowId: string) {
    this.#trackedWorkflowKey = KEYS.workflow(workflowId);
  }

  capabilities() {
    return this.#storage.capabilities();
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#storage.get(key);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    if (key === this.#trackedWorkflowKey) {
      await this.#trackWorkflowStateWrite(() => this.#storage.put(key, value));
      return;
    }

    await this.#storage.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(key);
  }

  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    return this.#storage.scan(prefix, options);
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    const writesTrackedWorkflowState = operations.some(
      (operation) => operation.type === 'put' && operation.key === this.#trackedWorkflowKey,
    );
    if (writesTrackedWorkflowState) {
      await this.#trackWorkflowStateWrite(() => this.#storage.batch(operations));
      return;
    }

    await this.#storage.batch(operations);
  }

  async has(key: string): Promise<boolean> {
    return (await this.#storage.get(key)) !== null;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const operations: BatchOperation[] = [];
    for await (const key of this.keys(prefix)) {
      operations.push({ type: 'delete', key });
    }
    if (operations.length === 0) {
      return 0;
    }
    await this.batch(operations);
    return operations.length;
  }

  async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    for await (const [key] of this.#storage.scan(prefix, options)) {
      yield key;
    }
  }

  async count(prefix: string): Promise<number> {
    let total = 0;
    for await (const _key of this.keys(prefix)) {
      total++;
    }
    return total;
  }

  scoped(prefix: string): Storage {
    return this.#storage.scoped?.(prefix) ?? this.#storage;
  }

  [Symbol.dispose](): void {
    this.#storage[Symbol.dispose]();
  }

  async #trackWorkflowStateWrite(writeOperation: () => Promise<void>): Promise<void> {
    this.activeWorkflowWrites++;
    this.maxConcurrentWorkflowWrites = Math.max(
      this.maxConcurrentWorkflowWrites,
      this.activeWorkflowWrites,
    );

    try {
      await waitForRealTimersForTesting(25);
      await writeOperation();
    } finally {
      this.activeWorkflowWrites--;
    }
  }
}

describe('workflow tags', () => {
  it('normalizes workflow tags by trimming, deduplicating, and sorting', () => {
    expect(normalizeWorkflowTags(undefined)).toBeUndefined();
    expect(normalizeWorkflowTags([' beta ', 'alpha', 'alpha', '   '])).toEqual(['alpha', 'beta']);
  });

  it('builds tag index operations only for changed tags', () => {
    expect(
      buildWorkflowTagIndexOperations('workflow-1', ['alpha', 'beta'], ['beta', 'gamma']),
    ).toEqual([
      { type: 'delete', key: KEYS.tagIndex('alpha', 'workflow-1') },
      { type: 'put', key: KEYS.tagIndex('gamma', 'workflow-1'), value: new Uint8Array(0) },
    ]);
  });

  it('matches workflow tag filters by intersection and rejects empty workflow tags', () => {
    expect(isWorkflowTagArray(['alpha', 'beta'])).toBe(true);
    expect(isWorkflowTagArray(['alpha', 1])).toBe(false);
    expect(matchesWorkflowTagFilter(['alpha', 'beta'], ['alpha'])).toBe(true);
    expect(matchesWorkflowTagFilter(['alpha', 'beta'], ['alpha', 'gamma'])).toBe(false);
    expect(matchesWorkflowTagFilter(undefined, ['alpha'])).toBe(false);
    expect(matchesWorkflowTagFilter(['alpha'], undefined)).toBe(true);
  });

  it('tag validation rejects too many tags and oversized tags', () => {
    expect(() =>
      coerceStartWorkflowTags(
        Array.from({ length: MAX_WORKFLOW_TAGS + 1 }, (_, index) => `tag-${index}`),
        'Field "tags"',
      ),
    ).toThrow(`Field "tags" must contain at most ${MAX_WORKFLOW_TAGS} tags`);

    expect(() =>
      coerceStartWorkflowTags(['x'.repeat(MAX_WORKFLOW_TAG_BYTES + 1)], 'Field "tags"'),
    ).toThrow(`Field "tags" tags must be at most ${MAX_WORKFLOW_TAG_BYTES} UTF-8 bytes each`);
  });

  it('StartOptions.tags accepts string[] and stores normalized tags alongside workflow state', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const echoWorkflow2 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow2);

    try {
      const handle = await engine.start('echo', 'hello', {
        id: 'tagged-start',
        tags: ['nightly', 'v2', 'nightly'],
      });
      await handle.result();

      const state = await engine.get('tagged-start');
      expect(state).not.toBeNull();
      expect(state?.tags).toEqual(['nightly', 'v2']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) and handle.removeTags(...tags) mutate tags durably', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const waitForSignalWorkflow2 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow2);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: 'durable-tags',
        tags: ['alpha'],
      });
      await sleepForTesting(10);

      await handle.addTags('beta', 'alpha');
      await handle.removeTags('alpha');

      const state = await engine.get('durable-tags');
      expect(state?.tags).toEqual(['beta']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }

    const recoveredEngine = new Engine({ storage });
    const waitForSignalWorkflow3 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    recoveredEngine.register(waitForSignalWorkflow3);

    try {
      const recoveredState = await recoveredEngine.get('durable-tags');
      expect(recoveredState?.tags).toEqual(['beta']);
    } finally {
      await recoveredEngine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) keeps the terminal workflow index synchronized', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
    });
    const echoWorkflow3 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow3);

    try {
      const handle = await engine.start('echo', 'done', {
        id: 'terminal-tagged-workflow',
        tags: ['alpha'],
      });
      await handle.result();

      expect(await collectKeys(storage, KEYS.terminalWorkflowPrefix())).toEqual([
        KEYS.terminalWorkflow(now, handle.id),
      ]);

      now = 2_000;
      await handle.addTags('beta');

      const state = await engine.get(handle.id);
      expect(state?.tags).toEqual(['alpha', 'beta']);
      expect(state?.updatedAt).toBe(now);
      expect(await collectKeys(storage, KEYS.terminalWorkflowPrefix())).toEqual([
        KEYS.terminalWorkflow(now, handle.id),
      ]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) enforces the total tag count after combining with existing tags', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const waitForSignalWorkflow4 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow4);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: 'tag-limit-after-add',
        tags: Array.from({ length: MAX_WORKFLOW_TAGS - 1 }, (_, index) => `tag-${index}`),
      });
      await sleepForTesting(10);

      await expect(handle.addTags('overflow-a', 'overflow-b')).rejects.toThrow(
        `Workflow tags must contain at most ${MAX_WORKFLOW_TAGS} tags`,
      );

      const state = await engine.get('tag-limit-after-add');
      expect(state?.tags).toHaveLength(MAX_WORKFLOW_TAGS - 1);
      expect(state?.tags).not.toContain('overflow-a');
      expect(state?.tags).not.toContain('overflow-b');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('handle.addTags(...tags) reports tag mutation validation errors with workflow-tag context', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const waitForSignalWorkflow5 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow5);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: 'tag-validation-context',
        tags: ['alpha'],
      });
      await sleepForTesting(10);

      await expect(handle.addTags('')).rejects.toThrow('Workflow tags must not contain empty tags');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('serializes tag mutations with concurrent workflow state writes', async () => {
    const workflowId = 'serialized-tag-mutations';
    const storage = new WorkflowStateWriteTrackingStorage(workflowId);
    const engine = new Engine({ storage });
    const waitForSignalWorkflow6 = workflow({ name: 'wait-for-signal' }).execute(
      waitForSignalWorkflow,
    );
    engine.register(waitForSignalWorkflow6);

    try {
      const handle = await engine.start('wait-for-signal', 'payload', {
        id: workflowId,
        tags: ['alpha'],
      });
      await sleepForTesting(10);

      const addTagsPromise = handle.addTags('beta');
      await sleepForTesting(0);
      const signalPromise = handle.signal('continue', 'done');

      await Promise.all([addTagsPromise, signalPromise]);
      await expect(handle.result()).resolves.toBe('payload:done');

      const state = await engine.get(workflowId);
      expect(state?.status).toBe('completed');
      expect(state?.tags).toEqual(['alpha', 'beta']);
      expect(storage.maxConcurrentWorkflowWrites).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it("engine.list({ tags: ['nightly', 'v2'] }) filters by tag intersection", async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const echoWorkflow4 = workflow({ name: 'echo' }).execute(echoWorkflow);
    engine.register(echoWorkflow4);

    try {
      const firstHandle = await engine.start('echo', 'one', {
        id: 'wf-1',
        tags: ['nightly', 'v2'],
      });
      const secondHandle = await engine.start('echo', 'two', { id: 'wf-2', tags: ['nightly'] });
      const thirdHandle = await engine.start('echo', 'three', { id: 'wf-3', tags: ['v2'] });
      await firstHandle.result();
      await secondHandle.result();
      await thirdHandle.result();

      const result = await engine.list({ tags: [' nightly ', 'v2', 'nightly'] });

      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual(['wf-1']);
      expect(result.items[0]?.tags).toEqual(['nightly', 'v2']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('Tags are distinct from search attributes', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const searchableWorkflow = workflow({ name: 'searchable' })
      .searchAttributes({
        priority: { type: 'string' },
      })
      .execute(waitForSignalWorkflow);
    engine.register(searchableWorkflow);

    try {
      await engine.start('searchable', 'payload', {
        id: 'tag-distinction',
        tags: ['nightly'],
        searchAttributes: { priority: 'high' },
      });
      await sleepForTesting(10);

      const attributes = await engine.getAttributes('tag-distinction');
      expect(attributes).toEqual({ priority: 'high' });

      const byTags = await engine.list({ tags: ['nightly'] });
      expect(byTags.items.map((item) => item.id)).toEqual(['tag-distinction']);

      const byAttributes = await engine.list({
        attributes: [{ key: 'tags', value: 'nightly' }],
      });
      expect(byAttributes.total).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
