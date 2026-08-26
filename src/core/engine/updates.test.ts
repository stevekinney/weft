import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { UpdateRequest } from '../updates.ts';
import { extractStandardSchemaIssues } from './update-validation.ts';
import {
  deliverCoordinatedUpdateToWaiterIfAvailable,
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
      // `EngineInternals.workflowClaimRegistry` is `WorkflowClaimRegistry | null`
      // and is always initialized to `null` in production. Omitting it left it
      // `undefined`, which the ADR 0002 wake fence's `=== null` check correctly
      // does not treat as "no registry".
      workflowClaimRegistry: null,
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

  it('invokes the handler without any ownership read when no claim registry is installed', async () => {
    const handler = mock(async (payload: unknown) => `handled:${String(payload)}`);
    const internals = {
      inlineStrategy: { getContext: () => ({ updateHandlers: new Map([['rename', handler]]) }) },
      conditionWaiters: new Map(),
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
    expect(handler).toHaveBeenCalledWith('payload');
  });

  it('returns reason: "not-owned-locally" instead of invoking a stale live handler when a durable claim names another engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('workflow-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 2,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
    ]);
    const handler = mock(async (payload: unknown) => `handled:${String(payload)}`);
    const internals = {
      // A deposed engine keeps its live Context — and its registered
      // handlers — until some later fenced write unwinds the execution.
      inlineStrategy: { getContext: () => ({ updateHandlers: new Map([['rename', handler]]) }) },
      // This engine's local tracking already lost the claim (e.g. a `renew`
      // self-deposition already cleared it), so the check must fall through
      // to the durable read rather than trusting a stale local epoch.
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
    expect(handler).not.toHaveBeenCalled();
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

describe('tryWaitingUpdateHandler ownership recheck (WFT-79)', () => {
  it('falls through to the coordinated path instead of consuming the waiter when this engine no longer holds the claim generation', async () => {
    const waiterKey = 'workflow-1:rename';
    const updateWaiter = mock(() => {});
    const updateWaiters = new Map([[waiterKey, updateWaiter]]);
    const updateWaitersByWorkflow = new Map<string, Set<string>>();

    const internals = {
      // No handler registered for "rename" — tryInlineUpdateHandler falls
      // through to 'no-handler' (not 'not-owned-locally') so update()
      // proceeds into tryWaitingUpdateHandler.
      inlineStrategy: {
        getContext: () => ({ updateHandlers: new Map(), updateValidators: new Map() }),
      },
      // No durable holder record read is needed for tryInlineUpdateHandler's
      // own claimed-by-another-engine check to answer "not claimed" — a
      // null registry there is equivalent, since `isLiveContextStale` and
      // `isWorkflowClaimedByAnotherEngine` both short-circuit before ever
      // reading it.
      storage: { get: mock(async () => null) },
      updateWaiters,
      updateWaitersByWorkflow,
      // `currentEpoch(...) === null` makes `confirmWakeOwnership` discard
      // immediately (this engine tracks no epoch for the workflow at all —
      // e.g. a renewal loss dropped the local claim entry between the
      // waiter's registration and this call), without needing a durable
      // holder read.
      workflowClaimRegistry: { currentEpoch: () => null, engineId: 'engine-a' },
      updateCoordinator: {
        createRequest: mock(async () => 'coordinated-update-1'),
        waitForResponse: mock(async () => ({
          updateId: 'coordinated-update-1',
          result: 'coordinated-result',
        })),
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
    // The discarded waiter was never consumed: still registered, never
    // invoked. A deposed generator must not be advanced by it.
    expect(updateWaiters.get(waiterKey)).toBe(updateWaiter);
    expect(updateWaiter).not.toHaveBeenCalled();
  });
});
