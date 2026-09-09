/**
 * Storage key builders for the durable application delivery outbox (WFT-85).
 *
 * Spread into `KEYS` in `interface.ts` rather than declared there, so the
 * outbox keyspace can carry its full rationale without pushing that file past
 * its documented line ceiling. Callers still reach these through `KEYS`.
 *
 * Every key is scoped by an opaque `(namespace, ownerId)` pair. Weft never
 * interprets either component, and no key here overlaps the mailbox, workflow,
 * schedule, or worker-protocol keyspaces.
 *
 * @module storage/application-outbox-keys
 */

import { encodeStorageKeyComponent, formatSortableStorageTimestamp } from './key-encoding.ts';

/**
 * Outbox header, delivery record, time-keyed due index, sequence-ordered
 * listing index, idempotency binding, terminal-retention index, and sink-probe
 * keys.
 *
 * Spread into `KEYS`; not intended to be imported directly by outbox code.
 */
export const APPLICATION_OUTBOX_KEYS = {
  /**
   * The durable outbox header for one `(namespace, ownerId)` delivery outbox:
   * the listing sequence allocator plus the open-backlog counter that enqueue
   * backpressure reads. One key per outbox, so enqueue and terminal transitions
   * serialize against each other per outbox rather than globally.
   */
  applicationOutbox: (namespace: string, ownerId: string) =>
    `appobx:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}`,
  /**
   * A single-use probe an event sink writes in the first commit it makes for an
   * outbox, read back from the outbox's own storage. Its presence proves the
   * sink committed here rather than to some other backend; it is deleted as
   * soon as it has been observed.
   */
  applicationOutboxSinkProbe: (namespace: string, ownerId: string, nonce: string) =>
    `appprobe:v1:outbox:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:${encodeStorageKeyComponent(nonce)}`,
  /** Scan prefix for every canonical delivery record in one outbox. */
  applicationDeliveryPrefix: (namespace: string, ownerId: string) =>
    `appdlv:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:`,
  /**
   * The one authoritative record for a delivery. Every transition proves the
   * expected prior bytes through `storage.conditionalBatch`, so this key is the
   * delivery's compare-and-swap fence.
   */
  applicationDelivery: (namespace: string, ownerId: string, deliveryId: string) =>
    `appdlv:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:${encodeStorageKeyComponent(deliveryId)}`,
  /** Scan prefix for an outbox's time-keyed due index. */
  applicationDeliveryDuePrefix: (namespace: string, ownerId: string) =>
    `appdue:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:`,
  /**
   * The due index, keyed by the instant a delivery becomes claimable and then
   * by its id. Unlike the mailbox's FIFO index this is TIME-keyed: deliveries
   * are independent of one another, so a retry scheduled for later must not
   * hold back one queued for now.
   */
  applicationDeliveryDue: (
    namespace: string,
    ownerId: string,
    availableAt: number,
    deliveryId: string,
  ) =>
    `appdue:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:${formatSortableStorageTimestamp(availableAt)}:${encodeStorageKeyComponent(deliveryId)}`,
  /**
   * Maps an idempotency key to the delivery id enqueued for it. Written in the
   * same conditional batch as the delivery record, gated on this key being
   * absent, so concurrent same-key enqueues converge on one delivery. Retained
   * past terminal so a post-terminal retry resolves the original receipt.
   */
  applicationDeliveryIdempotency: (namespace: string, ownerId: string, key: string) =>
    `appdidem:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:${encodeStorageKeyComponent(key)}`,
  /** Scan prefix for an outbox's full sequence-ordered listing index. */
  applicationDeliveryBySequencePrefix: (namespace: string, ownerId: string) =>
    `appdseq:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:`,
  /**
   * Every delivery in the outbox, ordered by enqueue sequence. Distinct from
   * the due index, which holds only the claimable subset; a delivery stays here
   * until retention retires it, so bounded listing has an index covering every
   * state.
   */
  applicationDeliveryBySequence: (namespace: string, ownerId: string, sequence: number) =>
    `appdseq:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:${formatSortableStorageTimestamp(sequence)}`,
  /** Scan prefix for an outbox's terminal-receipt retention index. */
  applicationDeliveryTerminalPrefix: (namespace: string, ownerId: string) =>
    `appdterm:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:`,
  /**
   * Terminal-receipt retention index, sorted by the time the delivery reached
   * a terminal disposition so retention sweeps delete the oldest bounded batch
   * first.
   */
  applicationDeliveryTerminal: (
    namespace: string,
    ownerId: string,
    terminalAt: number,
    deliveryId: string,
  ) =>
    `appdterm:v1:${encodeStorageKeyComponent(namespace)}:${encodeStorageKeyComponent(ownerId)}:${formatSortableStorageTimestamp(terminalAt)}:${encodeStorageKeyComponent(deliveryId)}`,
} as const;
