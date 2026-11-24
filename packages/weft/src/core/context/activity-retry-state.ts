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
export type ActivityRetryStateKey = number | string;

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
  /**
   * The activity's name per step, kept for as long as the activity is retrying (COR-2529): written
   * with each retry attempt, dropped when the activity settles or runs out of retries. The commit
   * that records a retry reads it, together with `attempts`, to say which activity is on which
   * attempt. `attempts` alone cannot: an exhausted activity keeps its slot, and carries no name.
   */
  activityNames?: Record<string, string>;
}

/** The maps of one retry-state slot, as {@link writeRetryStateSlot} rebuilds them. */
type RetryStateMaps = Omit<ActivityRetryState, 'version'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isActivityRetryState(value: unknown): value is ActivityRetryState {
  return (
    isRecord(value) &&
    value['version'] === ACTIVITY_RETRY_STATE_VERSION &&
    isRecord(value['attempts']) &&
    (value['completedRetrySleeps'] === undefined || isRecord(value['completedRetrySleeps'])) &&
    (value['dispatchedAt'] === undefined || isRecord(value['dispatchedAt'])) &&
    (value['activityNames'] === undefined || isRecord(value['activityNames']))
  );
}

function retryStateSlotKey(key: ActivityRetryStateKey): string {
  if (typeof key === 'number') {
    return String(key);
  }
  if (key.length === 0) {
    throw new Error('Invalid empty checkpointed activity retry state key');
  }
  return key;
}

/** A slot's value, read only when the slot is an own entry, so a key like `constructor` finds nothing. */
function readSlot(slots: Record<string, number> | undefined, slotKey: string): number | undefined {
  return slots !== undefined && Object.hasOwn(slots, slotKey) ? slots[slotKey] : undefined;
}

function retryStateKeyLabel(key: ActivityRetryStateKey): string {
  return typeof key === 'number' ? `step ${String(key)}` : `key ${key}`;
}

function assertValidRetryAttempt(attempt: number, key: ActivityRetryStateKey): void {
  if (!Number.isInteger(attempt) || attempt <= 1 || attempt > MAX_CHECKPOINTED_RETRY_ATTEMPT) {
    throw new Error(
      `Invalid checkpointed activity retry attempt ${String(attempt)} for ${retryStateKeyLabel(key)}`,
    );
  }
}

export function readActivityRetryAttempt(
  internals: ContextInternals,
  key: ActivityRetryStateKey,
): number | undefined {
  const state = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state)) return undefined;

  const attempt = readSlot(state.attempts, retryStateSlotKey(key));
  if (attempt === undefined) return undefined;
  assertValidRetryAttempt(attempt, key);
  return attempt;
}

export function readCompletedRetrySleepCount(
  internals: ContextInternals,
  key: ActivityRetryStateKey,
): number {
  const state = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state)) return 0;

  const count = readSlot(state.completedRetrySleeps, retryStateSlotKey(key));
  if (count === undefined) return 0;
  if (!Number.isInteger(count) || count < 0 || count > MAX_CHECKPOINTED_RETRY_ATTEMPT) {
    throw new Error(
      `Invalid checkpointed activity retry sleep count ${String(count)} for ${retryStateKeyLabel(key)}`,
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
function writeRetryStateSlot(internals: ContextInternals, maps: RetryStateMaps): void {
  const { attempts, completedRetrySleeps, dispatchedAt, activityNames } = maps;
  const { [ACTIVITY_RETRY_STATE_LOCAL_KEY]: _removed, ...remainingLocals } =
    internals.checkpointLocals;
  const hasAttempts = Object.keys(attempts).length > 0;
  const hasSleeps =
    completedRetrySleeps !== undefined && Object.keys(completedRetrySleeps).length > 0;
  const hasDispatched = dispatchedAt !== undefined && Object.keys(dispatchedAt).length > 0;
  const hasNames = activityNames !== undefined && Object.keys(activityNames).length > 0;
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
      ...(hasNames ? { activityNames } : {}),
    } satisfies ActivityRetryState,
  };
}

/** The slot's maps as they are now, copied so a mutator can change one and write all back. */
function copyRetryStateMaps(current: ActivityRetryState | undefined): RetryStateMaps {
  return {
    attempts: { ...current?.attempts },
    ...(current?.completedRetrySleeps
      ? { completedRetrySleeps: current.completedRetrySleeps }
      : {}),
    ...(current?.dispatchedAt ? { dispatchedAt: current.dispatchedAt } : {}),
    ...(current?.activityNames ? { activityNames: { ...current.activityNames } } : {}),
  };
}

export function writeActivityRetryAttempt(
  internals: ContextInternals,
  key: ActivityRetryStateKey,
  attempt: number,
  activityName?: string,
): void {
  assertValidRetryAttempt(attempt, key);
  // Rebuild from every map: dropping `completedRetrySleeps` or `dispatchedAt` would make a
  // recovered workflow re-run backoff sleeps it already completed or reset its
  // scheduleToCloseTimeout window.
  const maps = copyRetryStateMaps(currentRetryState(internals));
  const slotKey = retryStateSlotKey(key);
  maps.attempts[slotKey] = attempt;
  if (activityName !== undefined) {
    maps.activityNames = { ...maps.activityNames, [slotKey]: activityName };
  }
  writeRetryStateSlot(internals, maps);
}

