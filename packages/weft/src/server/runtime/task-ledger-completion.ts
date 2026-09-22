/**
 * Shared two-step commit for applying a worker's task result to the durable
 * remote task ledger (WFT-22) — used by both the WebSocket (`onTaskResultMessage`)
 * and long-poll (`handleTaskResultRequest`) completion paths.
 *
 * `Leased --> Completing --> Terminal` is committed as two separate durable
 * writes, not one, even though the caller already holds the full result: the
 * project brief models `Completing` as an observable intermediate state
 * specifically so a crash between the two writes leaves a durable, recoverable
 * marker ("Completing prevents visibility scanning or disconnect handling from
 * requeueing an attempt while its terminal result is being applied") that
 * WFT-23's recovery is designed to resume. Collapsing the two transitions into
 * one write would make that state unobservable and defeat the point of having
 * it.
 *
 * A submitter can itself resume that crash window: if the record is already
 * `completing` with the same `attemptToken` AND the same `pendingResultDigest`
 * — the worker retrying the identical result after a server crash between the
 * two writes, or a benign duplicate submission — this skips straight to
 * `commitTerminalResult` instead of rejecting a legitimate resubmission with
 * "expected task state leased". A `completing` record whose digest or token
 * differs is a genuinely different result and is rejected normally.
 *
 * On exhausted retries — specifically when the *second* write
 * (`commitTerminalFromCompleting`) exhausts its CAS retry budget after the
 * record is already durably `completing` — this attempts one best-effort
 * `Completing --> DeadLettered` write (WFT-24's `commitDeadLetter`,
 * `../task-ledger-transitions.ts`) so a sustained, operation-specific
 * storage write failure becomes an operator-visible dead letter instead of a
 * silently stuck record. If the *first* write (`beginCompletion`) exhausts
 * instead, the record never left `leased` and no dead letter is attempted —
 * the visibility scanner's ordinary expiry path already covers that case.
 * If the dead-letter write itself also fails, this falls back to the plain
 * `ok: false` result exactly as before WFT-24: the record stays `completing`,
 * a worker resubmitting the identical result can still resume through the
 * `resuming` branch above, and no data is lost.
 *
 * COR-240 adds a `disposition` (`applied | duplicate | dead-lettered`) to
 * every successful result and two more idempotent-resubmission branches
 * ahead of the `resuming` one above, so a worker's outbox retry after an
 * ambiguous send — or after a full server restart — gets an accurate,
 * non-mutating answer instead of a confusing rejection:
 *
 *   - Same `attemptToken` against an already-`terminal` record, matching
 *     content digest: `duplicate`. No new write; the existing terminal
 *     record is re-affirmed.
 *   - Same `attemptToken` against an already-`deadLettered` record, matching
 *     pending digest: `dead-lettered`. No new write, same reasoning.
 *   - Same `attemptToken` against either state with a DIFFERENT digest is
 *     conflicting content submitted under one attempt token, and is
 *     rejected outright — a genuinely different result can never overwrite
 *     one the ledger already recorded.
 *   - A different `attemptToken` (a stale attempt, or the current record
 *     already moved past this attempt — `queued` for a retry, `leased` under
 *     a newer attempt, and so on) falls through unchanged to `beginCompletion`
 *     below, whose "expected task state leased" / "attempt token mismatch"
 *     preconditions already reject it without creating a second durable state.
 *
 * COR-230 adds a third `status`, `'cancelled'` — a worker's cooperative
 * response to a `cancel` control (acceptance criterion 13). It resolves
 * through a dedicated, EARLIER branch at the top of
 * {@link commitTaskLedgerCompletion} that commits `Cancelling -->
 * Terminal(disposition: 'cancelled')` directly via `commitCancellation`, one
 * step, not through `Completing`. Only taken when the record is currently
 * `cancelling` under this exact attempt token (i.e., the server itself
 * already recorded cancellation intent) or already resolved that exact
 * cancellation (`duplicate`); any other case normalizes to `pendingStatus:
 * 'failed'` and falls through to the ordinary path below, exactly as a
 * pre-COR-230 caller folding `cancelled` into `failed` before ever reaching
 * this function would have.
 *
 * @module server/runtime/task-ledger-completion
 */

