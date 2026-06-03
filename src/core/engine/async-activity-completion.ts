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
 * resolves the correct activity.
 *
 * Internal-only. Imported from `src/core/engine/**` and the `ActivityContext`
 * construction path.
 */

import { KEYS, encodeStorageKeyComponent, type Storage } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { ActivityAsyncPendingEvent } from '../events.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import type { OperationOutcome } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import type { EngineInternals } from './internals.ts';

const ASYNC_ACTIVITY_TOKEN_PREFIX = 'async-act:v1';

/**
 * Storage-key prefix for durable pending-async-activity records. Matches the
 * base of {@link KEYS.asyncActivity}; the full key appends
 * `<workflowId>:<token>`. The trailing colon (absent from the token prefix)
 * scopes the global recovery scan to record keys only.
 */
const ASYNC_ACTIVITY_KEY_PREFIX = 'async-act:v1:';

/**
 * Per-workflow prefix for all async-activity storage keys. Used by cleanup and
 * purge paths that need to sweep every async-activity record for a workflow
 * without enumerating individual tokens.
 */
export function asyncActivityWorkflowPrefix(workflowId: string): string {
  return `${ASYNC_ACTIVITY_KEY_PREFIX}${encodeStorageKeyComponent(workflowId)}:`;
}

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
 * In-memory record of an activity that deferred to out-of-band completion and
 * is awaiting `completeAsyncActivity` / `failAsyncActivity`.
 */
export type PendingAsyncActivity = {
  readonly token: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly operationId: string;
  readonly step: number;
  readonly attempt: number;
  readonly createdAt: number;
};

/** Durable shape persisted under {@link KEYS.asyncActivity}. */
type PersistedAsyncActivity = {
  readonly version: 1;
  readonly token: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly operationId: string;
  readonly step: number;
  readonly attempt: number;
  readonly createdAt: number;
};

function isPersistedAsyncActivity(value: unknown): value is PersistedAsyncActivity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['token'] === 'string' &&
    typeof record['workflowId'] === 'string' &&
    typeof record['activityName'] === 'string' &&
    typeof record['operationId'] === 'string' &&
    typeof record['step'] === 'number' &&
    typeof record['attempt'] === 'number' &&
    typeof record['createdAt'] === 'number'
  );
}

/**
 * Derive the durable, deterministic task token for an async activity.
 *
 * The token is anchored to the workflow id, the workflow step index, and the
 * dispatch attempt — all of which are stable across replay — so a workflow that
 * crashes while parked on an async activity mints the identical token after
 * recovery. `operationId` is deliberately excluded because it is regenerated on
 * every yield and would change on replay.
 */
export function deriveAsyncActivityToken(
  workflowId: string,
  step: number,
  attempt: number,
): string {
  return `${ASYNC_ACTIVITY_TOKEN_PREFIX}:${workflowId}:${step}:${attempt}`;
}

function persistPendingAsyncActivity(
  storage: Storage,
  pending: PendingAsyncActivity,
): Promise<void> {
  const record: PersistedAsyncActivity = {
    version: 1,
    token: pending.token,
    workflowId: pending.workflowId,
    activityName: pending.activityName,
    operationId: pending.operationId,
    step: pending.step,
    attempt: pending.attempt,
    createdAt: pending.createdAt,
  };
  return storage.put(KEYS.asyncActivity(pending.workflowId, pending.token), encode(record));
}

/**
 * Register a deferred activity: record it in memory and durably, then announce
 * the token via {@link ActivityAsyncPendingEvent}. Idempotent on `token`: if the
 * token is already registered (e.g. because `recoverPendingAsyncActivities` loaded
 * it before the workflow replayed and re-deferred), the durable record is
 * refreshed but the event is NOT re-emitted, preventing duplicate side-effects
 * (e.g. re-sending a webhook notification) on replay.
 */
