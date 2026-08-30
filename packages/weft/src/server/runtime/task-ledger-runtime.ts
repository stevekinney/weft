/**
 * Shared commit loop for the durable remote task ledger's live dispatch path
 * (WFT-22) — claim, heartbeat, completion, and requeue all attempt a single
 * pure transition against the current ledger record through
 * `storage.conditionalBatch`, retrying only when the compare-and-swap itself
 * is lost (a concurrent writer changed the record between read and write),
 * never when the transition's own precondition rejects the freshly re-read
 * record. A precondition rejection means the requested transition genuinely
 * does not apply — for example the task is already terminal — and retrying
 * the same rejected transition would just reject again.
 *
 * `commitTaskLedgerDelete` (WFT-24) is the delete counterpart, used by
 * terminal-task retention: a conditional delete gated on a precondition
 * function rather than a transition function, since deletion has no next
 * record to write.
 *
 * @module server/runtime/task-ledger-runtime
 */

import { storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import type {
  TaskLedgerPreconditionResult,
  TaskLedgerTransitionResult,
} from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskRecord,
} from '../task-ledger.ts';

export type TaskLedgerCommitResult<T extends RemoteTaskRecord> =
  | Readonly<{ ok: true; record: T }>
  | Readonly<{ ok: false; reason: string }>;

export type TaskLedgerDeleteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Read the current ledger record, apply `transitionFn`, and commit the
 * result with `expectedValue` set to the exact bytes just read — CAS by raw
 * byte equality, not `encode(decode(bytes))` re-serialization (see
 * `task-ledger-transitions.ts`'s module doc comment).
 *
 * Retries only a lost CAS (up to `maxAttempts`), re-reading and
 * re-evaluating `transitionFn` against the fresh record each time — a
 * concurrent heartbeat renewal, for instance, is a benign generation bump
 * worth retrying past. A `transitionFn` precondition rejection returns
 * immediately without consuming a retry, since the fresh record already
 * reflects reality and re-attempting the identical transition cannot change
 * the outcome.
 */
export async function commitTaskLedgerTransition<T extends RemoteTaskRecord>(
  storage: Storage,
  operationId: string,
  transitionFn: (current: RemoteTaskRecord | null, now: number) => TaskLedgerTransitionResult<T>,
  maxAttempts = 1,
): Promise<TaskLedgerCommitResult<T>> {
  // storageConditionalBatch re-checks the capability on every call; serve()
  // already fails fast at attachment when it is absent (see src/server/index.ts).
  const key = taskLedgerKey(operationId);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rawExisting = await storage.get(key);
    const current = decodeRemoteTaskRecord(rawExisting);
    const result = transitionFn(current, Date.now());
    if (!result.ok) return result;

    const committed = await storageConditionalBatch(
      storage,
      [{ key, expectedValue: rawExisting }],
      [{ type: 'put', key, value: encodeRemoteTaskRecord(result.nextRecord) }],
    );
    if (committed) return { ok: true, record: result.nextRecord };
    // Lost the CAS — another writer changed the record. Retry against fresh state.
  }

  return {
    ok: false,
    reason: `lost the compare-and-swap race on operation "${operationId}" after ${String(maxAttempts)} attempt(s)`,
  };
}

/**
 * Read the current ledger record, check a delete-only precondition (WFT-24
 * retention: {@link canDeleteRetainedTerminalTask}), and conditionally delete
 * with `expectedValue` set to the exact bytes just read — the delete
 * counterpart to {@link commitTaskLedgerTransition}, needed because
 * `canDeleteRetainedTerminalTask` has no next record to write, only a
 * precondition to satisfy before issuing a delete.
 *
 * Retries only a lost CAS, same as `commitTaskLedgerTransition` — a
 * concurrent writer that changed the record between read and delete (for
 * example a later adoption call bumping `retentionGeneration`) means the
 * fresh record deserves a fresh precondition check, not a delete of state
 * the caller never actually observed.
 */
export async function commitTaskLedgerDelete(
  storage: Storage,
  operationId: string,
  preconditionFn: (current: RemoteTaskRecord | null) => TaskLedgerPreconditionResult,
  maxAttempts = 1,
): Promise<TaskLedgerDeleteResult> {
  const key = taskLedgerKey(operationId);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rawExisting = await storage.get(key);
    const current = decodeRemoteTaskRecord(rawExisting);
    const result = preconditionFn(current);
    if (!result.ok) return result;

    const committed = await storageConditionalBatch(
      storage,
      [{ key, expectedValue: rawExisting }],
      [{ type: 'delete', key }],
    );
    if (committed) return { ok: true };
    // Lost the CAS — another writer changed the record. Retry against fresh state.
  }

  return {
    ok: false,
    reason: `lost the compare-and-swap race deleting operation "${operationId}" after ${String(maxAttempts)} attempt(s)`,
  };
}
