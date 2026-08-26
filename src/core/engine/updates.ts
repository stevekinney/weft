import type { ContextOperationRequest } from '../context.ts';
import { UpdateCompletedEvent, UpdateReceivedEvent } from '../events.ts';
import type { CoordinatedUpdateResult } from '../types.ts';
import type { UpdateRequest, UpdateResponse } from '../updates.ts';
import { notifyConditionWaiters } from './condition-waiters.ts';
import type { EngineInternals } from './internals.ts';
import { invokeUpdateHandler, type InlineUpdateHandler } from './invoke-update-handler.ts';
import { isLiveContextStale, isWorkflowClaimedByAnotherEngine } from './queries.ts';
import { trackWaiterKey, untrackWaiterKey } from './signals.ts';
import { runUpdateValidator } from './update-validation.ts';
import { waitForUpdateResponse } from './waiting-update-response.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

export type UpdateCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'update:completed'; workflowId: string; updateId: string }) => void;
  completeOperation: (workflowId: string, value: unknown) => void;
  guardTerminalWorkflow: (workflowId: string) => Promise<void>;
  guardTerminalWorkflowAfterCoordinatedRequest: (
    workflowId: string,
    updateId: string,
  ) => Promise<void>;
  persistCoordinatedUpdateResponse: (
    workflowId: string,
    updateName: string,
    updateId: string,
    idempotencyKey: string | undefined,
    value: unknown,
  ) => Promise<void>;
  deliverCoordinatedUpdateToWaiterIfAvailable: (
    workflowId: string,
    updateRequest: UpdateRequest,
    dispatchReceivedEvent?: boolean,
  ) => Promise<boolean>;
  dispatchPendingUpdateReceived: (
    workflowId: string,
    updateName: string,
    updateRequest: UpdateRequest,
  ) => void;
  createCoordinatedUpdateResponder: (
    workflowId: string,
    updateName: string,
    updateRequest: UpdateRequest,
  ) => (value: unknown) => void;
  findPendingUpdateByName: (workflowId: string, name: string) => Promise<UpdateRequest | undefined>;
  schedulePendingInlineUpdateDrain: (workflowId: string) => void;
};

export async function update(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  options: { timeout?: number } | undefined,
  callbacks: UpdateCallbacks,
): Promise<unknown> {
  const timeout = options?.timeout ?? 30_000;

  // Run pre-acceptance validator before any durable action.
  await runUpdateValidator(internals, workflowId, name, payload);

  // Reject updates to workflows in terminal states
  await callbacks.guardTerminalWorkflow(workflowId);

  const inlineResult = await tryInlineUpdateHandler(
    internals,
    workflowId,
    name,
    payload,
    callbacks,
  );
  if (inlineResult.handled) {
    return inlineResult.value;
  }
  // `'not-owned-locally'` must skip the in-memory waiter path entirely. Losing a
  // renewal drops this engine's claim entry from the registry but leaves
  // `internals.updateWaiters` populated, so a deposed engine still holds a live
  // `ctx.waitForUpdate()` waiter. Resolving that waiter here would advance the
  // deposed generator while the successor independently advances its replayed
  // one — the duplicate execution ADR 0002 exists to prevent — and it would do
  // so before the old generator's next fenced write could catch it. Route
  // straight to the durable coordinated path, which is already cross-engine
  // correct.
  //
  // `'no-handler'` is the genuinely different case: this engine owns the
  // workflow and simply has no handler registered for `name`, so the waiter
  // path below still applies. Both reasons are unreachable without a claim
  // registry (`isWorkflowClaimedByAnotherEngine` and `isLiveContextStale` both
  // short-circuit on a null registry), so `ownership: 'none'`/`'lease'` reach
  // `tryWaitingUpdateHandler` exactly as they do today.
  if (inlineResult.reason === 'not-owned-locally') {
    return await runCoordinatedUpdate(internals, workflowId, name, payload, timeout, callbacks);
  }

  const waitingResult = await tryWaitingUpdateHandler(
    internals,
    workflowId,
    name,
    payload,
    timeout,
    callbacks,
  );
  if (waitingResult.handled) {
    return waitingResult.value;
  }

  return await runCoordinatedUpdate(internals, workflowId, name, payload, timeout, callbacks);
}

type UpdateAttemptResult = { handled: true; value: unknown } | { handled: false };

