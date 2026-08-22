/**
 * Out-of-band ("async") activity completion.
 *
 * An activity can hand its work off to an external system — a webhook, a human
 * callback, a third-party async job — by calling `ctx.completeAsync()` on its
 * {@link ActivityContext}. That call throws an {@link AsyncActivityDeferral}
 * sentinel which the engine catches: instead of completing or failing the
 * activity operation (which would resume the workflow), the engine records a
 * pending entry keyed by a durable, deterministic task token and leaves the
 * workflow suspended at that step.
 *
 * Some external system later resolves the activity by token through
 * `engine.completeAsyncActivity(token, result)` or
 * `engine.failAsyncActivity(token, error)`. Completion resumes the workflow
 * generator with the supplied value; failure throws the supplied error into the
 * generator (the same path an inline activity failure takes, so the workflow's
 * retry/catch handling applies unchanged).
 *
 * Durability: the pending entry is persisted under
 * {@link KEYS.asyncActivity}. The token is derived from the workflow id, the
 * deterministic workflow step index, and the activity attempt, so it is stable
 * across replay. After an engine restart, `recoverAll()` replays the workflow
 * from its checkpoint; the deferred activity re-runs, re-defers, and produces
 * the *same* token. A callback that arrives after the crash therefore still
 * resolves the correct activity. If that callback races `recoverAll()` and
 * arrives after token recovery but before replay has adopted the workflow
 * generator, the engine buffers the completion or failure outcome and drains it
 * when replay reaches the same deterministic token.
 *
 * Acknowledgement durability: `completeAsyncActivity` / `failAsyncActivity`
 * resolve only after ONE fenced batch has durably (a) deleted the single-use
 * token record and (b) written a resolution record
 * ({@link KEYS.asyncActivityResolution}) carrying the supplied outcome. A crash
 * any time after the acknowledgement therefore cannot lose the outcome:
 * recovery reloads the resolution record, queues it, and redelivers it when
 * replay re-parks on the same deterministic token. The resolution record is
 * deleted through the atomic side-effect buffer, so in the normal case it rides
 * the very checkpoint that records the resumed result; a record whose delete
 * never commits is simply redelivered (idempotent for a deterministic token) or
 * swept by terminal cleanup/purge. If the acknowledgement batch itself fails,
 * the in-memory token claim is restored and the error propagates — the caller
 * learns the completion did NOT stick and can retry the still-live token.
 *
 * One caveat survives a crash: the failure path's raw thrown reason
 * (`originalReason`) is delivered as-is only within the acknowledging process.
 * A redelivery after recovery reconstructs the error from the persisted outcome
 * (message, name, failure category) — the same fidelity the worker resume path
 * has always had.
 *
 * The persisted record shapes, decode guards, key derivations, and the queued
 * resolution buffer live in `async-activity-records.ts`.
 */

import { KEYS } from '../../storage/interface.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import type { OperationOutcome } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import {
  buildAsyncActivityAcknowledgementOperations,
  queuePendingAsyncActivityResolution,
  registerPendingAsyncActivity,
  shouldBufferPendingAsyncActivityResolution,
  takePendingAsyncActivityResolution,
  type PendingAsyncActivity,
  type PendingAsyncActivityResolution,
} from './async-activity-records.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

type AsyncActivityResolutionCallbacks = {
  feedOperationResult: (
    workflowId: string,
    outcome: OperationOutcome,
    originalReason?: { value: unknown },
  ) => void;
  finalizeTimeline: (workflowId: string, status: 'completed' | 'failed', output: unknown) => void;
};

/**
 * Sentinel thrown by `ActivityContext.completeAsync()` to signal that the
 * activity is handing off to an out-of-band completion. The engine recognizes
 * this exact class (not a generic `Error`) and parks the activity rather than
 * treating it as a failure. The `token` is the durable task token an external
 * system uses to complete the activity later.
 */
export class AsyncActivityDeferral extends Error {
  readonly token: string;

  constructor(token: string) {
    super(
      `Activity deferred to out-of-band completion (token "${token}"). ` +
        'Complete it via engine.completeAsyncActivity(token, result) or ' +
        'engine.failAsyncActivity(token, error).',
    );
    this.name = 'AsyncActivityDeferral';
    this.token = token;
  }
}

/**
 * Thrown by {@link Engine.completeAsyncActivity} and
 * {@link Engine.failAsyncActivity} when no pending async activity matches the
 * supplied token. This covers unknown tokens, tokens for a different engine's
 * workflows, and tokens that were already completed or failed (each token is
 * single-use).
 *
 * @example
 * ```ts
 * import { AsyncActivityTokenNotFoundError } from '@lostgradient/weft';
 *
 * function isStaleCallbackToken(error: unknown): boolean {
 *   return error instanceof AsyncActivityTokenNotFoundError;
 * }
 * ```
 */
export class AsyncActivityTokenNotFoundError extends WeftError<'AsyncActivityTokenNotFoundError'> {
  readonly token: string;

