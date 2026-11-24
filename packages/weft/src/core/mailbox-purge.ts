/**
 * Removing every durable record of one application command mailbox (WFT-84).
 *
 * A command record keeps the caller's payload inline until retention retires it, so a host that
 * must forget a resource's commands (a deleted chat, for example) cannot wait for retention.
 * This is the one place that knows every key family a mailbox owns, so a family added to
 * `createMailboxKeys` is purged here and nowhere else.
 *
 * @module core/mailbox-purge
 */

import { storageConditionalBatch, storageDeletePrefix } from "../embedded/storage/src/index.ts";
import {
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  MailboxContentionError,
  type MailboxRuntime,
} from './mailbox-internals.ts';
import { headerOperation, loadMailboxHeader } from './mailbox-storage.ts';

/**
 * Delete the command records, delivery and listing indexes, idempotency bindings, terminal
 * retention index and sink probes of one mailbox, seal its header, and answer how many keys went.
 *
 * The header is sealed first, so an admission racing the purge is refused rather than left behind
 * it: an admission commits against the exact header bytes it read, and the seal replaces them. A
 * purge that fails partway leaves a mailbox that a second call finishes: every step lists what is
 * left. A mailbox with nothing stored answers `0`; the seal is not counted.
 */
export async function purgeMailbox(runtime: MailboxRuntime): Promise<number> {
  const { storage, keys } = runtime;
  await sealMailbox(runtime);
  let deleted = 0;
  // The command records hold the payloads; the indexes name command ids and idempotency keys.
  for (const prefix of [
    keys.commandPrefix,
    keys.readyPrefix,
    keys.bySequencePrefix,
    keys.terminalPrefix,
    // The key builder with an empty component is the family's prefix.
    keys.idempotency(''),
    keys.sinkProbe(''),
  ]) {
    deleted += await storageDeletePrefix(storage, prefix);
  }
  return deleted;
}

/**
 * Write the seal over the header this call reads, unless it is sealed already. An admission that
 * commits in between moves the header, so the next attempt seals over that one and the sweep that
 * follows takes its command; as many attempts as any other mailbox transition, then contention.
 */
async function sealMailbox(runtime: MailboxRuntime): Promise<void> {
  const { storage, keys, policy } = runtime;
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const header = await loadMailboxHeader(storage, keys, policy.namespace, policy.resourceId);
    if (header.record.purgedAt !== undefined) return;
    const committed = await storageConditionalBatch(
      storage,
      [{ key: keys.header, expectedValue: header.bytes }],
      [headerOperation(keys, { ...header.record, openCount: 0, purgedAt: runtime.now() })],
    );
    if (committed) return;
  }
  throw new MailboxContentionError('purge', null);
}