function clearActivityRetryAttempt(internals: ContextInternals, key: ActivityRetryStateKey): void {
  const current = currentRetryState(internals);
  if (!current) return;

  const maps = copyRetryStateMaps(current);
  const slotKey = retryStateSlotKey(key);
  delete maps.attempts[slotKey];
  if (maps.activityNames !== undefined) delete maps.activityNames[slotKey];
  writeRetryStateSlot(internals, maps);
}

/**
 * Stop reporting the activity at `key` as retrying, for an activity whose retries ended without a
 * result (its error was not retryable, or the attempts or the budget ran out). Only the name goes:
 * the attempt stays, as it always has, so retry behavior is untouched. A no-op when the step has no
 * recorded name, which is every activity that failed on its first attempt.
 */
export function forgetActivityRetryName(
  internals: ContextInternals,
  key: ActivityRetryStateKey,
): void {
  const current = currentRetryState(internals);
  const slotKey = retryStateSlotKey(key);
  if (current?.activityNames === undefined || !Object.hasOwn(current.activityNames, slotKey))
    return;

  const maps = copyRetryStateMaps(current);
  if (maps.activityNames !== undefined) delete maps.activityNames[slotKey];
  writeRetryStateSlot(internals, maps);
}

/**
 * `locals` without the names of the activities being retried, so a run that starts from a copy of
 * another run's checkpoint (a fork) reports nothing as retrying until it retries something
 * itself. The attempts stay, so the copy resumes the retry where the original was. Returns
 * `locals` itself when it holds no name.
 */
export function withoutRetryingActivityNames(
  locals: Record<string, unknown>,
): Record<string, unknown> {
  const slot = locals[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(slot) || slot.activityNames === undefined) return locals;

  const { activityNames: _names, ...withoutNames } = slot;
  return { ...locals, [ACTIVITY_RETRY_STATE_LOCAL_KEY]: withoutNames };
}

/**
 * The activity a checkpoint's locals show as retrying, for `WorkflowSummary.retrying`: the step on
 * the highest attempt (the lowest step key on a tie) among those with a recorded name and an
 * attempt of 2 or later; `undefined` when none is. Reads only own entries of the slot's maps, and
 * skips anything malformed, since a checkpoint's locals come from storage.
 */
export function readRetryingActivity(
  locals: Record<string, unknown> | undefined,
): { activity: string; attempt: number } | undefined {
  const state = locals?.[ACTIVITY_RETRY_STATE_LOCAL_KEY];
  if (!isActivityRetryState(state) || state.activityNames === undefined) return undefined;

  let retrying: { activity: string; attempt: number } | undefined;
  for (const slotKey of Object.keys(state.activityNames).toSorted()) {
    const candidate = retryingCandidate(state, slotKey);
    if (
      candidate !== undefined &&
      (retrying === undefined || candidate.attempt > retrying.attempt)
    ) {
      retrying = candidate;
    }
  }
  return retrying;
}

/** The named activity at `slotKey` when it is on attempt 2 or later, and `undefined` for a slot that is not. */
function retryingCandidate(
  state: ActivityRetryState,
  slotKey: string,
): { activity: string; attempt: number } | undefined {
  const names = state.activityNames;
  const activity =
    names !== undefined && Object.hasOwn(names, slotKey) ? names[slotKey] : undefined;
  const attempt = readSlot(state.attempts, slotKey);
  if (typeof activity !== 'string' || activity.length === 0) return undefined;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 2) {
    return undefined;
  }
  return { activity, attempt };
}

export function completeActivityRetryAttempt(
  internals: ContextInternals,
  key: ActivityRetryStateKey,
  completedRetrySleepCount: number,
): void {
  if (
    !Number.isInteger(completedRetrySleepCount) ||
    completedRetrySleepCount < 0 ||
    completedRetrySleepCount > MAX_CHECKPOINTED_RETRY_ATTEMPT
  ) {
    throw new Error(
      `Invalid completed activity retry sleep count ${String(completedRetrySleepCount)} for ${retryStateKeyLabel(key)}`,
    );
  }
  clearActivityRetryAttempt(internals, key);
  if (completedRetrySleepCount === 0) return;

  const maps = copyRetryStateMaps(currentRetryState(internals));
  maps.completedRetrySleeps = {
    ...maps.completedRetrySleeps,
    [retryStateSlotKey(key)]: completedRetrySleepCount,
  };
  writeRetryStateSlot(internals, maps);
}

/**
 * Read the first-dispatch anchor for a step's `scheduleToCloseTimeout`, writing
 * `now` on the first dispatch. Read-first so a crash/replay never resets the
 * window: the budget is measured from the original dispatch, and the anchor
 * lands in the checkpoint committed at the dispatch `yield` that follows.
 */
export function readOrInitActivityDispatchedAt(
  internals: ContextInternals,
  key: ActivityRetryStateKey,
  now: number,
): number {
  const current = currentRetryState(internals);
  const slotKey = retryStateSlotKey(key);
  const existing = readSlot(current?.dispatchedAt, slotKey);
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
      `Invalid checkpointed activity dispatch anchor ${String(existing)} for ${retryStateKeyLabel(key)}`,
    );
  }
  const maps = copyRetryStateMaps(current);
  maps.dispatchedAt = { ...maps.dispatchedAt, [slotKey]: now };
  writeRetryStateSlot(internals, maps);
  return now;
}
