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

import { encodeStorageKeyComponent } from '../../storage/interface.ts';

const TASK_LEDGER_KEY_PREFIX = 'task-ledger:';

/**
 * The single authoritative current-state key for one operation's task record.
 *
 * The durable task ledger keeps exactly one current-state record per
 * operation, and this derives its storage key. Because the operation id is
 * encoded rather than concatenated raw, an id containing a separator cannot
 * collide with a neighbouring record's key.
 *
 * Reach for this when you inspect or repair the ledger through the storage
 * interface directly — a diagnostic tool, a migration — rather than through
 * the engine.
 *
 * @example
 * ```ts
 * import { taskLedgerKey } from '@lostgradient/weft';
 *
 * const key = taskLedgerKey('order-4417');
 * console.log(key); // 'task-ledger:order-4417'
 * ```
 */
export function taskLedgerKey(operationId: string): string {
  return `${TASK_LEDGER_KEY_PREFIX}${encodeStorageKeyComponent(operationId)}`;
}
