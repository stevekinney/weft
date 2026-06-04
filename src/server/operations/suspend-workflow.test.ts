import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { WorkflowSuspendNotSupportedError } from '../../core/engine/errors.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';
import { suspendWorkflowOperation, suspendWorkflowRestBinding } from './suspend-workflow.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal<string>('release');
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

const registry = createOperationRegistry([suspendWorkflowOperation]);
const bindings = [suspendWorkflowRestBinding];

function suspendRequest(id: string): Request {
  return new Request(`http://localhost/v1/workflows/${id}/suspend`, { method: 'POST' });
}

describe('weft.workflows.suspend', () => {
  it('suspends a running workflow and returns 204', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'suspend-success' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(suspendRequest(handle.id), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(204);
    await waitForWorkflowStatus(engine, handle.id, 'suspended');
    await engine[Symbol.asyncDispose]();
  });

  it('is a 204 no-op for a workflow that is not running', async () => {
    const engine = createEngine();
    // Never-started id: suspend is a no-op, still returns 204.
    const response = await handleRequest(suspendRequest('never-started'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });
    expect(response.status).toBe(204);
    await engine[Symbol.asyncDispose]();
  });

  it('maps worker-mode WorkflowSuspendNotSupportedError to a 422 Unprocessable', async () => {
    const engine = createEngine();
    const originalSuspend = engine.suspend.bind(engine);
    engine.suspend = async () => {
      throw new WorkflowSuspendNotSupportedError('suspend is only supported in inline mode');
    };

    try {
      const response = await handleRequest(suspendRequest('wf-worker'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: unknown };
      expect(String(body.error)).toMatch(/inline mode/i);
    } finally {
      engine.suspend = originalSuspend;
      await engine[Symbol.asyncDispose]();
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalSuspend = engine.suspend.bind(engine);
    engine.suspend = async () => {
      throw new Error('suspend failed internally');
    };

    try {
      const response = await handleRequest(suspendRequest('wf-1'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.suspend = originalSuspend;
      await engine[Symbol.asyncDispose]();
    }
  });
});
