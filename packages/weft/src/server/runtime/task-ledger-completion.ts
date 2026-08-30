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
 * @module server/runtime/task-ledger-completion
 */

import { TaskResultDeadLetteredEvent } from '../../core/events.ts';
import { isJSONValue } from '../../core/json.ts';
import type { Storage } from '../../storage/interface.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import type { ServeOptions } from '../index.ts';
import {
  beginCompletion,
  commitDeadLetter,
  commitTerminalResult,
} from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCompleting,
  type RemoteTaskDeadLettered,
  type RemoteTaskTerminal,
} from '../task-ledger.ts';
import { commitTaskLedgerTransition } from './task-ledger-runtime.ts';

const COMPLETION_MAX_ATTEMPTS = 3;
const DEAD_LETTER_MAX_ATTEMPTS = 1;

export type TaskLedgerCompletionInput = Readonly<{
  operationId: string;
  attemptToken: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
}>;

export type TaskLedgerCompletionResult =
  | Readonly<{ ok: true; completing: RemoteTaskCompleting; terminal: RemoteTaskTerminal }>
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
          ...(input.status === 'failed' && input.error !== undefined ? { error: input.error } : {}),
        },
        now,
      ),
    COMPLETION_MAX_ATTEMPTS,
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

export async function commitTaskLedgerCompletion(
  storage: Storage,
  input: TaskLedgerCompletionInput,
): Promise<TaskLedgerCompletionResult> {
  const resultDigest = await pendingResultDigest(input);

  const existing = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(input.operationId)));
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
    return { ok: true, completing: existing, terminal: committed.record };
  }

  const begun = await commitTaskLedgerTransition(
    storage,
    input.operationId,
    (current) =>
      beginCompletion(current, {
        attemptToken: input.attemptToken,
        pendingStatus: input.status,
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

  return { ok: true, completing: begun.record, terminal: committed.record };
}