import { TaskResultDeadLetteredEvent } from '../../core/events.ts';
import { isJSONValue } from '../../core/json.ts';
import { buildCurrentAttemptDispositionWrites } from '../../core/task-ledger/task-attempt-runtime.ts';
import { commitTaskLedgerTransition } from '../../core/task-ledger/task-ledger-runtime.ts';
import {
  beginCompletion,
  commitCancellation,
  commitDeadLetter,
  commitTerminalResult,
} from '../../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCompleting,
  type RemoteTaskDeadLettered,
  type RemoteTaskTerminal,
} from '../../core/task-ledger/task-ledger.ts';
import type { Storage } from '../../storage/interface.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import type { ServeOptions } from '../index.ts';
import { buildTerminalResolutionWrites } from './remote-activity-result-bridge.ts';

const COMPLETION_MAX_ATTEMPTS = 3;
const DEAD_LETTER_MAX_ATTEMPTS = 1;

export type TaskLedgerCompletionInput = Readonly<{
  operationId: string;
  attemptToken: string;
  /**
   * `'cancelled'` (COR-230, acceptance criterion 13) is a worker's
   * cooperative response to a `cancel` control — see
   * {@link commitTaskLedgerCompletion}'s doc comment for how it resolves
   * through the ledger's dedicated `Cancelling --> Terminal` transition
   * rather than the `completed`/`failed` `Completing` intermediate.
   */
  status: 'completed' | 'failed' | 'cancelled';
  value?: unknown;
  error?: string;
}>;

/** How the durable ledger resolved a submitted task result (COR-240). Mirrors `TaskResultAckMessage.disposition`. */
export type TaskResultDisposition = 'applied' | 'duplicate' | 'dead-lettered';

export type TaskLedgerCompletionResult =
  | Readonly<{
      ok: true;
      disposition: TaskResultDisposition;
      /** Present only when `disposition` is `'applied'` — the `completing` record this commit transitioned out of. */
      completing?: RemoteTaskCompleting;
      /** Present when `disposition` is `'applied'` or `'duplicate'`. */
      terminal?: RemoteTaskTerminal;
      /** Present only when `disposition` is `'dead-lettered'`. */
      deadLettered?: RemoteTaskDeadLettered;
    }>
  | Readonly<{ ok: false; reason: string; deadLettered?: RemoteTaskDeadLettered }>;

/** Content digest of the pending result — computed once and proven to match by `commitTerminalResult`. */
async function pendingResultDigest(input: TaskLedgerCompletionInput): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      status: input.status,
      value: input.value ?? null,
      error: input.error ?? null,
    }),
  );
}

function commitTerminalFromCompleting(
  storage: Storage,
  input: TaskLedgerCompletionInput,
  resultDigest: string,
) {
  return commitTaskLedgerTransition(
    storage,
    input.operationId,
    (current, now) =>
      commitTerminalResult(
        current,
        {
          attemptToken: input.attemptToken,
          resultDigest,
          // Covers both an ordinary 'failed' input and a 'cancelled' input
          // that fell through to this ordinary path because no cancellation
          // was ever recorded for this attempt (see
          // `commitTaskLedgerCompletion`'s doc comment) — both carry their
          // error text the same way a pre-COR-230 'failed'-only input did.
          ...(input.status !== 'completed' && input.error !== undefined
            ? { error: input.error }
            : {}),
        },
        now,
      ),
    COMPLETION_MAX_ATTEMPTS,
    [],
    // Acceptance criterion 6: a resolved result stays attributable to the
    // attempt that produced it, independent of the in-memory registry —
    // this is the same conditionalBatch commitTerminalResult's own write
    // lands in (criterion 11). It ALSO co-commits the durable async-activity
    // resolution record carrying the REAL value/error (not just the ledger's
    // own digest) in this SAME batch, so a crash between this write landing
    // and any later delivery to the parked workflow can never lose it — see
    // `remote-activity-result-bridge.ts`'s module doc comment.
    async (current, nextRecord, now) => [
      ...(await buildCurrentAttemptDispositionWrites(storage, current, {
        disposition: 'resolved',
        dispositionAt: now,
        ...(input.status !== 'completed' && input.error !== undefined
          ? { dispositionReason: input.error }
          : {}),
      })),
      ...buildTerminalResolutionWrites(
        nextRecord.workflowId,
        nextRecord.operationId,
        input.status === 'completed'
          ? { status: 'completed', value: input.value }
          : { status: 'failed', error: input.error ?? 'Remote activity failed' },
      ),
    ],
  );
}

/**
 * Best-effort escalation after `commitTerminalFromCompleting` exhausts its
 * CAS retries: attempt one `Completing --> DeadLettered` write so the
 * failure becomes operator-visible instead of a silently stuck `completing`
 * record. Returns the dead-lettered record on success, or `undefined` if
 * this write also failed (or lost a race to a legitimate concurrent write,
 * per `commitDeadLetter`'s precondition) — the caller falls back to the
 * plain failure result either way.
 */
