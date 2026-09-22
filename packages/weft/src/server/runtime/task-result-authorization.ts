/**
 * Single "does this `taskResult` submission belong to the operation's
 * current attempt" decision, shared by the WebSocket (`onTaskResultMessage`,
 * `websocket-worker.ts`) and HTTP long-poll (`isLongPollCompletionAuthorized`,
 * `task-polling.ts`) transports (COR-233, "Transport and Conformance
 * Integration").
 *
 * Before this module, the two transports reached equivalent conclusions
 * through separate code that had already started to drift: WebSocket
 * authorized against the ephemeral `WorkerRegistry`'s in-flight entry,
 * long-poll against a direct read of the durable ledger record. Worse, each
 * transport's local notion of "current" forgot a just-resolved attempt
 * entirely — `WorkerRegistry.completeTask()` deletes the in-flight entry the
 * instant the first `taskResult` for an operation is processed, and
 * long-poll's old gate required `record.state` to still be `leased` or
 * `completing` — so a worker resending an unacknowledged result after losing
 * the ack (the entire point of `TaskResultOutbox`, `worker/task-result-outbox.ts`)
 * could never reach `commitTaskLedgerCompletion`'s idempotent `duplicate`
 * handling on either transport. It hit a permanent rejection instead, which
 * can never clear the worker's outbox.
 *
 * `authorizeTaskResultForCurrentAttempt` fixes that by deciding purely from a
 * normalized `CurrentAttempt` view — built differently per transport (see
 * `currentAttemptFromLedgerRecord`, used by both long-poll and WebSocket's
 * fallback path, and WebSocket's own `InFlightTask`-derived view for its fast
 * path) — so both transports' notion of "the current attempt" is exactly one
 * piece of logic.
 *
 * @module server/runtime/task-result-authorization
 */

import type { RemoteTaskRecord } from '../../core/task-ledger/task-ledger.ts';
import type { InFlightTask } from '../../worker/registry.ts';

/**
 * The identity a `taskResult` submission is checked against. `workerSessionId`
 * is present only while an attempt is still live — a `RemoteTaskLeased` or
 * `RemoteTaskCompleting` ledger record, or a `WorkerRegistry` in-flight
 * entry. A resolved attempt (`RemoteTaskTerminal`/`RemoteTaskDeadLettered`)
 * carries no `workerSessionId` at all (see `task-ledger-types.ts` — neither
 * type includes it), so `attemptToken` alone is the remaining proof that a
 * resubmission belongs to the attempt that already resolved.
 *
 * `workerSessionId` is deliberately a bare string, not a `WorkerSessionIdentity`
 * — full session identity (generation, liveness) is COR-230's deliverable.
 * This shape is where COR-230 extends the comparison without a rewrite of
 * either transport's call site.
 *
 * COR-220 ("Reconnect, Shutdown, and Diagnostics") does NOT widen this shape
 * with a session-generation comparison, even though it introduces a proven-
 * vs-unproven reconnect distinction that superficially looks like it would
 * need one. It doesn't: an unproven reconnect's in-flight forfeit is
 * awaited to completion — the durable requeue transition that rotates the
 * attempt away from its old `attemptToken` — BEFORE the new session's
 * `registerAck` is sent, so no frame the new socket is allowed to send can
 * ever race that rotation. `attemptToken` alone remains sufficient. A
 * generation stamp on this shape was tried and reverted: it cannot defend
 * the one race that matters (see the ordering above, which closes it
 * instead) and it reopens `RemoteTaskLeased.workerSessionId` recovery's own
 * documented promise — "completions from the ORIGINAL WORKER are recognized
 * after reconnect" (`task-ledger-recovery.ts`) — since a restarted registry
 * always starts a reconnecting worker back at generation 1, which is lower
 * than whatever generation a long-lived ledger record might carry from
 * before the restart.
 */
export interface CurrentAttempt {
  readonly workerSessionId?: string;
  readonly attemptToken: string;
}

export type TaskResultAuthorizationFailure =
  'no-current-attempt' | 'worker-mismatch' | 'attempt-token-mismatch';

export type TaskResultAuthorizationResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; reason: TaskResultAuthorizationFailure }>;

/**
 * The shared decision: may a `taskResult` submission (`workerId` +
 * `attemptToken`) proceed to `applyWorkerTaskResult`?
 *
 *   - `current === undefined` — no attempt is currently held or was ever
 *     resolved under a recoverable identity (no record, or one still
 *     `queued`/`cancelling`). Rejected as `'no-current-attempt'` — COR-233
 *     item 2: a missing current attempt is a rejection, never a
 *     duplicate-tolerant no-op success.
 *   - `current.workerSessionId` present — the attempt is still live. The
 *     submission's `workerId` must match it exactly before `attemptToken` is
 *     even compared, so a stale completion from a worker displaced by
 *     visibility-timeout reassignment is rejected as `'worker-mismatch'`
 *     without leaking whether the token would otherwise have matched.
 *   - `current.workerSessionId` absent — the attempt already resolved
 *     (terminal or dead-lettered) and dropped session identity. Only
 *     `attemptToken` can be compared; a match is authorized to proceed.
 *     `commitTaskLedgerCompletion`'s own content-digest comparison is what
 *     actually decides `duplicate` vs. a rejected content conflict from
 *     there — this function only decides whether the submission is allowed
 *     to reach that comparison at all.
 */
export function authorizeTaskResultForCurrentAttempt(
  current: CurrentAttempt | undefined,
  workerId: string | undefined,
  attemptToken: string,
): TaskResultAuthorizationResult {
  if (current === undefined) {
    return { ok: false, reason: 'no-current-attempt' };
  }
  if (current.workerSessionId !== undefined) {
    if (workerId === undefined || current.workerSessionId !== workerId) {
      return { ok: false, reason: 'worker-mismatch' };
    }
  }
  if (current.attemptToken !== attemptToken) {
    return { ok: false, reason: 'attempt-token-mismatch' };
  }
  return { ok: true };
}

/** `CurrentAttempt` view of a `WorkerRegistry` in-flight entry — WebSocket's fast path. */
export function currentAttemptFromInFlightTask(
  task: InFlightTask | undefined,
): CurrentAttempt | undefined {
  if (task === undefined) return undefined;
  return { workerSessionId: task.workerId, attemptToken: task.attemptToken };
}

/**
 * `CurrentAttempt` view of a durable ledger record — long-poll's only source
 * of truth, and WebSocket's fallback once `WorkerRegistry` has forgotten the
 * operation (see this module's doc comment). `queued` and `cancelling`
 * records have no resolvable "current attempt" (a `cancelling` record's
 * attempt is being torn down, not completed) and reduce to `undefined`
 * exactly like a missing record.
 */
export function currentAttemptFromLedgerRecord(
  record: RemoteTaskRecord | null,
): CurrentAttempt | undefined {
  if (record === null) return undefined;
  // `cancelling` (COR-230) is a live attempt exactly like `leased`/
  // `completing` — the worker still holds the lease while cooperative
  // cancellation is pending, and its resulting `taskResult(status:
  // 'cancelled')` must reach `commitTaskLedgerCompletion`'s dedicated
  // cancellation branch rather than being rejected here as
  // 'no-current-attempt'.
  if (record.state === 'leased' || record.state === 'completing' || record.state === 'cancelling') {
    return { workerSessionId: record.workerSessionId, attemptToken: record.attemptToken };
  }
  if (record.state === 'terminal' || record.state === 'deadLettered') {
    return record.attemptToken === undefined ? undefined : { attemptToken: record.attemptToken };
  }
  return undefined;
}
