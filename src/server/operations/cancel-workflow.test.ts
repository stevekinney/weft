import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { cancelWorkflowOperation, cancelWorkflowRestBinding } from './cancel-workflow.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal<string>('release');
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

const registry = createOperationRegistry([cancelWorkflowOperation]);
const bindings = [cancelWorkflowRestBinding];

describe('weft.workflows.cancel', () => {
  it('cancels a workflow and returns 204', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'cancel-success' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const resultPromise = handle.result().catch(() => undefined);
    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    await resultPromise;
    await waitForWorkflowStatus(engine, handle.id, 'cancelled');
  });

  it('returns 404 when the engine reports that the workflow was not found', async () => {
    const engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('workflow not found');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/missing', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'workflow not found',
        data: { resource: 'workflow', identifier: 'missing' },
      });
    } finally {
      engine.cancel = originalCancel;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('cancel failed internally');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-1', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.cancel = originalCancel;
    }
  });
});
