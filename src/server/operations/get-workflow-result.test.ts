/**
 * `weft.workflows.result.get` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getWorkflowResultOperation, getWorkflowResultRestBinding } from './get-workflow-result.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.ts';

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  engine.register('hold', async function* (ctx: WorkflowContext) {
    return yield* ctx.waitForSignal<string>('release');
  });
  engine.register('failing', async function* () {
    throw new Error('workflow failed');
  });
  return { engine, storage };
}

const registry = createOperationRegistry([getWorkflowResultOperation]);
const bindings = [getWorkflowResultRestBinding];

describe('weft.workflows.result.get', () => {
  it('returns the workflow result on the happy path', async () => {
    const { engine } = createEngineWithStorage();
    const handle = await engine.start('echo', { answer: 42 }, { id: 'workflow-result-success' });
    await waitForWorkflowStatus(engine, handle.id, 'completed');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/result`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ result: { answer: 42 } });
  });

  it('returns 404 with the legacy error body when the workflow does not exist', async () => {
    const { engine } = createEngineWithStorage();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/does-not-exist/result', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Workflow "does-not-exist" not found' });
  });

  it('returns 422 with the workflow failure message when the workflow failed', async () => {
    const { engine } = createEngineWithStorage();
    const handle = await engine.start('failing', null, { id: 'workflow-result-failed' });
    await handle.result().catch(() => undefined);
    await waitForWorkflowStatus(engine, handle.id, 'failed');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/result`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'workflow failed' });
  });

  it('returns 422 with the default failure message when a failed workflow has no error text', async () => {
    const { engine, storage } = createEngineWithStorage();
    const handle = await engine.start('failing', null, { id: 'workflow-result-failed-default' });
    await handle.result().catch(() => undefined);
    await waitForWorkflowStatus(engine, handle.id, 'failed');

    const storedState = await engine.get(handle.id);
    if (storedState === null) {
      throw new Error('Expected stored workflow state');
    }
    const { error: _ignored, ...stateWithoutError } = storedState;
    await storage.put(KEYS.workflow(handle.id), encode(stateWithoutError));

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/result`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Workflow failed' });
  });

  it('returns 422 when the workflow was cancelled', async () => {
    const { engine } = createEngineWithStorage();
    const handle = await engine.start('hold', null, { id: 'workflow-result-cancelled' });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const resultPromise = handle.result().catch(() => undefined);
    await engine.cancel(handle.id);
    await resultPromise;
    await waitForWorkflowStatus(engine, handle.id, 'cancelled');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/result`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Workflow cancelled' });
  });

  it('returns 408 when waiting for a running workflow result times out', async () => {
    const { engine } = createEngineWithStorage();
    const handle = await engine.start('hold', null, { id: 'workflow-result-timeout' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const originalGetHandle = engine.getHandle.bind(engine);
    engine.getHandle = (workflowId: string) => {
      const workflowHandle = originalGetHandle(workflowId);
      workflowHandle.result = async () => {
        throw new Error('Timeout waiting for workflow result');
      };
      return workflowHandle;
    };

    try {
      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${handle.id}/result`, { method: 'GET' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(408);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({ error: 'Timeout waiting for workflow result' });
    } finally {
      engine.getHandle = originalGetHandle;
    }
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    // Legacy `handleGetWorkflowResult` echoed the raw engine error
    // string directly into the 500 body via `errorResponse(message, 500)`.
    // The migrated path preserves that byte-for-byte: `EngineFailure`
    // falls through `shapeFault` to the generic `{error: fault.message}`
    // shape with the canonical 500 status. Sanitizing internal error
    // strings is a deliberate behavior shift that lands in a separate
    // PR — see commit message.
    const { engine } = createEngineWithStorage();
    const failingOperation = {
      ...getWorkflowResultOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/whatever/result', { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'secret internal detail' });
  });
});
