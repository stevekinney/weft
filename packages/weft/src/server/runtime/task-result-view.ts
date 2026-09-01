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
 * it does not re-deliver the payload. Only resolved views expose that digest:
 * cancelled and retry-exhausted records use internal synthetic digests that
 * include the attempt token. A resolved `resultDigest` exists so a caller that
 * already has the value through whatever channel actually delivered it can
 * verify it matches before adopting.
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

import type { Storage } from '../../storage/interface.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
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
 * if (view?.status === 'terminal' && view.disposition === 'resolved' && !view.adopted) {
 *   await server.adoptTaskResult('op-1', view.resultDigest);
 * } else if (
 *   view?.status === 'terminal' &&
 *   view.disposition !== 'resolved' &&
 *   !view.adopted
 * ) {
 *   await server.adoptTaskResult('op-1', view.adoptionToken);
 * }
 * ```
 */
export type TaskResultView =
  | Readonly<{ status: 'pending'; state: 'queued' | 'leased' | 'completing' | 'cancelling' }>
  | Readonly<{
      status: 'terminal';
      disposition: 'resolved';
      resultDigest: string;
      terminalAt: number;
      adopted: boolean;
      adoptedAt?: number;
      /** Whether the worker reported success or failure. */
      resultStatus: 'completed' | 'failed';
      error?: string;
    }>
  | Readonly<{
      status: 'terminal';
      disposition: 'cancelled' | 'retryExhausted';
      /** Token-safe fence for adopting this exact terminal incarnation. */
      adoptionToken: string;
      terminalAt: number;
      adopted: boolean;
      adoptedAt?: number;
      error?: string;
    }>
  | Readonly<{
      status: 'deadLettered';
      persistenceFailureReason: string;
      pendingStatus: 'completed' | 'failed';
      deadLetteredAt: number;
      error?: string;
    }>;

async function terminalTaskResultView(decoded: RemoteTaskTerminal): Promise<TaskResultView> {
  if (decoded.disposition === 'resolved') {
    return {
      status: 'terminal',
      disposition: decoded.disposition,
      resultDigest: decoded.resultDigest,
      terminalAt: decoded.terminalAt,
      adopted: decoded.adopted,
      ...(decoded.adoptedAt !== undefined ? { adoptedAt: decoded.adoptedAt } : {}),
      resultStatus: decoded.status,
      ...(decoded.error !== undefined ? { error: decoded.error } : {}),
    };
  }

  return {
    status: 'terminal',
    disposition: decoded.disposition,
    adoptionToken: await nonResolvedAdoptionToken(decoded),
    terminalAt: decoded.terminalAt,
    adopted: decoded.adopted,
    ...(decoded.adoptedAt !== undefined ? { adoptedAt: decoded.adoptedAt } : {}),
    ...('error' in decoded ? { error: decoded.error } : {}),
  };
}

function nonResolvedAdoptionToken(decoded: RemoteTaskTerminal): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      createdAt: decoded.createdAt,
      resultDigest: decoded.resultDigest,
    }),
  );
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
// oxlint-disable-next-line typescript/consistent-return -- TypeScript proves this closed discriminated-union switch exhaustive; adding a runtime default creates nondeterministic Bun coverage attribution.
export async function getTaskResultViewImpl(
  storage: Storage,
  operationId: string,
): Promise<TaskResultView | null> {
  const decoded = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
  if (decoded === null) return null;

  switch (decoded.state) {
    case 'queued':
    case 'leased':
    case 'completing':
    case 'cancelling':
      return { status: 'pending', state: decoded.state };
    case 'terminal':
      return await terminalTaskResultView(decoded);
    case 'deadLettered':
      return deadLetteredTaskResultView(decoded);
  }
}

/**
 * Mark a terminal task's result as adopted by the caller — the durable
 * assertion that "the workflow checkpoint (or whatever consumed this
 * result) has incorporated it," per the project brief's adoption/retention
 * split. Returns `true` once adopted, `false` if the record is not
 * currently `terminal`, or the supplied resolved digest/non-resolved
 * adoption token does not match (including a record that no longer exists,
 * e.g. already reaped). The adoption token is a one-way digest of the
 * internal synthetic digest, fencing adoption to the observed incarnation
 * without exposing the attempt token. Idempotent: adopting an already-adopted
 * record succeeds again, refreshing `adoptedAt`.
 */
export async function adoptTaskResultImpl(
  storage: Storage,
  operationId: string,
  adoptionKey: string,
): Promise<boolean> {
  const observed = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
  let expectedResultDigest = adoptionKey;
  if (observed?.state === 'terminal' && observed.disposition !== 'resolved') {
    if ((await nonResolvedAdoptionToken(observed)) !== adoptionKey) return false;
    expectedResultDigest = observed.resultDigest;
  }
  const result = await commitTaskLedgerTransition(
    storage,
    operationId,
    (current, now) => markWorkflowResultAdopted(current, { expectedResultDigest }, now),
    1,
  );
  return result.ok;
}
