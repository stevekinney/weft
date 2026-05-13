/**
 * `weft.workflows.get` operation + REST binding — behavior tests.
 *
 * Exercises the operation through the shared `executeOperation`
 * pipeline (the only dispatch path). Happy path returns the workflow
 * state; nonexistent id returns a 404 with the `{ error: <message> }`
 * body shape.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './get-workflow.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* ctx.waitForSignal<string>('release');
  });
  return engine;
}

const registry = createOperationRegistry([getWorkflowOperation]);
const bindings = [getWorkflowRestBinding];

describe('weft.workflows.get', () => {
  it('returns the workflow state on the happy path', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const request = new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'GET' });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { id?: string };
    expect(body.id).toBe(handle.id);
  });

  it('returns 404 with the error-message body when the workflow does not exist', async () => {
    const engine = createEngine();

    const request = new Request('http://localhost/v1/workflows/does-not-exist', { method: 'GET' });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Workflow "does-not-exist" not found' });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const failingOperation = {
      ...getWorkflowOperation,
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
      new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: [getWorkflowRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
