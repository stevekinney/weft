import { afterEach, describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getCheckpointAtOperation, getCheckpointAtRestBinding } from './get-checkpoint-at.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.ts';

const noop = async () => null;

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage(), checkpointHistory: 10 });
  engine.register('steps-then-wait', async function* (ctx: WorkflowContext) {
    yield* ctx.run(noop);
    yield* ctx.run(noop);
    yield* ctx.waitForSignal('release');
    return 'done';
  });
  return engine;
}

const registry = createOperationRegistry([getCheckpointAtOperation]);

describe('weft.workflows.checkpoints.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the checkpoint state on the happy path', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, { id: 'wf-checkpoint-at' });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const expected = await engine.getCheckpointAt(handle.id, 1);

    expect(expected).not.toBeNull();

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints/1`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCheckpointAtRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expected);
  });

  it('returns msgpack when the Accept header requests it', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, {
      id: 'wf-checkpoint-at-msgpack',
    });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const expected = await engine.getCheckpointAt(handle.id, 1);

    expect(expected).not.toBeNull();

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints/1`, {
        method: 'GET',
        headers: { Accept: 'application/msgpack' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCheckpointAtRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
    const decoded = decode(new Uint8Array(await response.arrayBuffer()));
    expect(decoded).toEqual(expected);
  });

  it('returns 400 with the legacy error body for an invalid step parameter', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-checkpoint-at/checkpoints/not-a-number', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCheckpointAtRestBinding],
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid step: not-a-number' });
  });

  it('returns 404 with the legacy error body when the checkpoint does not exist', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, {
      id: 'wf-checkpoint-at-missing',
    });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints/99`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCheckpointAtRestBinding],
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: `Checkpoint not found at step 99 for workflow ${handle.id}`,
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getCheckpointAtOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-checkpoint-at/checkpoints/1', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getCheckpointAtRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
