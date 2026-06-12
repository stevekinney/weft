import { UpdateCompletedEvent, UpdateReceivedEvent } from '../events.ts';
import type { UpdateRequest } from '../updates.ts';
import { UpdateValidationError } from '../updates.ts';
import { notifyConditionWaiters } from './condition-waiters.ts';
import type { EngineInternals } from './internals.ts';
import {
  extractStandardSchemaIssues,
  invokeUpdateHandler as invokeUpdateHandlerFromInternals,
} from './updates.ts';

type PendingUpdateCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'update:completed'; workflowId: string; updateId: string }) => void;
};

async function waitForNextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForRegisteredUpdateHandlers(
  internals: EngineInternals,
  workflowId: string,
): Promise<boolean> {
  const inlineStrategy = internals.inlineStrategy;
  if (inlineStrategy === null) return false;

  let context = inlineStrategy.getContext(workflowId);
  if (context && context.updateHandlers.size > 0) return true;

  const pendingAdvance = inlineStrategy.waitForWorkflowAdvance(workflowId);
  if (pendingAdvance) {
    await pendingAdvance;
    context = inlineStrategy.getContext(workflowId);
    if (context && context.updateHandlers.size > 0) return true;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    await waitForNextMacrotask();
    context = inlineStrategy.getContext(workflowId);
    if (context && context.updateHandlers.size > 0) return true;
  }

  return false;
}

export async function invokeUpdateHandler(
  internals: EngineInternals,
  name: string,
  handler: (payload: unknown) => unknown,
  payload: unknown,
): Promise<unknown> {
  return invokeUpdateHandlerFromInternals(internals, name, handler, payload);
}

/**
 * After an inline workflow advances, wait for its current generator turn to
 * expose update handlers before draining pending coordinated updates.
 */
export async function processPendingUpdatesAfterInlineAdvance(
  internals: EngineInternals,
  workflowId: string,
  callbacks: PendingUpdateCallbacks,
): Promise<void> {
  const pendingUpdates = await internals.updateCoordinator.getPendingUpdates(workflowId);
  if (pendingUpdates.length === 0) return;

  const hasHandlers = await waitForRegisteredUpdateHandlers(internals, workflowId);
  if (!hasHandlers) return;

  await processPendingUpdatesForHandlers(internals, workflowId, callbacks);
}

export function schedulePendingInlineUpdateDrain(
  internals: EngineInternals,
  workflowId: string,
  callbacks: PendingUpdateCallbacks,
): void {
  if (internals.inlineStrategy === null) {
    return;
  }

  setTimeout(() => {
    void processPendingUpdatesForHandlers(internals, workflowId, callbacks).catch(() => {});
  }, 0);
}

/**
 * Run the registered pre-acceptance validator for a pending update, if any.
 * Returns the rejection error message when the validator rejects, or null when
 * the payload is accepted (or no validator is registered).
 *
 * Updates that arrived before `ctx.onUpdate` was called were accepted without
 * validation at write time; this ensures rejected payloads never reach the
 * handler even when they arrived early.
 */
