/**
 * Reading a mailbox without consuming it: the sequence-ordered listing and the
 * lookup by idempotency key. Split from `mailbox.ts` so the class stays a thin
 * surface over its operations.
 */

import type { ApplicationCommandReceipt } from './mailbox-contract.ts';
import { decodeApplicationReadyEntry } from './mailbox-index-codec.ts';
import { type MailboxRuntime, toApplicationCommandReceipt } from './mailbox-internals.ts';
import { loadCommand, loadIdempotencyBinding } from './mailbox-storage.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** How many listing-index entries one page of `list()` reads. */
const MAILBOX_LIST_PAGE_SIZE = 200;

/**
 * How many index entries one `list()` call may examine before giving up.
 *
 * `limit` bounds the work only when enough records match. A narrow filter such as
 * `{ limit: 1, states: ['claimed'] }` against a mailbox full of terminal records
 * would otherwise walk every entry and load every record to return an empty
 * array. Listing is documented as a bounded query, not an exhaustive one: it
 * returns what it found within this ceiling.
 */
const MAILBOX_LIST_SCAN_CEILING = 5_000;

/** A validated listing request: see `MailboxListOptions`. */
export type CommandListingRequest = {
  readonly limit: number;
  readonly states: ReadonlySet<string> | null;
  /** The index key to resume after, when the caller passed `afterSequence`. */
  readonly afterCursor: string | undefined;
  /** Newest first; the cursor then resumes toward older entries. */
  readonly reverse: boolean;
};

/**
 * List receipts, bounded and non-consuming. Walks the sequence index, not the
 * command records: records are keyed by minted id and so scan in arbitrary
 * order, which would force reading and sorting the whole mailbox to answer
 * even `limit: 1`. The index is already in FIFO order, so `limit` bounds the
 * storage reads and the allocation rather than only the returned slice.
 */
export async function listCommandReceipts(
  runtime: MailboxRuntime,
  request: CommandListingRequest,
): Promise<ApplicationCommandReceipt[]> {
  const receipts: ApplicationCommandReceipt[] = [];
  let cursor = request.afterCursor;
  let examined = 0;
  while (receipts.length < request.limit && examined < MAILBOX_LIST_SCAN_CEILING) {
    const page = await readListingPage(
      runtime,
      cursor,
      request.limit - receipts.length,
      request.states,
      request.reverse,
    );
    receipts.push(...page.receipts);
    examined += page.examined;
    cursor = page.cursor;
    if (page.exhausted) break;
  }
  return receipts;
}

/**
 * The receipt of the command admitted under `idempotencyKey`, or `null` when
 * no command the mailbox still holds was admitted under it: the key was never
 * used, or its command has been retired by retention. A direct read through
 * the key's binding, never a walk of the listing index.
 *
 * @throws {PersistedDataCorruptError} When the binding names a command that
 * does not carry the key.
 */
export async function loadReceiptByIdempotencyKey(
  runtime: MailboxRuntime,
  idempotencyKey: string,
): Promise<ApplicationCommandReceipt | null> {
  const binding = await loadIdempotencyBinding(runtime.storage, runtime.keys, idempotencyKey);
  if (binding === null) return null;
  const loaded = await loadCommand(runtime.storage, runtime.keys, binding.record.commandId);
  // A binding whose command retention retired is spent, not an answer.
  if (loaded === null) return null;
  if (loaded.record.idempotencyKey !== idempotencyKey) {
    throw new PersistedDataCorruptError(runtime.keys.idempotency(idempotencyKey));
  }
  return toApplicationCommandReceipt(loaded.record);
}

/** One bounded page of the sequence-ordered listing index. */
async function readListingPage(
  runtime: MailboxRuntime,
  cursor: string | undefined,
  remaining: number,
  states: ReadonlySet<string> | null,
  reverse: boolean,
): Promise<{
  receipts: ApplicationCommandReceipt[];
  cursor: string | undefined;
  exhausted: boolean;
  examined: number;
}> {
  const receipts: ApplicationCommandReceipt[] = [];
  const scanOptions = {
    limit: MAILBOX_LIST_PAGE_SIZE,
    reverse,
    ...(cursor === undefined ? {} : reverse ? { lt: cursor } : { gt: cursor }),
  };
  let seen = 0;
  let nextCursor = cursor;
  for await (const [indexKey, indexValue] of runtime.storage.scan(
    runtime.keys.bySequencePrefix,
    scanOptions,
  )) {
    seen += 1;
    nextCursor = indexKey;
    const commandId = decodeApplicationReadyEntry(indexValue, indexKey);
    const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
    // An index entry whose record is already gone is a retention race, not
    // corruption: the sweep deletes the record and the entry together, and a
    // concurrent listing can observe the moment between.
    if (loaded === null) continue;
    // The entry must be the one the record's own sequence names; a stale or
    // corrupted entry elsewhere would list the command at the wrong position
    // and again at its real one.
    if (indexKey !== runtime.keys.bySequence(loaded.record.sequence)) {
      throw new PersistedDataCorruptError(indexKey);
    }
    if (states !== null && !states.has(loaded.record.state)) continue;
    receipts.push(toApplicationCommandReceipt(loaded.record));
    if (receipts.length >= remaining) break;
  }
  return {
    receipts,
    cursor: nextCursor,
    exhausted: seen < MAILBOX_LIST_PAGE_SIZE,
    examined: seen,
  };
}
