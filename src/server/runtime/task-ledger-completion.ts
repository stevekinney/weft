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
 * On exhausted retries this returns `ok: false` and does not fall back to a
 * dead-letter write — WFT-25 deliberately left `Completing --> DeadLettered`
 * out of the ten-row transition contract as WFT-24 ("Adoption, retention, and
 * diagnostics") territory. A retry-exhausted commit simply leaves the record
 * durably in whatever state it last reached (`leased` if the first write never
 * landed, `completing` if it did); no data is lost, and WFT-24's dead-letter
 * transition — once it exists — is what turns that into an operator-visible
 * dead letter.
 *
 * @module server/runtime/task-ledger-completion
 */

import type { Storage } from '../../storage/interface.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import { beginCompletion, commitTerminalResult } from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCompleting,
  type RemoteTaskTerminal,
} from '../task-ledger.ts';
import { commitTaskLedgerTransition } from './task-ledger-runtime.ts';

const COMPLETION_MAX_ATTEMPTS = 3;

export type TaskLedgerCompletionInput = Readonly<{
  operationId: string;
  attemptToken: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
}>;

export type TaskLedgerCompletionResult =
  | Readonly<{ ok: true; completing: RemoteTaskCompleting; terminal: RemoteTaskTerminal }>
  | Readonly<{ ok: false; reason: string }>;

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
    if (!committed.ok) return committed;
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
  if (!committed.ok) return committed;

  return { ok: true, completing: begun.record, terminal: committed.record };
}
