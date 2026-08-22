import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { UpdateRequest } from '../updates.ts';
import {
  deliverCoordinatedUpdateToWaiterIfAvailable,
  extractStandardSchemaIssues,
  processWaitUpdateOperation,
  tryInlineUpdateHandler,
  update,
} from './updates.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

function createUpdateRequest(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    updateId: 'update-1',
    workflowId: 'workflow-1',
    name: 'rename',
    payload: { value: 'patched' },
    createdAt: 123,
    ...overrides,
  };
}

describe('engine update helpers', () => {
  it('throws the coordinated response error returned by update()', async () => {
    const internals = {
      inlineStrategy: null,
      workflowClaimRegistry: null,
      updateWaiters: new Map(),
      updateWaitersByWorkflow: new Map(),
      updateCoordinator: {
        createRequest: mock(async () => 'update-1'),
        waitForResponse: mock(async () => ({ updateId: 'update-1', error: 'coordinated boom' })),
      },
    } as any;

    const callbacks = {
      guardTerminalWorkflow: mock(async () => {}),
      guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
      schedulePendingInlineUpdateDrain: mock(() => {}),
      dispatchEvent: mock(() => true),
      broadcast: mock(() => {}),
      completeOperation: mock(() => {}),
      persistCoordinatedUpdateResponse: mock(async () => {}),
      deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
      dispatchPendingUpdateReceived: mock(() => {}),
      createCoordinatedUpdateResponder: mock(() => () => {}),
      findPendingUpdateByName: mock(async () => undefined),
    } as any;

    await expect(
      update(internals, 'workflow-1', 'rename', { value: 'patched' }, undefined, callbacks),
    ).rejects.toThrow('coordinated boom');
  });

  it('delivers a pending update found after waiter registration', async () => {
    const deleteRequest = mock(async () => {});
    const internals = {
      updateCoordinator: { deleteRequest },
      updateWaiters: new Map(),
      updateWaitersByWorkflow: new Map<string, Set<string>>(),
    } as any;
    const updateRequest = createUpdateRequest();
    const responder = () => {};
    const completeOperation = mock(() => {});
    const dispatchPendingUpdateReceived = mock(() => {});
    const createCoordinatedUpdateResponder = mock(() => responder);
    let lookupCount = 0;
    const findPendingUpdateByName = mock(async (): Promise<UpdateRequest | undefined> => {
      lookupCount++;
      return lookupCount === 1 ? undefined : updateRequest;
    });

    await processWaitUpdateOperation(
      internals,
      'workflow-1',
      { type: 'wait-update', operationId: 'op-1', updateName: 'rename', callerStack: 'stack' },
      {
        dispatchEvent: mock(() => true),
        broadcast: mock(() => {}),
        completeOperation,
        guardTerminalWorkflow: mock(async () => {}),
        guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
        persistCoordinatedUpdateResponse: mock(async () => {}),
        deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
        dispatchPendingUpdateReceived,
        createCoordinatedUpdateResponder,
        findPendingUpdateByName,
        schedulePendingInlineUpdateDrain: mock(() => {}),
      },
    );

    expect(deleteRequest).toHaveBeenCalledWith('workflow-1', 'update-1');
    expect(dispatchPendingUpdateReceived).toHaveBeenCalledWith(
      'workflow-1',
      'rename',
      updateRequest,
    );
    expect(createCoordinatedUpdateResponder).toHaveBeenCalledWith(
      'workflow-1',
      'rename',
      updateRequest,
    );
    expect(completeOperation).toHaveBeenCalledWith('workflow-1', {
      payload: updateRequest.payload,
      respond: responder,
    });
    expect(internals.updateWaiters.size).toBe(0);
  });

  it('returns false when a waiter exists for a different pending update', async () => {
    const waiter = mock(() => {});
    const waiterKey = 'workflow-1:rename';
    const internals = {
      updateCoordinator: { deleteRequest: mock(async () => {}) },
      updateWaiters: new Map([[waiterKey, waiter]]),
      updateWaitersByWorkflow: new Map<string, Set<string>>([['workflow-1', new Set([waiterKey])]]),
    } as any;

    const delivered = await deliverCoordinatedUpdateToWaiterIfAvailable(
      internals,
      'workflow-1',
      createUpdateRequest(),
      false,
      {
        dispatchEvent: mock(() => true),
        broadcast: mock(() => {}),
        completeOperation: mock(() => {}),
        guardTerminalWorkflow: mock(async () => {}),
        guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
        persistCoordinatedUpdateResponse: mock(async () => {}),
        deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
        dispatchPendingUpdateReceived: mock(() => {}),
        createCoordinatedUpdateResponder: mock(() => () => {}),
        findPendingUpdateByName: mock(async () =>
          createUpdateRequest({ updateId: 'other-update' }),
        ),
        schedulePendingInlineUpdateDrain: mock(() => {}),
      },
    );

    expect(delivered).toBe(false);
    expect(waiter).not.toHaveBeenCalled();
  });

  it('dispatches the pending-update received hook when waiter delivery requests it', async () => {
    const waiter = mock(() => {});
    const deleteRequest = mock(async () => {});
    const dispatchPendingUpdateReceived = mock(() => {});
    const createCoordinatedUpdateResponder = mock(() => () => {});
    const waiterKey = 'workflow-1:rename';
    const updateRequest = createUpdateRequest();
    const internals = {
      updateCoordinator: { deleteRequest },
      updateWaiters: new Map([[waiterKey, waiter]]),
      updateWaitersByWorkflow: new Map<string, Set<string>>([['workflow-1', new Set([waiterKey])]]),
    } as any;

    const delivered = await deliverCoordinatedUpdateToWaiterIfAvailable(
      internals,
      'workflow-1',
      updateRequest,
      true,
      {
        dispatchEvent: mock(() => true),
        broadcast: mock(() => {}),
        completeOperation: mock(() => {}),
        guardTerminalWorkflow: mock(async () => {}),
        guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
        persistCoordinatedUpdateResponse: mock(async () => {}),
        deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
        dispatchPendingUpdateReceived,
        createCoordinatedUpdateResponder,
        findPendingUpdateByName: mock(async () => updateRequest),
        schedulePendingInlineUpdateDrain: mock(() => {}),
      },
    );

    expect(delivered).toBe(true);
    expect(deleteRequest).toHaveBeenCalledWith('workflow-1', 'update-1');
    expect(dispatchPendingUpdateReceived).toHaveBeenCalledWith(
      'workflow-1',
      'rename',
      updateRequest,
    );
    expect(waiter).toHaveBeenCalledWith({
      payload: updateRequest.payload,
      respond: expect.any(Function),
    });
  });

  it('formats Standard Schema issue paths as RFC 6901 pointers', () => {
    expect(
      extractStandardSchemaIssues({
        issues: [
          {
            message: 'bad field',
            path: ['items', 0, { key: 'name/with~chars' }],
          },
        ],
      }),
    ).toEqual([{ message: 'bad field', path: '/items/0/name~1with~0chars' }]);
  });
});

