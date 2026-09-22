/**
 * `weft.workflows.result.get` operation + REST binding — behavior tests.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { getWorkflowResultOperation, getWorkflowResultRestBinding } from './get-workflow-result.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  yield* [];
  return input;
});
const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal<string>('release');
});
const failingWorkflow = workflow({ name: 'failing' }).execute(async function* () {
  yield* [];
  throw new Error('workflow failed');
});

// Engines hold background timers/intervals and must be disposed, or they emit a
// WeftEngineLeakWarning and leak resources across tests. Track every engine the
// factory creates and dispose them after each test.
const createdEngines: Engine[] = [];

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  // Track immediately after construction so a throwing `register` below still leaves
  // the engine for `afterEach` to dispose.
  createdEngines.push(engine);
  engine.register(echoWorkflow);
  engine.register(holdWorkflow);
  engine.register(failingWorkflow);
  return { engine, storage };
}

const registry = createOperationRegistry([getWorkflowResultOperation]);
const bindings = [getWorkflowResultRestBinding];

// Surface the first disposal error rather than swallowing it; matches the shared
// pattern in list-workflows.test.ts and json-rpc-http-integration.test.ts.
function disposeCreatedEngines(): void {
  let disposeError: unknown;
  for (const engine of createdEngines.splice(0)) {
    try {
      engine[Symbol.dispose]();
    } catch (error) {
      disposeError ??= error;
    }
  }
  if (disposeError !== undefined) throw disposeError;
}

afterEach(() => {
  disposeCreatedEngines();
});

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

  it('returns 404 with the canonical error body when the workflow does not exist', async () => {
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
    expect(await response.json()).toEqual({
      error: 'Workflow "does-not-exist" not found',
      data: { resource: 'workflow', identifier: 'does-not-exist' },
    });
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

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    // `EngineFailure` falls through `shapeFault` to the canonical
    // `shapeRestFault`, which masks the raw engine message to a generic
    // "Internal server error" 500 so internal detail never reaches the
    // wire. The real message is still carried on the fault for JSON-RPC.
    const { engine } = createEngineWithStorage();
    const failingOperation = defineOperation({
      ...getWorkflowResultOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    });
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
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('clears the race timer on the result win path', async () => {
    const { engine } = createEngineWithStorage();
    const handle = await engine.start('hold', null, { id: 'workflow-result-clears-timer' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    // The happy path early-returns for `completed` workflows before reaching the
    // `Promise.race`, so to exercise the race win path the workflow must be `running`
    // at lookup time with a `result()` that resolves promptly. Return a prototype-
    // preserving *clone* of the real handle with only `result` overridden, rather than
    // mutating the real handle in place: the engine retains its own reference to the
    // real handle, and mutating its `result()` in place changes that shared instance's
    // timer behavior, which masks the leak the test is meant to catch. The clone keeps
    // the stub isolated to this request. Restore `getHandle` in `finally`.
    const originalGetHandle = engine.getHandle;
    const callOriginalGetHandle = originalGetHandle.bind(engine);
    engine.getHandle = (workflowId: string) => {
      const original = callOriginalGetHandle(workflowId);
      const wrapped = Object.create(Object.getPrototypeOf(original));
      Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
      // Define rather than assign in case the real handle's `result` descriptor is
      // non-writable; a bare assignment would throw under module strict mode.
      Object.defineProperty(wrapped, 'result', {
        value: async () => ({ ok: true }),
        writable: true,
        configurable: true,
      });
      return wrapped;
    };

    // Bun's spy wrapper forwards the native timer calls and records return values,
    // allowing the exact race handle to be compared with the clear call.
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

    try {
      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${handle.id}/result`, { method: 'GET' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(200);
      // The race timer must have been scheduled, and the real handle must be cleared.
      const raceTimerCall = setTimeoutSpy.mock.calls.find(([, timeout]) => timeout === 30_000);
      expect(raceTimerCall).toBeDefined();
      if (raceTimerCall === undefined) throw new Error('expected race timer call');
      const raceTimerIndex = setTimeoutSpy.mock.calls.indexOf(raceTimerCall);
      const raceTimerResult = setTimeoutSpy.mock.results[raceTimerIndex];
      if (raceTimerResult?.type !== 'return' || raceTimerResult.value === undefined) {
        throw new Error('expected native race timer handle');
      }
      const raceTimerId = raceTimerResult.value;
      expect(clearTimeoutSpy.mock.calls.some(([timerId]) => timerId === raceTimerId)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      engine.getHandle = originalGetHandle;
    }
    // The engine (with its still-running `hold` workflow) is disposed by `afterEach`,
    // which runs after the spies are restored so teardown uses the real `clearTimeout`.
  });
});
