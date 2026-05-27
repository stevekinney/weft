import { describe, expect, it } from 'bun:test';

import { flush } from '../../testing/storage-backends.test-support.ts';
import type { ListFilter, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { streamMatchingWorkflowStates } from './workflow-state-stream.ts';

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

describe('streamMatchingWorkflowStates', () => {
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
