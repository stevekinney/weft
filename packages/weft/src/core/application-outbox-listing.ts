/**
 * Bounded, non-consuming listing for the application delivery outbox
 * (WFT-85): walking the sequence-ordered index rather than the delivery
 * records, so `limit` bounds the storage reads and not only the returned
 * slice.
 *
 * @module core/application-outbox-listing
 */

import type {
  ApplicationDeliveryReceipt,
  ApplicationOutboxListOptions,
} from './application-outbox-contract.ts';
import { clampListLimit } from './application-outbox-guards.ts';
import { decodeApplicationDeliveryEntry } from './application-outbox-index-codec.ts';
import {
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import { loadDelivery } from './application-outbox-storage.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** How many listing-index entries one page reads. */
const OUTBOX_LIST_PAGE_SIZE = 200;

/**
 * How many index entries one `list()` call may examine before giving up.
 * Listing is documented as a bounded query, not an exhaustive one.
 */
const OUTBOX_LIST_SCAN_CEILING = 5_000;

/** List receipts in enqueue order, bounded by `limit` and the scan ceiling. */
export async function listDeliveries(
  runtime: OutboxRuntime,
  options: ApplicationOutboxListOptions | undefined,
): Promise<ApplicationDeliveryReceipt[]> {
  const limit = clampListLimit(options?.limit);
  const states = options?.states === undefined ? null : new Set<string>(options.states);
  const receipts: ApplicationDeliveryReceipt[] = [];
  let cursor: string | undefined;
  let examined = 0;
  while (receipts.length < limit && examined < OUTBOX_LIST_SCAN_CEILING) {
    const page = await readListingPage(runtime, cursor, limit - receipts.length, states);
    receipts.push(...page.receipts);
    examined += page.examined;
    cursor = page.cursor;
    if (page.exhausted) break;
  }
  return receipts;
}

async function readListingPage(
  runtime: OutboxRuntime,
  cursor: string | undefined,
  remaining: number,
  states: ReadonlySet<string> | null,
): Promise<{
  receipts: ApplicationDeliveryReceipt[];
  cursor: string | undefined;
  exhausted: boolean;
  examined: number;
}> {
  const receipts: ApplicationDeliveryReceipt[] = [];
  const scanOptions =
    cursor === undefined
      ? { limit: OUTBOX_LIST_PAGE_SIZE }
      : { limit: OUTBOX_LIST_PAGE_SIZE, gt: cursor };
  let seen = 0;
  let nextCursor = cursor;
  for await (const [indexKey, indexValue] of runtime.storage.scan(
    runtime.keys.bySequencePrefix,
    scanOptions,
  )) {
    seen += 1;
    nextCursor = indexKey;
    const deliveryId = decodeApplicationDeliveryEntry(indexValue, indexKey);
    const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
    // An entry whose record is gone is a retention race, not corruption.
    if (loaded === null) continue;
    if (indexKey !== runtime.keys.bySequence(loaded.record.sequence)) {
      throw new PersistedDataCorruptError(indexKey);
    }
    if (states !== null && !states.has(loaded.record.state)) continue;
    receipts.push(toApplicationDeliveryReceipt(loaded.record));
    if (receipts.length >= remaining) break;
  }
  return { receipts, cursor: nextCursor, exhausted: seen < OUTBOX_LIST_PAGE_SIZE, examined: seen };
}