  constructor(token: string) {
    super(
      'AsyncActivityTokenNotFoundError',
      `No pending async activity found for token "${token}". The token may be unknown, ` +
        'already completed, or already failed (tokens are single-use).',
    );
    this.token = token;
  }
}

/**
 * Park an activity that threw {@link AsyncActivityDeferral}: register the
 * pending entry durably and return a promise that never settles, so the
 * surrounding `runOperationWithResult` leaves the workflow suspended until an
 * out-of-band completion resumes it. Keeps the operation-pipeline catch site a
 * one-liner.
 */
export async function parkDeferredAsyncActivity(
  internals: EngineInternals,
  deferral: AsyncActivityDeferral,
  details: Omit<PendingAsyncActivity, 'token' | 'createdAt'>,
  callbacks: AsyncActivityResolutionCallbacks,
): Promise<never> {
  const queuedResolution = takePendingAsyncActivityResolution(
    internals,
    details.workflowId,
    deferral.token,
  );
  if (queuedResolution !== undefined) {
    await deliverPendingAsyncActivityResolution(
      internals,
      details.workflowId,
      queuedResolution,
      callbacks,
    );
    return new Promise<never>(() => {});
  }

  await registerPendingAsyncActivity(internals, {
    token: deferral.token,
    createdAt: internals.options.getNow(),
    ...details,
  });
  return new Promise<never>(() => {});
}

/**
 * Consume a pending async-activity token: claim the in-memory entry, then
 * durably commit the acknowledgement — one fenced batch that deletes the token
 * record and writes the resolution record carrying `outcome`. Returns the
 * consumed record, or throws {@link AsyncActivityTokenNotFoundError} when the
 * token is unknown or already consumed (tokens are single-use).
 *
 * If the acknowledgement batch fails, the in-memory claim is restored before
 * the error propagates, so the caller can retry the same still-live token.
 */
async function consumePendingAsyncActivity(
  internals: EngineInternals,
  token: string,
  outcome: OperationOutcome,
): Promise<PendingAsyncActivity> {
  const pending = internals.pendingAsyncActivities.get(token);
  if (!pending) {
    throw new AsyncActivityTokenNotFoundError(token);
  }
  // Claim the in-memory token SYNCHRONOUSLY, before any await. Two concurrent
  // completions for the same token (trivially race-able now that the token is
  // resolvable over a public HTTP endpoint) would otherwise both pass the
  // `get` above and both drive the workflow generator past the parked step.
  // The synchronous delete makes the second caller's `get` miss and throw
  // `AsyncActivityTokenNotFoundError`.
  internals.pendingAsyncActivities.delete(token);
  try {
    await commitFencedEngineWrite(
      internals,
      pending.workflowId,
      buildAsyncActivityAcknowledgementOperations(pending, outcome),
      [],
      () => new Error(`Async activity acknowledgement for token "${token}" lost its precondition.`),
    );
  } catch (error) {
    // The acknowledgement never became durable. Restore the in-memory claim so
    // a retry of this single-use token can succeed, then surface the failure.
    internals.pendingAsyncActivities.set(token, pending);
    throw error;
  }
  return pending;
}

/**
 * `wakeOwnershipCheck` runs FIRST, before either the durable side-effect
 * staging or `feedOperationResult` — this is the ADR's `async-activity`
 * claim-requiring wake kind. It matters even though `consumePendingAsyncActivity`
 * already ran a fresh, CAS-fenced write: this function has a SECOND call site
 * (`parkDeferredAsyncActivity`'s buffered-resolution replay drain) that
 * delivers a previously-acknowledged, LOCALLY QUEUED resolution with no fresh
 * write alongside it — nothing else fences that path against a stale
 * generation driving the generator. On discard, neither the resolution
 * record's delete nor the timeline/`feedOperationResult` calls run: the
 * durable resolution record survives untouched, so this workflow's true
 * current owner redelivers it (idempotent for a deterministic token) the next
 * time replay reaches this same token.
 */
async function deliverPendingAsyncActivityResolution(
  internals: EngineInternals,
  workflowId: string,
  resolution: PendingAsyncActivityResolution,
  callbacks: AsyncActivityResolutionCallbacks,
): Promise<void> {
  // Guard the `await` itself, not just its result. An async call suspends at
  // its first `await` even when the callee returns synchronously, and this
  // function was fully synchronous before the ownership work: awaiting
  // unconditionally would defer every side effect below by a microtask under
  // `ownership: 'none'` and `'lease'`, where the check is a no-op anyway.
  // Those modes must stay byte-identical, so the await only happens when a
  // claim registry actually exists.
  if (internals.workflowClaimRegistry !== null) {
    if ((await confirmWakeOwnership(internals, workflowId, 'async-activity')) === 'discard') {
      return;
    }
  }

  // Retire the durable resolution record with the checkpoint that records the
  // delivered result. Staging (rather than deleting standalone) keeps the
  // outcome recoverable until the workflow has durably adopted it; a record
  // whose delete never commits is redelivered on recovery, which is idempotent
  // for a deterministic token.
  stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
    conditions: [],
    operations: [
      { type: 'delete', key: KEYS.asyncActivityResolution(workflowId, resolution.token) },
    ],
  });
  callbacks.finalizeTimeline(workflowId, resolution.timelineStatus, resolution.timelineOutput);
  callbacks.feedOperationResult(workflowId, resolution.outcome, resolution.originalReason);
}