/**
 * Re-read the update handler after the durable ownership check awaited: a
 * same-owner signal resume can install a fresh context — different closure, or
 * none — while that read is in flight, and the captured closure would then run
 * against retired workflow-local state. Ownership never changes in this race,
 * so only re-reading catches it (as in `queries.ts`). A plain `false` `stale`
 * means no await happened, so the captured handler stands and
 * `ownership: 'none'`/`'lease'` pay nothing.
 */
function refreshUpdateHandlerAfterAwait(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  capturedHandler: InlineUpdateHandler,
  stale: boolean | Promise<boolean>,
): InlineUpdateHandler | undefined {
  if (stale === false) return capturedHandler;
  return internals.inlineStrategy?.getContext(workflowId)?.updateHandlers.get(name);
}

/**
 * `handled: false` used to conflate two reasons: no live local context at all
 * (`'not-owned-locally'`, possible under `ownership: 'workflow-lease'` when
 * another engine holds the claim) versus a live context with no handler
 * registered for `name` (`'no-handler'`). See the `update()` call site for
 * why neither is routed differently — the reason is exposed so a caller that
 * DOES care (tests, future routing) can tell them apart.
 */
export type InlineUpdateAttemptResult =
  | { handled: true; value: unknown }
  | { handled: false; reason: 'not-owned-locally' | 'no-handler' };

export async function tryInlineUpdateHandler(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  callbacks: UpdateCallbacks,
): Promise<InlineUpdateAttemptResult> {
  const handler = internals.inlineStrategy?.getContext(workflowId)?.updateHandlers.get(name);
  if (!handler) {
    const claimed = await isWorkflowClaimedByAnotherEngine(internals, workflowId);
    return { handled: false, reason: claimed ? 'not-owned-locally' : 'no-handler' };
  }
  // A live handler is not proof of ownership; see `isLiveContextStale`.
  const stale = isLiveContextStale(internals, workflowId);
  if (stale !== false && (await stale)) {
    return { handled: false, reason: 'not-owned-locally' };
  }

  const liveHandler = refreshUpdateHandlerAfterAwait(internals, workflowId, name, handler, stale);
  if (!liveHandler) {
    // The context went away mid-read (terminal cleanup or suspend). Fall
    // through to the durable coordinated path rather than throwing.
    return { handled: false, reason: 'no-handler' };
  }

  const updateId = crypto.randomUUID();
  callbacks.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));
  try {
    const result = await invokeUpdateHandler(internals, name, liveHandler, payload);
    callbacks.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
    callbacks.broadcast({ type: 'update:completed', workflowId, updateId });
    // Re-drive live `ctx.waitUntil` waiters: the handler may have mutated
    // workflow-local state a condition predicate reads (and on the catch path
    // below, a handler that threw may have mutated state before throwing).
    notifyConditionWaiters(internals, workflowId);
    return { handled: true, value: result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    callbacks.dispatchEvent(
      new UpdateCompletedEvent(updateId, workflowId, name, undefined, errorMessage),
    );
    callbacks.broadcast({ type: 'update:completed', workflowId, updateId });
    notifyConditionWaiters(internals, workflowId);
    throw error;
  }
}

async function tryWaitingUpdateHandler(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  timeout: number,
  callbacks: UpdateCallbacks,
): Promise<UpdateAttemptResult> {
  const waiterKey = `${workflowId}:${name}`;
  const updateWaiter = internals.updateWaiters.get(waiterKey);
  if (!updateWaiter) return { handled: false };

  const existingPendingUpdate = await callbacks.findPendingUpdateByName(workflowId, name);
  if (internals.updateWaiters.get(waiterKey) !== updateWaiter || existingPendingUpdate) {
    return { handled: false };
  }

  // Resolving this in-memory waiter advances the workflow's generator, exactly
  // like `deliverCoordinatedUpdateToWaiterIfAvailable`'s own fence below. The
  // ownership check inside `tryInlineUpdateHandler()` (this update's earlier
  // call, per `update()`'s dispatch order) only reflects ownership observed
  // THEN; another engine can win a takeover during the
  // `findPendingUpdateByName` await just above, after which this waiter is
  // still registered (nothing durable removes it on takeover) and would
  // otherwise be consumed unfenced, advancing a deposed generator. Recheck
  // immediately before consuming it, and fall through to the coordinated path
  // on discard — same as that function's own `'discard'` branch.
  if ((await confirmWakeOwnership(internals, workflowId, 'update')) === 'discard') {
    return { handled: false };
  }

  internals.updateWaiters.delete(waiterKey);
  untrackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);
  const updateId = crypto.randomUUID();
  callbacks.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));
  const result = await waitForUpdateResponse(updateId, payload, timeout, updateWaiter);
  callbacks.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
  callbacks.broadcast({ type: 'update:completed', workflowId, updateId });
  return { handled: true, value: result };
}

