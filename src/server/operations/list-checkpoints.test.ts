import { afterEach, describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { listCheckpointsOperation, listCheckpointsRestBinding } from './list-checkpoints.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

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

const registry = createOperationRegistry([listCheckpointsOperation]);

describe('weft.workflows.checkpoints.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns checkpoint summaries on the happy path', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, { id: 'wf-list-checkpoints' });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const expected = await engine.listCheckpoints(handle.id);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expected);
  });

  it('returns msgpack when the Accept header requests it', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, {
      id: 'wf-list-checkpoints-msgpack',
    });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const expected = await engine.listCheckpoints(handle.id);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints`, {
        method: 'GET',
        headers: { Accept: 'application/msgpack' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
    const decoded = decode(new Uint8Array(await response.arrayBuffer()));
    expect(decoded).toEqual(expected);
  });

  it('returns 200 with an empty array for an unknown workflow id', async () => {
    // Legacy `engine.listCheckpoints` returns `[]` rather than throwing
    // when the workflow does not exist — the migrated operation
    // preserves that contract verbatim. This test pins the behavior
    // so a future change in the engine can't silently flip the API
    // contract from "always 200, possibly empty" to "404 on missing".
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/does-not-exist/checkpoints', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual([]);
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    engine = createEngine();

    const failingOperation = {
      ...listCheckpointsOperation,
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
      new Request('http://localhost/v1/workflows/wf-list-checkpoints/checkpoints', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