/**
 * Resolve a pending async activity by feeding `outcome` back into the parked
 * workflow. Shared by the completion and failure entry points so both paths
 * consume the token (single-use) before resuming and route through the same
 * `feedOperationResult` the inline activity pipeline uses.
 *
 * The caller must supply `finalizeTimeline` to transition the pending timeline
 * entry from 'running' to 'completed'/'failed', matching the normal inline
 * activity completion path in operations-router.ts.
 */
async function resolvePendingAsyncActivity(
  internals: EngineInternals,
  token: string,
  outcome: OperationOutcome,
  callbacks: AsyncActivityResolutionCallbacks,
  originalReason?: { value: unknown },
): Promise<void> {
  const pending = await consumePendingAsyncActivity(internals, token, outcome);
  const timelineOutput = outcome.status === 'completed' ? outcome.value : outcome.error;
  const resolution: PendingAsyncActivityResolution = {
    token,
    outcome,
    timelineStatus: outcome.status,
    timelineOutput,
    ...(originalReason !== undefined ? { originalReason } : {}),
  };
  if (shouldBufferPendingAsyncActivityResolution(internals, pending.workflowId)) {
    queuePendingAsyncActivityResolution(internals, pending.workflowId, resolution);
    return;
  }
  await deliverPendingAsyncActivityResolution(internals, pending.workflowId, resolution, callbacks);
}

/**
 * Complete a deferred activity out-of-band with `result`, resuming the parked
 * workflow as though the activity had returned `result` inline.
 */
export async function completeAsyncActivity(
  internals: EngineInternals,
  token: string,
  result: unknown,
  callbacks: AsyncActivityResolutionCallbacks,
): Promise<void> {
  // An async completion produces the same logical object as an inline activity
  // return — an activity result — but reaches the workflow through
  // `feedOperationResult`, which (unlike the inline reconciliation path) does not
  // size-check. Enforce the cap here so the async path matches inline activities
  // and `signal`. Checked BEFORE the token is consumed so an oversized payload is
  // rejectable and retryable with a smaller value rather than stranding the
  // single-use token.
  assertPayloadWithinLimit(result, internals.options.payloadSizePolicy.maxBytes, 'activity result');
  await resolvePendingAsyncActivity(
    internals,
    token,
    { status: 'completed', value: result },
    callbacks,
  );
}

/**
 * Drive a generator that may yield promises — the workflow interceptor's
 * `activity` hook returns such a generator. Forwards rejections into the
 * generator so try/catch/finally blocks inside the interceptor run correctly
 * instead of being abandoned.
 *
 * Placed here to reduce the line count of operations-activity.ts (which was
 * approaching the 500-line lint ceiling). The function is used only from
 * `executeActivity` in operations-activity.ts and has no coupling to the async
 * activity completion logic — it is a general generator-driving utility.
 */
export async function driveWorkflowInterceptorGenerator(
  generator: Generator<unknown, unknown, unknown>,
): Promise<unknown> {
  let current: IteratorResult<unknown, unknown> = generator.next();
  while (!current.done) {
    const yielded = current.value;
    if (yielded instanceof Promise) {
      let resolved: unknown;
      try {
        resolved = await yielded;
      } catch (error) {
        current = generator.throw(error);
        continue;
      }
      current = generator.next(resolved);
    } else {
      current = generator.next(yielded);
    }
  }
  return current.value;
}

/**
 * Fail a deferred activity out-of-band with `error`. The error is thrown into
 * the workflow generator at the parked step — identical to an inline activity
 * that threw — so the workflow's own try/catch and any configured retry policy
 * apply unchanged.
 */
export async function failAsyncActivity(
  internals: EngineInternals,
  token: string,
  error: unknown,
  callbacks: AsyncActivityResolutionCallbacks,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : undefined;
  // Both the failure message AND name are caller-supplied over the public
  // completion endpoint and get persisted (timeline + fed outcome). Cap the full
  // persisted shape — not just the message — for the same reason the complete
  // path caps its result. Checked BEFORE consuming the single-use token so an
  // oversized failure is rejectable and retryable rather than stranding it.
  assertPayloadWithinLimit(
    { message, name: errorName },
    internals.options.payloadSizePolicy.maxBytes,
    'activity result',
  );
  await resolvePendingAsyncActivity(
    internals,
    token,
    {
      status: 'failed',
      error: message,
      ...(error instanceof Error ? { errorName: error.name } : {}),
      failureCategory: 'application',
    },
    callbacks,
    { value: error },
  );
}