export async function registerPendingAsyncActivity(
  internals: EngineInternals,
  pending: PendingAsyncActivity,
): Promise<void> {
  const alreadyRegistered = internals.pendingAsyncActivities.has(pending.token);
  internals.pendingAsyncActivities.set(pending.token, pending);
  await persistPendingAsyncActivity(internals.storage, pending);
  if (!alreadyRegistered) {
    internals.engine.dispatchEvent(
      new ActivityAsyncPendingEvent(
        pending.token,
        pending.operationId,
        pending.workflowId,
        pending.activityName,
        pending.attempt,
      ),
    );
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
): Promise<never> {
  await registerPendingAsyncActivity(internals, {
    token: deferral.token,
    createdAt: internals.options.getNow(),
    ...details,
  });
  return new Promise<never>(() => {});
}

/**
 * Reload pending async-activity records from storage into memory. Called by
 * `recoverAll()` so a token minted before a crash is resolvable again — even
 * before the recovered workflow has replayed far enough to re-register it.
 */
export async function recoverPendingAsyncActivities(internals: EngineInternals): Promise<void> {
  // Global scan prefix shared with `KEYS.asyncActivity`; the per-token suffix
  // (`<workflowId>:<token>`) follows this base.
  for await (const [, bytes] of internals.storage.scan(ASYNC_ACTIVITY_KEY_PREFIX)) {
    const decoded = decode(bytes);
    if (!isPersistedAsyncActivity(decoded)) continue;
    internals.pendingAsyncActivities.set(decoded.token, {
      token: decoded.token,
      workflowId: decoded.workflowId,
      activityName: decoded.activityName,
      operationId: decoded.operationId,
      step: decoded.step,
      attempt: decoded.attempt,
      createdAt: decoded.createdAt,
    });
  }
}

/**
 * Consume a pending async-activity token: remove the in-memory entry and delete
 * the durable record. Returns the consumed record, or throws
 * {@link AsyncActivityTokenNotFoundError} when the token is unknown or already
 * consumed (tokens are single-use).
 *
 * Note: there is a narrow window during `recoverAll()` between
 * `recoverPendingAsyncActivities` (which loads tokens into memory) and the
 * completion of workflow replay (which adopts the workflow generator). If
 * `completeAsyncActivity` is called in that window, `feedOperationResult` will
 * silently no-op because the generator isn't adopted yet. The token is then
 * permanently consumed, stranding the workflow. Callers should wait for
 * `recoverAll()` to settle before resuming async activities after a restart.
 * A proper deferred-resume queue is a follow-up concern.
 */
async function consumePendingAsyncActivity(
  internals: EngineInternals,
  token: string,
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
    await internals.storage.delete(KEYS.asyncActivity(pending.workflowId, token));
  } catch (error) {
    // Restore the in-memory token on storage failure so the caller can retry —
    // preserving the original "don't lose the token if storage rejects" invariant.
    internals.pendingAsyncActivities.set(token, pending);
    throw error;
  }
  return pending;
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
  feedOperationResult: (workflowId: string, outcome: OperationOutcome) => void,
  finalizeTimeline: (workflowId: string, status: 'completed' | 'failed', output: unknown) => void,
): Promise<void> {
  const pending = await consumePendingAsyncActivity(internals, token);
  const timelineOutput = outcome.status === 'completed' ? outcome.value : outcome.error;
  finalizeTimeline(pending.workflowId, outcome.status, timelineOutput);
  feedOperationResult(pending.workflowId, outcome);
}

/**
 * Complete a deferred activity out-of-band with `result`, resuming the parked
 * workflow as though the activity had returned `result` inline.
 */
export async function completeAsyncActivity(
  internals: EngineInternals,
  token: string,
  result: unknown,
  feedOperationResult: (workflowId: string, outcome: OperationOutcome) => void,
  finalizeTimeline: (workflowId: string, status: 'completed' | 'failed', output: unknown) => void,
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
    feedOperationResult,
    finalizeTimeline,
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
  feedOperationResult: (
    workflowId: string,
    outcome: OperationOutcome,
    originalReason?: { value: unknown },
  ) => void,
  finalizeTimeline: (workflowId: string, status: 'completed' | 'failed', output: unknown) => void,
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
  const pending = await consumePendingAsyncActivity(internals, token);
  finalizeTimeline(pending.workflowId, 'failed', message);
  feedOperationResult(
    pending.workflowId,
    {
      status: 'failed',
      error: message,
      ...(error instanceof Error ? { errorName: error.name } : {}),
      failureCategory: 'application',
    },
    { value: error },
  );
}
