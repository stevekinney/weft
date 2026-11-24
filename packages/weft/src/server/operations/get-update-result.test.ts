import { afterEach, describe, expect, it } from 'bun:test';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { UpdateCoordinator } from '../../core/updates.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { getUpdateResultOperation, getUpdateResultRestBinding } from './get-update-result.ts';

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { engine: new Engine({ storage }), storage };
}

const registry = createOperationRegistry([getUpdateResultOperation]);

describe('weft.updates.result.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns 202 pending when the update result is not ready yet', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;
    const coordinator = new UpdateCoordinator(setup.storage);
    const updateId = await coordinator.createRequest('wf-update-pending', 'setName', {
      name: 'Alice',
    });

    const response = await handleRequest(
      new Request(`http://localhost/v1/updates/${updateId}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('returns the completed update result payload', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;
    const coordinator = new UpdateCoordinator(setup.storage);
    const request = await coordinator.submitRequest('wf-update-completed', 'setName', {
      name: 'Alice',
    });
    const { updateId } = request;

    await setup.storage.batch(
      coordinator.buildResponseOperations(
        updateId,
        'wf-update-completed',
        { accepted: true },
        'minor issue',
        undefined,
        { name: request.name, receivedAt: request.createdAt },
      ),
    );

    const response = await handleRequest(
      new Request(`http://localhost/v1/updates/${updateId}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      status: 'completed',
      result: { accepted: true },
      error: 'minor issue',
    });
  });

  it('returns 202 pending for a completely unknown update id', async () => {
    // A pending update returns `202 {status:'pending'}`
    // for both "update created, no response yet" AND "update id has
    // never existed" — the engine surfaces both as a `null` result.
    // Pin that behavior here so a future change can't silently flip
    // unknown ids to 404 without an explicit test failure.
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const response = await handleRequest(
      new Request('http://localhost/v1/updates/does-not-exist-anywhere', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const failingOperation = defineOperation({
      ...getUpdateResultOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/updates/any-update-id', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
  });
});
