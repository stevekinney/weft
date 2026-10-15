import type { ContextInternals } from './internals.ts';

const SLEEP_DEADLINE_LOCAL_PREFIX = '__weftSleepDeadline:';

/**
 * Read the absolute deadline of the sleep at `step`, writing it on the first
 * evaluation. The anchor lands in the checkpoint committed at the sleep's
 * yield, so a replay that reaches the still-pending sleep (a claim takeover or
 * `recoverAll` before the deadline) re-parks on the SAME deadline. Deriving it
 * again from the resumed checkpoint's `createdAt` would move it later by the
 * time already elapsed on every early replay, so a wake-up cadence shorter than
 * the sleep would keep it from ever firing.
 */
export function readOrInitSleepFireAt(
  internals: ContextInternals,
  step: number,
  milliseconds: number,
): number {
  // Consume the reference time even when the anchor exists: it belongs to the
  // first uncached time operation after resume, and this sleep is that
  // operation. Leaving it set would hand a stale reference to the next sleep.
  const referenceTime = internals.sleepReferenceTime ?? internals.getNow();
  internals.sleepReferenceTime = undefined;

  const localKey = `${SLEEP_DEADLINE_LOCAL_PREFIX}${step}`;
  const existing = internals.checkpointLocals[localKey];
  if (typeof existing === 'number' && Number.isFinite(existing)) {
    return existing;
  }
  if (existing !== undefined) {
    throw new Error(
      `Invalid checkpointed sleep deadline ${JSON.stringify(existing)} for step ${step}`,
    );
  }

  const scheduledFireAt = referenceTime + milliseconds;
  // Reassign rather than mutate in place: `checkpointLocals` is frozen between operations.
  internals.checkpointLocals = { ...internals.checkpointLocals, [localKey]: scheduledFireAt };
  return scheduledFireAt;
}

/**
 * Drop the anchor of the sleep at `step` once it completes. The step's cached
 * result answers every later replay, so keeping the anchor would only grow each
 * checkpoint by one entry per sleep a recurring workflow takes.
 */
export function dropSleepFireAt(internals: ContextInternals, step: number): void {
  const { [`${SLEEP_DEADLINE_LOCAL_PREFIX}${step}`]: _completed, ...remainingLocals } =
    internals.checkpointLocals;
  internals.checkpointLocals = remainingLocals;
}
