/**
 * `weft.workflows.get` operation + REST binding — behavior tests.
 *
 * Exercises the operation through the shared `executeOperation`
 * pipeline (the only dispatch path). Happy path returns the workflow
 * state; nonexistent id returns a 404 with the `{ error: <message> }`
 * body shape.
 */

import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './get-workflow.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await Bun.sleep(5);
  }
  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

const registry = createOperationRegistry([getWorkflowOperation]);
const bindings = [getWorkflowRestBinding];

describe('weft.workflows.get', () => {
  it('returns the workflow state on the happy path', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForStatus(engine, handle.id, 'running');

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
});
