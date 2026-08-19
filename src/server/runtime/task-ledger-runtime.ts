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
 * @module server/runtime/task-ledger-runtime
 */

import { storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import type { TaskLedgerTransitionResult } from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskRecord,
} from '../task-ledger.ts';

export type TaskLedgerCommitResult<T extends RemoteTaskRecord> =
  | Readonly<{ ok: true; record: T }>
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
