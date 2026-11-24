import type { Engine } from '../core/engine.ts';
import type { RemoteTaskRecord } from '../core/task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../core/task-ledger/task-ledger.ts';

/** Read the only task-ledger record an end-to-end engine has written, or `null` when it has none. */
export async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}
