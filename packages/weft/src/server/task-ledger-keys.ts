/**
 * Canonical storage key for the durable remote task ledger (WFT-25).
 *
 * One current-state key is authoritative per operation. `operationId` is
 * caller-controlled (it flows from `TaskDispatch.operationId`), so it is
 * encoded through {@link encodeStorageKeyComponent} the same way every other
 * hostile key component in this codebase is — see `signalStorageKey` in
 * `storage/interface.ts` for the established precedent.
 *
 * @module server/task-ledger-keys
 */

import { encodeStorageKeyComponent } from '../storage/interface.ts';

const TASK_LEDGER_KEY_PREFIX = 'task-ledger:';

/** The single authoritative current-state key for one operation's task record. */
export function taskLedgerKey(operationId: string): string {
  return `${TASK_LEDGER_KEY_PREFIX}${encodeStorageKeyComponent(operationId)}`;
}
