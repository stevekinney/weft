import type { ContextInternals } from './internals.ts';

/**
 * Durable per-step retry bookkeeping for `ctx.run`, stored in the workflow's
 * `checkpointLocals` so it survives crash/replay. One slot holds, per step: the
 * current attempt number, how many backoff sleeps already completed, and the
 * first-dispatch timestamp anchoring `scheduleToCloseTimeout`. Every mutator
 * rebuilds the slot through {@link writeRetryStateSlot} so no sub-map is silently
 * erased when another is updated.
 */

export const ACTIVITY_RETRY_STATE_LOCAL_KEY = '__weftActivityRetryState';
const ACTIVITY_RETRY_STATE_VERSION = 1;
export const MAX_CHECKPOINTED_RETRY_ATTEMPT = 10_000;

export interface ActivityRetryState {
  version: typeof ACTIVITY_RETRY_STATE_VERSION;
  attempts: Record<string, number>;
  completedRetrySleeps?: Record<string, number>;
  /**
   * First-dispatch engine-clock timestamp per step, the anchor for
   * `scheduleToCloseTimeout`. Written ONCE on the first dispatch of a step and
   * never overwritten, so the wall-clock budget is measured from the original
   * dispatch even across crash/replay. Like `completedRetrySleeps`, it must be
   * preserved whenever the retry-state slot is rebuilt.
   */
  dispatchedAt?: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isActivityRetryState(value: unknown): value is ActivityRetryState {
  return (
    isRecord(value) &&
    value['version'] === ACTIVITY_RETRY_STATE_VERSION &&
    isRecord(value['attempts']) &&
    (value['completedRetrySleeps'] === undefined || isRecord(value['completedRetrySleeps'])) &&
    (value['dispatchedAt'] === undefined || isRecord(value['dispatchedAt']))
  );
}

function assertValidRetryAttempt(attempt: number, step: number): void {
  if (!Number.isInteger(attempt) || attempt <= 1 || attempt > MAX_CHECKPOINTED_RETRY_ATTEMPT) {
    throw new Error(
      `Invalid checkpointed activity retry attempt ${String(attempt)} for step ${String(step)}`,
    );
  }
}

export function readActivityRetryAttempt(
  internals: ContextInternals,
  step: number,
): number | undefined {
  const state = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state)) return undefined;

  const attempt = state.attempts[String(step)];
  if (attempt === undefined) return undefined;
  assertValidRetryAttempt(attempt, step);
  return attempt;
}

export function readCompletedRetrySleepCount(internals: ContextInternals, step: number): number {
  const state = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state)) return 0;

  const count = state.completedRetrySleeps?.[String(step)];
  if (count === undefined) return 0;
  if (!Number.isInteger(count) || count < 0 || count > MAX_CHECKPOINTED_RETRY_ATTEMPT) {
    throw new Error(
      `Invalid checkpointed activity retry sleep count ${String(count)} for step ${String(step)}`,
    );
  }
  return count;
}

/**
 * Read the current persisted retry state, or `undefined` if the slot is absent
 * or malformed. Centralizing the read keeps every mutator carrying the full slot
 * shape (attempts + completedRetrySleeps + dispatchedAt) forward.
 */
function currentRetryState(internals: ContextInternals): ActivityRetryState | undefined {
  const current = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  return isActivityRetryState(current) ? current : undefined;
}

/**
 * Write the retry-state slot, dropping it entirely when every sub-map is empty.
 * Every mutator routes through here so no field (`completedRetrySleeps`,
 * `dispatchedAt`) is silently erased when the slot is rebuilt.
 */
