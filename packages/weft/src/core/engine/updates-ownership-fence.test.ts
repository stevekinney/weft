/**
 * ADR 0002 fencing for the two paths that resolve an in-memory
 * `ctx.waitForUpdate()` waiter. Losing a renewal drops this engine's registry
 * entry but leaves `internals.updateWaiters` populated, so a deposed engine
 * still holds a live waiter. Resolving it would advance the deposed generator
 * while the successor independently advances its replayed one.
 *
 * Both routes reach the same waiter, so both are covered here: `update()`'s
 * `'not-owned-locally'` short-circuit past `tryWaitingUpdateHandler`, and the
 * `confirmWakeOwnership` fence inside
 * `deliverCoordinatedUpdateToWaiterIfAvailable`, which the coordinated path
 * itself calls.
 */
import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { UpdateRequest } from '../updates.ts';
import { deliverCoordinatedUpdateToWaiterIfAvailable, update } from './updates.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

const WAITER_KEY = 'workflow-1:rename';

function createUpdateRequest(): UpdateRequest {
  return {
    updateId: 'update-1',
    workflowId: 'workflow-1',
    name: 'rename',
    payload: { value: 'patched' },
    createdAt: 123,
  };
}

function createDeliveryHarness(registry: unknown) {
  const waiter = mock(() => {});
  const deleteRequest = mock(async () => {});
  const internals = {
    storage: new MemoryStorage(),
    workflowClaimRegistry: registry,
    updateCoordinator: { deleteRequest },
    updateWaiters: new Map<string, (payload: unknown) => void>([[WAITER_KEY, waiter]]),
    updateWaitersByWorkflow: new Map<string, Set<string>>([['workflow-1', new Set([WAITER_KEY])]]),
  } as any;
  const callbacks = {
    findPendingUpdateByName: mock(async () => createUpdateRequest()),
    dispatchPendingUpdateReceived: mock(() => {}),
    createCoordinatedUpdateResponder: mock(() => () => {}),
    completeOperation: mock(() => {}),
    persistCoordinatedUpdateResponse: mock(async () => {}),
    dispatchEvent: mock(() => true),
    broadcast: mock(() => {}),
  } as any;
  return { internals, callbacks, waiter, deleteRequest };
}

describe('coordinated update delivery is fenced on the claim generation', () => {
  it('discards delivery when this engine no longer tracks a claim', async () => {
    // `currentEpoch` returning null is exactly the post-deposition state: a lost
    // renewal removed the entry while the in-memory waiter survived.
    const { internals, callbacks, waiter, deleteRequest } = createDeliveryHarness({
      engineId: 'deposed-engine',
      currentEpoch: () => null,
    });

    const delivered = await deliverCoordinatedUpdateToWaiterIfAvailable(
      internals,
      'workflow-1',
      createUpdateRequest(),
      false,
      callbacks,
    );

    expect(delivered).toBe(false);
    // The stale waiter must survive untouched — resolving it is what advances
    // the deposed generator.
    expect(waiter).not.toHaveBeenCalled();
    expect(internals.updateWaiters.get(WAITER_KEY)).toBe(waiter);
    // The durable record must remain so the engine holding the claim delivers it.
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it('delivers normally when no claim registry is installed', async () => {
    // `ownership: 'none'`/`'lease'` must stay byte-identical to pre-ADR-0002.
    const { internals, callbacks, waiter, deleteRequest } = createDeliveryHarness(null);

    const delivered = await deliverCoordinatedUpdateToWaiterIfAvailable(
      internals,
      'workflow-1',
      createUpdateRequest(),
      false,
      callbacks,
    );

    expect(delivered).toBe(true);
    expect(waiter).toHaveBeenCalled();
    expect(internals.updateWaiters.has(WAITER_KEY)).toBe(false);
    expect(deleteRequest).toHaveBeenCalled();
  });
});

describe('update() bypasses the in-memory waiter when the workflow is owned elsewhere', () => {
  it('routes straight to the coordinated path without consuming the stale waiter', async () => {
    const storage = new MemoryStorage();
    // A holder record owned by another engine, with no local epoch tracked, is
    // what makes `isWorkflowClaimedByAnotherEngine` report `'not-owned-locally'`.
    await storage.put(
      KEYS.workflowOwnerHolder('workflow-1'),
      encodeWorkflowClaimHolder({
        engineId: 'successor-engine',
        epoch: 2,
        expiresAt: Date.now() + 60_000,
        claimedAt: Date.now(),
      }),
    );

    const waiter = mock(() => {});
    const internals = {
      storage,
      inlineStrategy: null,
      workflowClaimRegistry: { engineId: 'deposed-engine', currentEpoch: () => null },
      updateWaiters: new Map<string, (payload: unknown) => void>([[WAITER_KEY, waiter]]),
      updateWaitersByWorkflow: new Map<string, Set<string>>([
        ['workflow-1', new Set([WAITER_KEY])],
      ]),
      updateCoordinator: {
        createRequest: mock(async () => 'update-1'),
        waitForResponse: mock(async () => ({ updateId: 'update-1', result: 'coordinated' })),
      },
    } as any;

    const deliverToWaiter = mock(async () => false);
    const callbacks = {
      guardTerminalWorkflow: mock(async () => {}),
      guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
      schedulePendingInlineUpdateDrain: mock(() => {}),
      dispatchEvent: mock(() => true),
      broadcast: mock(() => {}),
      completeOperation: mock(() => {}),
      persistCoordinatedUpdateResponse: mock(async () => {}),
      deliverCoordinatedUpdateToWaiterIfAvailable: deliverToWaiter,
      findPendingUpdateByName: mock(async () => undefined),
    } as any;

    // A short timeout only matters when the fix is absent: the unfenced
    // `tryWaitingUpdateHandler` consumes the waiter and then awaits a response
    // that never arrives, so this keeps the regression a fast assertion failure
    // rather than a five-second suite-slowing timeout.
    const result = await update(
      internals,
      'workflow-1',
      'rename',
      { value: 1 },
      { timeout: 50 },
      callbacks,
    );

    expect(result).toBe('coordinated');
    // `tryWaitingUpdateHandler` deletes the waiter as its first act; an intact
    // map proves the short-circuit ran instead.
    expect(internals.updateWaiters.get(WAITER_KEY)).toBe(waiter);
    expect(waiter).not.toHaveBeenCalled();
    expect(deliverToWaiter).toHaveBeenCalled();
  });
});