async function runPendingUpdateValidator(
  validator: (payload: unknown) => unknown,
  updateName: string,
  payload: unknown,
): Promise<string | null> {
  let result: unknown;
  try {
    result = await validator(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new UpdateValidationError(updateName, [{ message }]).message;
  }

  // Reuse the inline path's extraction so both paths accept/reject identically:
  // filter for valid issues first, then reject only when at least one remains.
  // (A raw `issues` array with no string `message` entries is not a rejection.)
  const issues = extractStandardSchemaIssues(result);
  if (issues !== null && issues.length > 0) {
    return new UpdateValidationError(updateName, issues).message;
  }

  return null;
}

/**
 * Drain a workflow's buffered coordinated updates and deliver each to its
 * handler exactly once, even when several drains race.
 *
 * Several triggers can fire near-simultaneously: each `engine.update()` schedules
 * a `setTimeout(0)` drain, and the post-advance path drains too. Their consume-
 * deletes are durable (`storage.batch`) and lag the in-memory `getPendingUpdates`
 * scan, so two overlapping drains both see the same pending set. Each update id
 * is therefore CLAIMED synchronously in `deliveredPendingUpdateIds` before
 * delivery (no `await` between the membership check and the add, so a concurrent
 * drain cannot interleave): a racing drain that re-reads the same id skips it.
 *
 * After the drain, re-drive a parked `ctx.waitUntil` once. A coordinated update
 * buffered before `ctx.onUpdate` was registered drains here (not on the inline
 * `tryInlineUpdateHandler` path), and a handler may have mutated the workflow-
 * local state a predicate reads, so the wait must be poked to re-evaluate.
 */
export async function processPendingUpdatesForHandlers(
  internals: EngineInternals,
  workflowId: string,
  callbacks: PendingUpdateCallbacks,
): Promise<void> {
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!context) return;

  const handlers = context.updateHandlers;
  if (handlers.size === 0) return;

  const pendingUpdates = await internals.updateCoordinator.getPendingUpdates(workflowId);
  if (pendingUpdates.length === 0) return;

  // Whether any handler ran (mutating state a predicate may read). Tracked in
  // `finally` so the re-drive still fires if a LATER update's durable write
  // throws after an earlier handler already ran — otherwise a parked
  // `ctx.waitUntil` could miss a state change. `deliverPendingUpdate` catches
  // handler throws internally, so only a `storage.batch` failure escapes here.
  let handlerRan = false;
  try {
    for (const update of pendingUpdates) {
      const handler = handlers.get(update.name);
      if (!handler) continue;

      // Claim the id synchronously before any `await`, so a racing drain that
      // scanned the same id (before this drain's durable delete commits) skips it.
      if (!claimPendingUpdateForDelivery(internals, workflowId, update.updateId)) continue;

      const validatorRejectionError = await runValidatorIfPresent(context, update);
      if (validatorRejectionError !== null) {
        await rejectPendingUpdate(
          internals,
          workflowId,
          update,
          validatorRejectionError,
          callbacks,
        );
        continue;
      }

      handlerRan = true;
      await deliverPendingUpdate(internals, workflowId, update, handler, callbacks);
    }
  } finally {
    if (handlerRan) {
      notifyConditionWaiters(internals, workflowId);
    }
  }
}

/**
 * Atomically claim a coordinated update id for delivery. Returns `true` if this
 * caller won the claim (first to see it), `false` if another drain already
 * claimed it. The check-and-add is synchronous, so concurrent drains cannot both
 * win the same id.
 */
function claimPendingUpdateForDelivery(
  internals: EngineInternals,
  workflowId: string,
  updateId: string,
): boolean {
  let claimed = internals.deliveredPendingUpdateIds.get(workflowId);
  if (claimed === undefined) {
    claimed = new Set();
    internals.deliveredPendingUpdateIds.set(workflowId, claimed);
  }
  if (claimed.has(updateId)) return false;
  claimed.add(updateId);
  return true;
}

async function runValidatorIfPresent(
  context: NonNullable<ReturnType<NonNullable<EngineInternals['inlineStrategy']>['getContext']>>,
  update: UpdateRequest,
): Promise<string | null> {
  const validator = context.updateValidators?.get(update.name);
  if (validator === undefined) return null;
  return runPendingUpdateValidator(validator, update.name, update.payload);
}

async function rejectPendingUpdate(
  internals: EngineInternals,
  workflowId: string,
  update: UpdateRequest,
  errorMessage: string,
  callbacks: PendingUpdateCallbacks,
): Promise<void> {
  const responseOperations = internals.updateCoordinator.buildResponseOperations(
    update.updateId,
    workflowId,
    undefined,
    errorMessage,
    update.idempotencyKey,
  );
  await internals.storage.batch(responseOperations);
  callbacks.broadcast({ type: 'update:completed', workflowId, updateId: update.updateId });
}

async function deliverPendingUpdate(
  internals: EngineInternals,
  workflowId: string,
  update: UpdateRequest,
  handler: (payload: unknown) => unknown,
  callbacks: PendingUpdateCallbacks,
): Promise<void> {
  callbacks.dispatchEvent(
    new UpdateReceivedEvent(update.updateId, workflowId, update.name, update.payload),
  );

  let result: unknown;
  let error: string | undefined;
  try {
    result = await invokeUpdateHandler(internals, update.name, handler, update.payload);
  } catch (handlerError) {
    error = handlerError instanceof Error ? handlerError.message : String(handlerError);
  }

  const responseOperations = internals.updateCoordinator.buildResponseOperations(
    update.updateId,
    workflowId,
    result,
    error,
    update.idempotencyKey,
  );
  await internals.storage.batch(responseOperations);

  callbacks.dispatchEvent(
    new UpdateCompletedEvent(update.updateId, workflowId, update.name, result, error),
  );
  callbacks.broadcast({ type: 'update:completed', workflowId, updateId: update.updateId });
}
