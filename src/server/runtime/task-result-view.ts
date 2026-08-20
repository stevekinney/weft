/**
 * Public read/adopt surface over a single durable task-ledger record
 * (WFT-24) — backs `WeftServer.getTaskResult` and `WeftServer.adoptTaskResult`.
 *
 * `TaskResultView` is a deliberately narrow projection of
 * `RemoteTaskRecord`, not a re-export of it: the ledger types are
 * server-internal (`task-ledger.ts`'s own doc comment — "not re-exported
 * from `src/index.ts`") and carry fields with no business being public,
 * such as `workerSessionId`, `attemptToken`, and `executionIdentity`. A
 * resolved terminal record's actual result *value* is deliberately absent
 * from this view for the same reason it is absent from the ledger itself:
 * `RemoteTaskTerminalResolved` only ever stores `resultDigest` (a content
 * hash), never the value — the durable ledger proves which attempt won,
 * it does not re-deliver the payload. `resultDigest` exists so a caller
 * that already has the value through whatever channel actually delivered
 * it can verify it matches before adopting.
 *
 * "Adoption" (`adoptTaskResultImpl`) is an explicit caller assertion, not
 * something this module infers: nothing in the engine today automatically
 * links a workflow's own checkpoint to a remote task's terminal ledger
 * record (that bridge is out of this project's scope — see the `blocks`
 * relations on the WFT-24 Linear issue). A terminal record an adopter never
 * calls this for is retained forever, by design; `reapRetainedTerminalRecord`
 * (`task-reconciliation.ts`) only reaps *adopted* records.
 *
 * @module server/runtime/task-result-view
 */

import type { ServeOptions } from '../index.ts';
import { markWorkflowResultAdopted } from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskDeadLettered,
  type RemoteTaskTerminal,
} from '../task-ledger.ts';
import { commitTaskLedgerTransition } from './task-ledger-runtime.ts';

/**
 * Public, storage-agnostic view of a single task-ledger record.
 *
 * @example
 * ```ts
 * import { serve, type TaskResultView } from '@lostgradient/weft/server';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * await using server = serve({ engine, port: 0 });
 *
 * const view: TaskResultView | null = await server.getTaskResult('op-1');
 * if (view?.status === 'terminal' && !view.adopted) {
 *   await server.adoptTaskResult('op-1', view.resultDigest);
 * }
 * ```
 */
export type TaskResultView =
  | Readonly<{ status: 'pending'; state: 'queued' | 'leased' | 'completing' | 'cancelling' }>
  | Readonly<{
      status: 'terminal';
      disposition: 'resolved' | 'cancelled' | 'retryExhausted';
      resultDigest: string;
      terminalAt: number;
      adopted: boolean;
      adoptedAt?: number;
      /** Only present for `disposition: 'resolved'` — whether the worker reported success or failure. */
      resultStatus?: 'completed' | 'failed';
      error?: string;
    }>
  | Readonly<{
      status: 'deadLettered';
      persistenceFailureReason: string;
      pendingStatus: 'completed' | 'failed';
      deadLetteredAt: number;
      error?: string;
    }>;

function terminalTaskResultView(decoded: RemoteTaskTerminal): TaskResultView {
  return {
    status: 'terminal',
    disposition: decoded.disposition,
    resultDigest: decoded.resultDigest,
    terminalAt: decoded.terminalAt,
    adopted: decoded.adopted,
    ...(decoded.adoptedAt !== undefined ? { adoptedAt: decoded.adoptedAt } : {}),
    ...(decoded.disposition === 'resolved' ? { resultStatus: decoded.status } : {}),
    ...('error' in decoded && decoded.error !== undefined ? { error: decoded.error } : {}),
  };
}

function deadLetteredTaskResultView(decoded: RemoteTaskDeadLettered): TaskResultView {
  return {
    status: 'deadLettered',
    persistenceFailureReason: decoded.persistenceFailureReason,
    pendingStatus: decoded.pendingStatus,
    deadLetteredAt: decoded.deadLetteredAt,
    ...(decoded.error !== undefined ? { error: decoded.error } : {}),
  };
}

/**
 * Read the current public view of a task-ledger record. Returns `null` if
 * no record exists for `operationId` — either it was never dispatched, or a
 * retained terminal record has already been reaped.
 */
export async function getTaskResultViewImpl(
  options: ServeOptions,
  operationId: string,
): Promise<TaskResultView | null> {
  const decoded = decodeRemoteTaskRecord(
    await options.engine.storage.get(taskLedgerKey(operationId)),
  );
  if (decoded === null) return null;

  switch (decoded.state) {
    case 'queued':
    case 'leased':
    case 'completing':
    case 'cancelling':
      return { status: 'pending', state: decoded.state };
    case 'terminal':
      return terminalTaskResultView(decoded);
    case 'deadLettered':
      return deadLetteredTaskResultView(decoded);
    default: {
      // Exhaustiveness guard: adding a new RemoteTaskRecord state without a
      // case above must fail this typecheck.
      const exhaustive: never = decoded;
      return exhaustive;
    }
  }
}

/**
 * Mark a terminal task's result as adopted by the caller — the durable
 * assertion that "the workflow checkpoint (or whatever consumed this
 * result) has incorporated it," per the project brief's adoption/retention
 * split. Returns `true` once adopted, `false` if the record is not
 * currently `terminal` or `resultDigest` does not match (including a
 * record that no longer exists, e.g. already reaped). Idempotent: adopting
 * an already-adopted record with the same digest succeeds again, refreshing
 * `adoptedAt`.
 */
export async function adoptTaskResultImpl(
  options: ServeOptions,
  operationId: string,
  resultDigest: string,
): Promise<boolean> {
  const result = await commitTaskLedgerTransition(
    options.engine.storage,
    operationId,
    (current, now) =>
      markWorkflowResultAdopted(current, { expectedResultDigest: resultDigest }, now),
    1,
  );
  return result.ok;
}