async function attemptDeadLetter(
  storage: Storage,
  input: TaskLedgerCompletionInput,
  resultDigest: string,
  persistenceFailureReason: string,
): Promise<RemoteTaskDeadLettered | undefined> {
  const deadLettered = await commitTaskLedgerTransition(
    storage,
    input.operationId,
    (current, now) =>
      commitDeadLetter(
        current,
        {
          attemptToken: input.attemptToken,
          resultDigest,
          ...(isJSONValue(input.value) ? { value: input.value } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          persistenceFailureReason,
        },
        now,
      ),
    DEAD_LETTER_MAX_ATTEMPTS,
    [],
    // Acceptance criterion 6: a dead-lettered result stays attributable to
    // the attempt that produced it, same reasoning as the ordinary
    // resolved-result path above.
    async (current, _nextRecord, now) =>
      buildCurrentAttemptDispositionWrites(storage, current, {
        disposition: 'deadLettered',
        dispositionAt: now,
        dispositionReason: persistenceFailureReason,
      }),
  );
  return deadLettered.ok ? deadLettered.record : undefined;
}

/**
 * Dispatch {@link TaskResultDeadLetteredEvent} for a record `commitTaskLedgerCompletion`
 * dead-lettered. Shared by the WebSocket and long-poll completion paths so
 * both build the event from the same fields — `workflowId`/`activityName`/`queue`
 * come from the dead-lettered record itself (present on every `RemoteTaskBase`),
 * not from the caller's original request, so the event is accurate even if the
 * caller only had partial information.
 */
export function dispatchTaskDeadLetteredEvent(
  options: ServeOptions,
  operationId: string,
  deadLettered: RemoteTaskDeadLettered,
  workerId: string | undefined,
): void {
  options.engine.dispatchEvent(
    new TaskResultDeadLetteredEvent({
      operationId,
      workflowId: deadLettered.workflowId,
      activityName: deadLettered.activityName,
      queue: deadLettered.queue,
      workerId,
      errorMessage: deadLettered.persistenceFailureReason,
    }),
  );
}

/** The ledger record a completion is being matched against, or `null` when absent. */
type ExistingTaskRecord = ReturnType<typeof decodeRemoteTaskRecord>;

/**
 * Phase one of {@link commitTaskLedgerCompletion}: resolve a worker's
 * cooperative `status: 'cancelled'` result, if this attempt genuinely has a
 * cancellation recorded against it.
 *
 * Returns `undefined` to mean "fall through to the ordinary result path" —
 * the phase's fall-through is part of its contract, so it is expressed in the
 * return type rather than left implicit in the caller's control flow.
 *
 * COR-230, acceptance criterion 13: a worker's cooperative "I was
 * cancelled" result resolves through the ledger's dedicated
 * `Cancelling --> Terminal` transition — ONE step, matching the state
 * diagram exactly — not the `Completing` intermediate the ordinary
 * completed/failed path uses. Only reachable when the server itself
 * already recorded cancellation intent (`recordCancellationIntent`,
 * criterion 10) and the record is still `cancelling` under this exact
 * attempt token. Checked BEFORE the generic terminal/deadLettered
 * idempotency matching: a cancellation's `resultDigest` is deterministic
 * from `(operationId, attemptToken)` alone (`commitCancellation`), not a
 * content hash, so it would never match that matching's content-digest
 * comparison and would be misreported as conflicting content.
 */
async function resolveCooperativeCancellation(
  storage: Storage,
  input: TaskLedgerCompletionInput,
  existing: ExistingTaskRecord,
): Promise<TaskLedgerCompletionResult | undefined> {
  if (existing === null) return undefined;

  if (
    existing.state === 'terminal' &&
    existing.disposition === 'cancelled' &&
    existing.attemptToken === input.attemptToken
  ) {
    return { ok: true, disposition: 'duplicate', terminal: existing };
  }

  if (existing.state !== 'cancelling' || existing.attemptToken !== input.attemptToken) {
    return undefined;
  }

  const committed = await commitTaskLedgerTransition(
    storage,
    input.operationId,
    (current, now) => commitCancellation(current, { attemptToken: input.attemptToken }, now),
    COMPLETION_MAX_ATTEMPTS,
    [],
    // Acceptance criterion 6: a cooperatively-cancelled attempt stays
    // attributable, same as an ordinary resolved or dead-lettered one,
    // AND co-commits the durable async-activity resolution record so a
    // parked `ctx.run()` can resume with a cancellation-flavored failure
    // even across a crash — see `commitTerminalFromCompleting` above.
    async (current, nextRecord, now) => [
      ...(await buildCurrentAttemptDispositionWrites(storage, current, {
        disposition: 'cancelled',
        dispositionAt: now,
      })),
      ...buildTerminalResolutionWrites(nextRecord.workflowId, nextRecord.operationId, {
        status: 'failed',
        error: nextRecord.cancellationReason,
        failureCategory: 'cancellation',
      }),
    ],
  );
  if (!committed.ok) return committed;
  return { ok: true, disposition: 'applied', terminal: committed.record };
}

/**
 * Phase two of {@link commitTaskLedgerCompletion}: match an idempotent
 * resubmission against a record that already left `leased` under this exact
 * attempt (COR-240) — see the module doc comment for the full rationale.
 *
 * Returns `undefined` when there is nothing to match, which includes a record
 * whose `attemptToken` differs from this submission: that case falls straight
 * through to `beginCompletion`'s ordinary preconditions.
 */
function matchIdempotentResubmission(
  existing: ExistingTaskRecord,
  input: TaskLedgerCompletionInput,
  resultDigest: string,
): TaskLedgerCompletionResult | undefined {
  if (existing === null) return undefined;

  const conflict = {
    ok: false,
    reason: `conflicting content resubmitted for operation "${input.operationId}" under attempt token "${input.attemptToken}"`,
  } as const;

  // `attemptToken` is read only after `state` narrows the record union — not
  // every variant carries one.
  if (existing.state === 'terminal') {
    if (existing.attemptToken !== input.attemptToken) return undefined;
    return existing.resultDigest === resultDigest
      ? { ok: true, disposition: 'duplicate', terminal: existing }
      : conflict;
  }

  if (existing.state === 'deadLettered') {
    if (existing.attemptToken !== input.attemptToken) return undefined;
    return existing.pendingResultDigest === resultDigest
      ? { ok: true, disposition: 'dead-lettered', deadLettered: existing }
      : conflict;
  }

  return undefined;
}

export async function commitTaskLedgerCompletion(
  storage: Storage,
  input: TaskLedgerCompletionInput,
): Promise<TaskLedgerCompletionResult> {
  const existing = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(input.operationId)));

  if (input.status === 'cancelled') {
    const cancelled = await resolveCooperativeCancellation(storage, input, existing);
    if (cancelled !== undefined) return cancelled;
    // Fall through: no cancellation was ever recorded for this attempt (the
    // record is `leased`, `completing`, already resolved some other way, or
    // absent entirely) — resolve as an ordinary result via the shared path
    // below, normalizing to `pendingStatus: 'failed'` exactly as a
    // pre-COR-230 caller folding `cancelled` into `failed` before ever
    // reaching this function would have. This keeps a non-cooperating or
    // out-of-band "cancelled" report from being silently dropped, and its
    // idempotent-resubmission matching stable against a record created
    // under that same normalization.
  }

  const pendingStatus: 'completed' | 'failed' =
    input.status === 'completed' ? 'completed' : 'failed';
  const resultDigest = await pendingResultDigest({ ...input, status: pendingStatus });

  const resubmitted = matchIdempotentResubmission(existing, input, resultDigest);
  if (resubmitted !== undefined) return resubmitted;

  const resuming =
    existing !== null &&
    existing.state === 'completing' &&
    existing.attemptToken === input.attemptToken &&
    existing.pendingResultDigest === resultDigest;

  if (resuming) {
    const committed = await commitTerminalFromCompleting(storage, input, resultDigest);
    if (!committed.ok) {
      const deadLettered = await attemptDeadLetter(storage, input, resultDigest, committed.reason);
      return { ...committed, ...(deadLettered !== undefined ? { deadLettered } : {}) };
    }
    return { ok: true, disposition: 'applied', completing: existing, terminal: committed.record };
  }

  const begun = await commitTaskLedgerTransition(
    storage,
    input.operationId,
    (current) =>
      beginCompletion(current, {
        attemptToken: input.attemptToken,
        pendingStatus,
        pendingResultDigest: resultDigest,
      }),
    COMPLETION_MAX_ATTEMPTS,
  );
  if (!begun.ok) return begun;

  const committed = await commitTerminalFromCompleting(storage, input, resultDigest);
  if (!committed.ok) {
    const deadLettered = await attemptDeadLetter(storage, input, resultDigest, committed.reason);
    return { ...committed, ...(deadLettered !== undefined ? { deadLettered } : {}) };
  }

  return { ok: true, disposition: 'applied', completing: begun.record, terminal: committed.record };
}