async function runCoordinatedUpdate(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  timeout: number,
  callbacks: UpdateCallbacks,
): Promise<unknown> {
  const updateId = await internals.updateCoordinator.createRequest(workflowId, name, payload);
  callbacks.schedulePendingInlineUpdateDrain(workflowId);
  await callbacks.guardTerminalWorkflowAfterCoordinatedRequest(workflowId, updateId);
  callbacks.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));
  await callbacks.deliverCoordinatedUpdateToWaiterIfAvailable(workflowId, {
    updateId,
    workflowId,
    name,
    payload,
    createdAt: Date.now(),
  });

  const response = await internals.updateCoordinator.waitForResponse(updateId, timeout);
  if (response.error) {
    throw new Error(response.error);
  }
  return response.result;
}

/** Retrieve the result of a coordinated update by its ID. */
export async function getUpdateResult(
  internals: EngineInternals,
  updateId: string,
): Promise<UpdateResponse | null> {
  return internals.updateCoordinator.getResponse(updateId);
}

/**
 * Submit a coordinated update request. Handles idempotency checking,
 * creates the request, and waits for a response within the timeout.
 */
export async function submitCoordinatedUpdate(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  options: { timeout?: number; idempotencyKey?: string } | undefined,
  callbacks: UpdateCallbacks,
): Promise<CoordinatedUpdateResult> {
  const timeout = options?.timeout ?? 30_000;
  const idempotencyKey = options?.idempotencyKey;

  // Check idempotency first — a retry for an already-processed key should
  // return the cached result even if the workflow has since completed.
  if (idempotencyKey !== undefined) {
    const existing = await internals.updateCoordinator.checkIdempotency(workflowId, idempotencyKey);
    if (existing !== null) {
      return { updateId: existing.updateId, result: existing.result };
    }
  }

  // Run pre-acceptance validator before any durable action.
  await runUpdateValidator(internals, workflowId, name, payload);

  // Reject updates to workflows in terminal states
  await callbacks.guardTerminalWorkflow(workflowId);

  const requestOptions: { timeout: number; idempotencyKey?: string } = { timeout };
  if (idempotencyKey !== undefined) {
    requestOptions.idempotencyKey = idempotencyKey;
  }

  const updateId = await internals.updateCoordinator.createRequest(
    workflowId,
    name,
    payload,
    requestOptions,
  );
  callbacks.schedulePendingInlineUpdateDrain(workflowId);
  await callbacks.guardTerminalWorkflowAfterCoordinatedRequest(workflowId, updateId);

  await callbacks.deliverCoordinatedUpdateToWaiterIfAvailable(
    workflowId,
    {
      updateId,
      workflowId,
      name,
      payload,
      createdAt: Date.now(),
      idempotencyKey,
    },
    true,
  );

  const response = await internals.updateCoordinator.waitForResponse(updateId, timeout);

  const result: CoordinatedUpdateResult = {
    updateId: response.updateId,
    result: response.result,
  };

  if (response.error !== undefined) {
    result.error = response.error;
  }

  return result;
}

