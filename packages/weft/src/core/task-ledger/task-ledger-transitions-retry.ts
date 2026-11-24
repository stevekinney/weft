/**
 * The "Retry dead letter" row of the durable remote task ledger's transition
 * contract (COR-1973) — the dead-letter counterpart of `commitDeadLetter` and
 * `canClearDeadLetteredTask` in `task-ledger-transitions.ts`, in its own file
 * because that file is at this repository's file-size ceiling. Like the other
 * rows it is pure: it takes the decoded current record and returns the next
 * record to persist or a rejection reason, and never touches storage.
 *
 * @module server/task-ledger-transitions-retry
 */

import { digestAttemptToken } from './task-attempt-runtime.ts';
import {
  pickAttemptFields,
  pickBase,
  type TaskLedgerTransitionResult,
} from './task-ledger-transition-helpers.ts';
import type { RemoteTaskQueued, RemoteTaskRecord } from './task-ledger-types.ts';

/**
 * The `reason` {@link retryDeadLetteredTask} returns when the caller named a
 * dead-lettered attempt that is no longer the one on the record. Exported so
 * the operation can tell this refusal from a lost compare-and-swap.
 */
export const DEAD_LETTER_CHANGED_REASON = 'dead-letter-changed';

export type RetryDeadLetteredTaskInput = Readonly<{
  /** Digest of the dead-lettered attempt the caller read; omitted retries whichever attempt is dead-lettered. */
  attemptTokenDigest?: string;
}>;

/**
 * Return a dead-lettered task to `queued` under the same operation id so it
 * is claimed again (`weft.tasks.deadletters.retry`). The dead attempt is
 * history, not state: its `TaskAttemptRecord` (disposition `deadLettered`)
 * and the delivery history stay where they are, and the next claim writes a
 * new attempt record for `attempt + 1`. The result the dead attempt could
 * not persist (`value`, `error`, `pendingResultDigest`, `pendingStatus`) and
 * its lease holder are dropped from the ledger record, so a late result or
 * heartbeat carrying the old attempt token is refused by `beginCompletion`
 * and `renewAttemptLease`.
 *
 * `requeueCount` is incremented, as for any other requeue, and
 * `retryCount` is raised to the number of attempts already made. This does
 * not consult `retryPolicy.maxAttempts`: an operator retry is a deliberate
 * extra attempt, so a task at the cap stays retryable, and the next
 * automatic requeue may end it `retryExhausted`.
 */
export function retryDeadLetteredTask(
  current: RemoteTaskRecord | null,
  input: RetryDeadLetteredTaskInput,
  now: number,
): TaskLedgerTransitionResult<RemoteTaskQueued> {
  if (current === null || current.state !== 'deadLettered') {
    return { ok: false, reason: 'expected task state "deadLettered"' };
  }
  if (
    input.attemptTokenDigest !== undefined &&
    input.attemptTokenDigest !== digestAttemptToken(current.attemptToken)
  ) {
    return { ok: false, reason: DEAD_LETTER_CHANGED_REASON };
  }
  const nextAttempt = current.attempt + 1;
  const nextRecord: RemoteTaskQueued = {
    ...pickBase(current),
    ...pickAttemptFields(current),
    generation: current.generation + 1,
    state: 'queued',
    attempt: nextAttempt,
    availableAt: now,
    firstQueuedAt: current.createdAt,
    lastQueuedAt: now,
    retryCount: Math.max(current.retryCount, nextAttempt - 1),
    requeueCount: current.requeueCount + 1,
    lastRequeueReason: 'dead-letter-retry',
  };
  return { ok: true, nextRecord };
}