/** Minimal stand-in for `WorkflowClaimRegistry` — only `currentEpoch` is read here. */
function fakeClaimRegistry(epoch: number | null): { currentEpoch: (id: string) => number | null } {
  return { currentEpoch: () => epoch };
}

const noopUpdateCallbacks = {
  dispatchEvent: mock(() => true),
  broadcast: mock(() => {}),
} as any;

describe('tryInlineUpdateHandler ownership distinguishability', () => {
  it('returns handled: true when a live context has the handler', async () => {
    const handler = mock(async (payload: unknown) => `handled:${String(payload)}`);
    const internals = {
      inlineStrategy: { getContext: () => ({ updateHandlers: new Map([['rename', handler]]) }) },
      conditionWaiters: new Map(),
      // EngineInternals types this as `WorkflowClaimRegistry | null`, never
      // undefined; omitting it made the ownership guard read undefined and throw.
      workflowClaimRegistry: null,
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      'workflow-1',
      'rename',
      'payload',
      noopUpdateCallbacks,
    );

    expect(result).toEqual({ handled: true, value: 'handled:payload' });
  });

  it('returns reason: "no-handler" when a live context exists but has no matching handler', async () => {
    const internals = {
      inlineStrategy: { getContext: () => ({ updateHandlers: new Map() }) },
      workflowClaimRegistry: null,
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      'workflow-1',
      'rename',
      'payload',
      noopUpdateCallbacks,
    );

    expect(result).toEqual({ handled: false, reason: 'no-handler' });
  });

  it('returns reason: "no-handler" when no context exists and no other engine claims the workflow', async () => {
    const internals = {
      inlineStrategy: { getContext: () => undefined },
      workflowClaimRegistry: null,
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      'workflow-1',
      'rename',
      'payload',
      noopUpdateCallbacks,
    );

    expect(result).toEqual({ handled: false, reason: 'no-handler' });
  });

  it('returns reason: "not-owned-locally" when a durable claim names a different engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('workflow-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 1,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
    ]);
    const internals = {
      inlineStrategy: { getContext: () => undefined },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as any;

    const result = await tryInlineUpdateHandler(
      internals,
      'workflow-1',
      'rename',
      'payload',
      noopUpdateCallbacks,
    );

    expect(result).toEqual({ handled: false, reason: 'not-owned-locally' });
  });

  it('update() still resolves through the coordinated path when not owned locally', async () => {
    // Documents the deliberate behavior-preservation decision: unlike
    // `query()`, `update()`'s coordinated path is already durable and
    // cross-engine correct, so a "not-owned-locally" inline result still
    // falls through instead of throwing or forwarding.
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('workflow-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 1,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
    ]);
    const internals = {
      inlineStrategy: { getContext: () => undefined },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
      updateWaiters: new Map(),
      updateWaitersByWorkflow: new Map(),
      updateCoordinator: {
        createRequest: mock(async () => 'update-1'),
        waitForResponse: mock(async () => ({ updateId: 'update-1', result: 'coordinated-result' })),
      },
    } as any;

    const result = await update(internals, 'workflow-1', 'rename', 'payload', undefined, {
      guardTerminalWorkflow: mock(async () => {}),
      guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
      schedulePendingInlineUpdateDrain: mock(() => {}),
      dispatchEvent: mock(() => true),
      broadcast: mock(() => {}),
      completeOperation: mock(() => {}),
      persistCoordinatedUpdateResponse: mock(async () => {}),
      deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
      dispatchPendingUpdateReceived: mock(() => {}),
      createCoordinatedUpdateResponder: mock(() => () => {}),
      findPendingUpdateByName: mock(async () => undefined),
    });

    expect(result).toBe('coordinated-result');
  });
});