export async function processWaitUpdateOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'wait-update' }>,
  callbacks: UpdateCallbacks,
): Promise<void> {
  const waiterKey = `${workflowId}:${operation.updateName}`;
  const matchingUpdate = await callbacks.findPendingUpdateByName(workflowId, operation.updateName);

  if (matchingUpdate) {
    await internals.updateCoordinator.deleteRequest(workflowId, matchingUpdate.updateId);
    callbacks.dispatchPendingUpdateReceived(workflowId, operation.updateName, matchingUpdate);
    callbacks.completeOperation(workflowId, {
      payload: matchingUpdate.payload,
      respond: callbacks.createCoordinatedUpdateResponder(
        workflowId,
        operation.updateName,
        matchingUpdate,
      ),
    });
    return;
  }

  const { promise, resolve } = Promise.withResolvers<unknown>();
  internals.updateWaiters.set(waiterKey, resolve);
  trackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);

  const pendingUpdateAfterRegistration = await callbacks.findPendingUpdateByName(
    workflowId,
    operation.updateName,
  );
  if (pendingUpdateAfterRegistration) {
    if (internals.updateWaiters.get(waiterKey) === resolve) {
      internals.updateWaiters.delete(waiterKey);
      untrackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);
    }

    await internals.updateCoordinator.deleteRequest(
      workflowId,
      pendingUpdateAfterRegistration.updateId,
    );
    callbacks.dispatchPendingUpdateReceived(
      workflowId,
      operation.updateName,
      pendingUpdateAfterRegistration,
    );
    callbacks.completeOperation(workflowId, {
      payload: pendingUpdateAfterRegistration.payload,
      respond: callbacks.createCoordinatedUpdateResponder(
        workflowId,
        operation.updateName,
        pendingUpdateAfterRegistration,
      ),
    });
    return;
  }

  callbacks.completeOperation(workflowId, await promise);
}

export function dispatchPendingUpdateReceived(
  _internals: EngineInternals,
  workflowId: string,
  updateName: string,
  updateRequest: UpdateRequest,
  callbacks: Pick<UpdateCallbacks, 'dispatchEvent'>,
): void {
  callbacks.dispatchEvent(
    new UpdateReceivedEvent(updateRequest.updateId, workflowId, updateName, updateRequest.payload),
  );
}

export function createCoordinatedUpdateResponder(
  _internals: EngineInternals,
  workflowId: string,
  updateName: string,
  updateRequest: UpdateRequest,
  callbacks: Pick<UpdateCallbacks, 'persistCoordinatedUpdateResponse'>,
): (value: unknown) => void {
  let coordinatedResponded = false;

  return (value: unknown) => {
    if (coordinatedResponded) return;
    coordinatedResponded = true;

    void callbacks.persistCoordinatedUpdateResponse(
      workflowId,
      updateName,
      updateRequest.updateId,
      updateRequest.idempotencyKey,
      value,
    );
  };
}

export async function deliverCoordinatedUpdateToWaiterIfAvailable(
  internals: EngineInternals,
  workflowId: string,
  updateRequest: UpdateRequest,
  dispatchReceivedEvent = false,
  callbacks: UpdateCallbacks,
): Promise<boolean> {
  const waiterKey = `${workflowId}:${updateRequest.name}`;
  const waiter = internals.updateWaiters.get(waiterKey);
  if (!waiter) {
    return false;
  }

  const oldestPendingUpdate = await callbacks.findPendingUpdateByName(
    workflowId,
    updateRequest.name,
  );
  if (!oldestPendingUpdate || oldestPendingUpdate.updateId !== updateRequest.updateId) {
    return false;
  }

  // Resolving this in-memory waiter advances the workflow's generator, so it is
  // a claim-requiring wake path like sleep, wait-condition and async-activity.
  // A lost renewal drops this engine's registry entry but leaves
  // `internals.updateWaiters` populated, so without this fence a deposed engine
  // would resolve its stale `ctx.waitForUpdate()` waiter and advance the old
  // generator while the successor independently advances its replayed one.
  //
  // Returning `false` — rather than deleting the durable request — deliberately
  // leaves the coordinated record in place so the engine that actually holds
  // the claim delivers it. Inert under `ownership: 'none'`/`'lease'`, where no
  // claim registry is installed and `confirmWakeOwnership` always proceeds.
  if ((await confirmWakeOwnership(internals, workflowId, 'update')) === 'discard') {
    return false;
  }

  await internals.updateCoordinator.deleteRequest(workflowId, updateRequest.updateId);
  internals.updateWaiters.delete(waiterKey);
  untrackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);
  if (dispatchReceivedEvent) {
    callbacks.dispatchPendingUpdateReceived(workflowId, updateRequest.name, updateRequest);
  }

  waiter({
    payload: updateRequest.payload,
    respond: callbacks.createCoordinatedUpdateResponder(
      workflowId,
      updateRequest.name,
      updateRequest,
    ),
  });
  return true;
}

export async function findPendingUpdateByName(
  internals: EngineInternals,
  workflowId: string,
  name: string,
): Promise<UpdateRequest | undefined> {
  const pendingUpdates = await internals.updateCoordinator.getPendingUpdates(workflowId);
  return pendingUpdates.find((updateRequest) => updateRequest.name === name);
}
