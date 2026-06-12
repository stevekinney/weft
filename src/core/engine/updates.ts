import type { ContextOperationRequest } from '../context.ts';
import { UpdateCompletedEvent, UpdateReceivedEvent } from '../events.ts';
import { isGeneratorResult } from '../step-context.ts';
import type { CoordinatedUpdateResult } from '../types.ts';
import { UpdateValidationError, type UpdateRequest, type UpdateResponse } from '../updates.ts';
import { notifyConditionWaiters } from './condition-waiters.ts';
import type { EngineInternals } from './internals.ts';
import { trackWaiterKey, untrackWaiterKey } from './signals.ts';
import { waitForUpdateResponse } from './waiting-update-response.ts';

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

async function tryInlineUpdateHandler(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  callbacks: UpdateCallbacks,
): Promise<UpdateAttemptResult> {
  const handler = internals.inlineStrategy?.getContext(workflowId)?.updateHandlers.get(name);
  if (!handler) return { handled: false };

  const updateId = crypto.randomUUID();
  callbacks.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));
  try {
    const result = await invokeUpdateHandler(internals, name, handler, payload);
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

/**
 * Invoke an update handler, checking that it does not return a generator.
 * Centralises the runtime generator guard for both the inline-handler path
 * in `update()` and the pending-drain path on resume.
 */
export async function invokeUpdateHandler(
  _internals: EngineInternals,
  name: string,
  handler: (payload: unknown) => unknown,
  payload: unknown,
): Promise<unknown> {
  const result = handler(payload);
  if (isGeneratorResult(result)) {
    throw new TypeError(
      `Update handler "${name}" returned a generator. ` +
        'Update handlers must return a plain value or a Promise, not a generator.',
    );
  }
  return await result;
}

/**
 * Run the pre-acceptance validator for an update, if one is registered.
 * Throws `UpdateValidationError` if the validator rejects (by throwing or by
 * returning a Standard Schema `{ issues: [...] }` failure result).
 */
async function runUpdateValidator(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
): Promise<void> {
  const validator = internals.inlineStrategy?.getContext(workflowId)?.updateValidators.get(name);
  if (validator === undefined) return;

  let result: unknown;
  try {
    result = await validator(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UpdateValidationError(name, [{ message }]);
  }

  const issues = extractStandardSchemaIssues(result);
  if (issues !== null && issues.length > 0) {
    throw new UpdateValidationError(name, issues);
  }
}

/**
 * Extract issues from a Standard Schema v1 failure result, or null if absent.
 * No string-`message` entries yields `[]`; callers reject only on a non-empty
 * array, so `null` and `[]` both mean acceptance. Preserves `path` (RFC 6901).
 */
export function extractStandardSchemaIssues(
  result: unknown,
): Array<{ message: string; path?: string }> | null {
  if (result === null || typeof result !== 'object' || !('issues' in result)) return null;
  const { issues } = result as { issues: unknown };
  if (!Array.isArray(issues)) return null;
  return issues.flatMap((issue: unknown) => {
    if (issue === null || typeof issue !== 'object') return [];
    const obj = issue as Record<string, unknown>;
    if (typeof obj['message'] !== 'string') return [];
    const entry: { message: string; path?: string } = { message: obj['message'] };
    if (Array.isArray(obj['path']) && obj['path'].length > 0) {
      entry.path = (obj['path'] as unknown[]).reduce((p: string, seg: unknown) => {
        const k =
          seg !== null && typeof seg === 'object' && 'key' in (seg as Record<string, unknown>)
            ? String((seg as { key: unknown }).key)
            : String(seg);
        return p + '/' + k.replace(/~/g, '~0').replace(/\//g, '~1');
      }, '');
    }
    return [entry];
  });
}
