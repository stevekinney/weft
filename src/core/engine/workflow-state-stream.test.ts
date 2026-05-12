import { describe, expect, it } from 'bun:test';

import type { WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { streamMatchingWorkflowStates } from './workflow-state-stream.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function collectMatchingWorkflowIds(engine: Engine, tags: string[]): Promise<string[]> {
  const ids: string[] = [];

  for await (const state of streamMatchingWorkflowStates(getInternals(engine), { tags })) {
    ids.push(state.id);
  }

  return ids;
}

describe('streamMatchingWorkflowStates', () => {
  it('streams workflows from the shared constrained-id scan path', async () => {
    const engine = new Engine();
    engine.register('echo', echoWorkflow);

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

      await expect(collectMatchingWorkflowIds(engine, ['selected'])).resolves.toEqual([
        'stream-selected-a',
        'stream-selected-b',
      ]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