function writeRetryStateSlot(
  internals: ContextInternals,
  attempts: Record<string, number>,
  completedRetrySleeps: Record<string, number> | undefined,
  dispatchedAt: Record<string, number> | undefined,
): void {
  const { [ACTIVITY_RETRY_STATE_LOCAL_KEY]: _removed, ...remainingLocals } =
    internals.checkpointLocals;
  const hasAttempts = Object.keys(attempts).length > 0;
  const hasSleeps =
    completedRetrySleeps !== undefined && Object.keys(completedRetrySleeps).length > 0;
  const hasDispatched = dispatchedAt !== undefined && Object.keys(dispatchedAt).length > 0;
  if (!hasAttempts && !hasSleeps && !hasDispatched) {
    internals.checkpointLocals = remainingLocals;
    return;
  }
  internals.checkpointLocals = {
    ...remainingLocals,
    [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
      version: ACTIVITY_RETRY_STATE_VERSION,
      attempts,
      ...(hasSleeps ? { completedRetrySleeps } : {}),
      ...(hasDispatched ? { dispatchedAt } : {}),
    } satisfies ActivityRetryState,
  };
}

export function writeActivityRetryAttempt(
  internals: ContextInternals,
  step: number,
  attempt: number,
): void {
  assertValidRetryAttempt(attempt, step);
  const current = currentRetryState(internals);
  const attempts = current ? { ...current.attempts } : {};
  attempts[String(step)] = attempt;
  // Preserve completedRetrySleeps and dispatchedAt: rebuilding the slot with only
  // `attempts` would erase them, causing a recovered workflow to re-run backoff
  // sleeps it already completed or to reset its scheduleToCloseTimeout window.
  writeRetryStateSlot(internals, attempts, current?.completedRetrySleeps, current?.dispatchedAt);
}

function clearActivityRetryAttempt(internals: ContextInternals, step: number): void {
  const current = currentRetryState(internals);
  if (!current) return;

  const attempts = { ...current.attempts };
  delete attempts[String(step)];
  writeRetryStateSlot(internals, attempts, current.completedRetrySleeps, current.dispatchedAt);
}

export function completeActivityRetryAttempt(
  internals: ContextInternals,
  step: number,
  completedRetrySleepCount: number,
): void {
  if (
    !Number.isInteger(completedRetrySleepCount) ||
    completedRetrySleepCount < 0 ||
    completedRetrySleepCount > MAX_CHECKPOINTED_RETRY_ATTEMPT
  ) {
    throw new Error(
      `Invalid completed activity retry sleep count ${String(completedRetrySleepCount)} for step ${String(step)}`,
    );
  }
  clearActivityRetryAttempt(internals, step);
  if (completedRetrySleepCount === 0) return;

  const current = currentRetryState(internals);
  const attempts = current ? { ...current.attempts } : {};
  const completedRetrySleeps = current ? { ...current.completedRetrySleeps } : {};
  completedRetrySleeps[String(step)] = completedRetrySleepCount;
  writeRetryStateSlot(internals, attempts, completedRetrySleeps, current?.dispatchedAt);
}

/**
 * Read the first-dispatch anchor for a step's `scheduleToCloseTimeout`, writing
 * `now` on the first dispatch. Read-first so a crash/replay never resets the
 * window: the budget is measured from the original dispatch, and the anchor
 * lands in the checkpoint committed at the dispatch `yield` that follows.
 */
export function readOrInitActivityDispatchedAt(
  internals: ContextInternals,
  step: number,
  now: number,
): number {
  const current = currentRetryState(internals);
  const existing = current?.dispatchedAt?.[String(step)];
  // Honor any finite anchor, including 0: a test clock can legitimately report 0,
  // and an `existing > 0` guard would treat that as "unset" and re-anchor on every
  // replay, resetting the wall-clock budget.
  if (typeof existing === 'number' && Number.isFinite(existing)) {
    return existing;
  }
  // A present-but-non-finite anchor is corrupt persisted data. Fail loudly rather
  // than silently re-initializing to `now`: silent re-init would reset the
  // schedule-to-close window — the exact contract the anchor exists to uphold.
  // Only an ABSENT anchor (undefined) is a legitimate first dispatch / old record.
  if (existing !== undefined) {
    throw new Error(
      `Invalid checkpointed activity dispatch anchor ${String(existing)} for step ${String(step)}`,
    );
  }
  const attempts = current ? { ...current.attempts } : {};
  const dispatchedAt = current?.dispatchedAt ? { ...current.dispatchedAt } : {};
  dispatchedAt[String(step)] = now;
  writeRetryStateSlot(internals, attempts, current?.completedRetrySleeps, dispatchedAt);
  return now;
}
