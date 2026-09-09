/**
 * Storage access for the application delivery outbox (WFT-85): bound keys,
 * record loads that keep the exact bytes for compare-and-swap, index
 * maintenance, and the transition plan the shared commit executes.
 *
 * @module core/application-outbox-storage
 */

import type { BatchOperation, ConditionalBatchCondition, Storage } from '../storage/interface.ts';
import { encodeStorageKeyComponent, KEYS } from '../storage/interface.ts';
import {
  decodeApplicationDeliveryRecord,
  encodeApplicationDeliveryRecord,
} from './application-outbox-codec.ts';
import type { LoadedDeliveryRecord } from './application-outbox-contract.ts';
import {
  decodeApplicationDeliveryEntry,
  decodeApplicationDeliveryIdempotencyRecord,
  decodeApplicationOutboxRecord,
  encodeApplicationDeliveryEntry,
  encodeApplicationOutboxRecord,
} from './application-outbox-index-codec.ts';
import {
  APPLICATION_OUTBOX_RECORD_VERSION,
  isApplicationDeliveryTerminalState,
  isApplicationDeliveryWaiting,
  type ApplicationDeliveryIdempotencyRecord,
  type ApplicationDeliveryRecord,
  type ApplicationDeliveryTerminalRecord,
  type ApplicationOutboxRecord,
} from './application-outbox-types.ts';
import {
  commitApplicationTransition,
  type ApplicationCommitPlan,
  type ApplicationEventSink,
} from './application-primitive-commit.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

/** Every key builder for one `(namespace, ownerId)` outbox, bound once. */
export type OutboxKeys = Readonly<{
  header: string;
  sinkProbe: (nonce: string) => string;
  deliveryPrefix: string;
  delivery: (deliveryId: string) => string;
  duePrefix: string;
  due: (availableAt: number, deliveryId: string) => string;
  bySequencePrefix: string;
  bySequence: (sequence: number) => string;
  idempotency: (key: string) => string;
  terminalPrefix: string;
  terminal: (terminalAt: number, deliveryId: string) => string;
}>;

/** Bind every outbox storage key to one namespace and owner. */
export function createOutboxKeys(namespace: string, ownerId: string): OutboxKeys {
  return {
    header: KEYS.applicationOutbox(namespace, ownerId),
    sinkProbe: (nonce) => KEYS.applicationOutboxSinkProbe(namespace, ownerId, nonce),
    deliveryPrefix: KEYS.applicationDeliveryPrefix(namespace, ownerId),
    delivery: (deliveryId) => KEYS.applicationDelivery(namespace, ownerId, deliveryId),
    duePrefix: KEYS.applicationDeliveryDuePrefix(namespace, ownerId),
    due: (availableAt, deliveryId) =>
      KEYS.applicationDeliveryDue(namespace, ownerId, availableAt, deliveryId),
    bySequencePrefix: KEYS.applicationDeliveryBySequencePrefix(namespace, ownerId),
    bySequence: (sequence) => KEYS.applicationDeliveryBySequence(namespace, ownerId, sequence),
    idempotency: (key) => KEYS.applicationDeliveryIdempotency(namespace, ownerId, key),
    terminalPrefix: KEYS.applicationDeliveryTerminalPrefix(namespace, ownerId),
    terminal: (terminalAt, deliveryId) =>
      KEYS.applicationDeliveryTerminal(namespace, ownerId, terminalAt, deliveryId),
  };
}

/** The empty header an outbox starts from. */
export function emptyOutboxRecord(namespace: string, ownerId: string): ApplicationOutboxRecord {
  return {
    recordVersion: APPLICATION_OUTBOX_RECORD_VERSION,
    namespace,
    ownerId,
    nextSequence: 0,
    openCount: 0,
    enqueuedCount: 0,
  };
}

/** A header read together with the exact bytes it decoded from. */
export type LoadedOutboxRecord = {
  readonly record: ApplicationOutboxRecord;
  /** `null` when the outbox has never been written. */
  readonly bytes: Uint8Array | null;
};

/**
 * Read the per-outbox header, treating an absent key as a fresh outbox.
 *
 * @throws {PersistedDataCorruptError} When the stored header is malformed.
 */
export async function loadOutboxHeader(
  storage: Storage,
  keys: OutboxKeys,
  namespace: string,
  ownerId: string,
): Promise<LoadedOutboxRecord> {
  const bytes = await storage.get(keys.header);
  if (bytes === null) return { record: emptyOutboxRecord(namespace, ownerId), bytes: null };
  return { record: decodeApplicationOutboxRecord(bytes, keys.header), bytes };
}

/**
 * Read one delivery record with the exact bytes it decoded from.
 *
 * @throws {PersistedDataCorruptError} When the stored record is malformed.
 */
export async function loadDelivery(
  storage: Storage,
  keys: OutboxKeys,
  deliveryId: string,
): Promise<LoadedDeliveryRecord | null> {
  const key = keys.delivery(deliveryId);
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  return { record: decodeApplicationDeliveryRecord(bytes, key), bytes };
}

/**
 * Read the idempotency binding for a retry key.
 *
 * @throws {PersistedDataCorruptError} When the stored binding is malformed.
 */
export async function loadDeliveryIdempotencyBinding(
  storage: Storage,
  keys: OutboxKeys,
  idempotencyKey: string,
): Promise<{
  readonly record: ApplicationDeliveryIdempotencyRecord;
  readonly bytes: Uint8Array;
} | null> {
  const key = keys.idempotency(idempotencyKey);
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  return { record: decodeApplicationDeliveryIdempotencyRecord(bytes, key), bytes };
}

/** One entry of the time-keyed due index. */
export type DueEntry = {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly deliveryId: string;
};

/**
 * Read the earliest entries of the due index.
 *
 * The index is keyed by `availableAt`, so the first entry is the earliest
 * delivery, due or not. The caller decides whether it is claimable now.
 *
 * @throws {PersistedDataCorruptError} When an index entry is malformed, or names a delivery other than the one its key names.
 */
export async function loadDueHead(
  storage: Storage,
  keys: OutboxKeys,
  limit: number,
): Promise<DueEntry[]> {
  const entries: DueEntry[] = [];
  for await (const [key, value] of storage.scan(keys.duePrefix, { limit })) {
    const deliveryId = decodeApplicationDeliveryEntry(value, key);
    // The key names the delivery too. A value that names a different one is
    // not an orphan to tidy away — deleting it would strand the delivery the
    // key belongs to without its only due entry — but corruption to halt on.
    if (!key.endsWith(`:${encodeStorageKeyComponent(deliveryId)}`)) {
      throw new PersistedDataCorruptError(key);
    }
    entries.push({ key, bytes: value, deliveryId });
  }
  return entries;
}

/**
 * Put/delete operations that keep the due and terminal indexes consistent
 * with a record's new state.
 *
 * Unlike the mailbox's FIFO index, the due key embeds `availableAt`, which a
 * reschedule changes: the entry under the previous instant is deleted and one
 * under the new instant is written. A terminal record moving between terminal
 * dispositions (an operator dead-letter of a parked delivery) likewise moves
 * its retention entry to its new `terminalAt`.
 */
export function indexOperationsFor(
  keys: OutboxKeys,
  previous: ApplicationDeliveryRecord | null,
  next: ApplicationDeliveryRecord,
): BatchOperation[] {
  return [
    ...dueIndexOperations(keys, previous, next),
    ...terminalIndexOperations(keys, previous, next),
  ];
}

/** Move an index entry from `before` to `after`, either of which may be absent. */
function moveIndexEntry(
  before: string | null,
  after: string | null,
  deliveryId: string,
): BatchOperation[] {
  if (before === after) return [];
  const operations: BatchOperation[] = [];
  if (before !== null) operations.push({ type: 'delete', key: before });
  if (after !== null) {
    operations.push({ type: 'put', key: after, value: encodeApplicationDeliveryEntry(deliveryId) });
  }
  return operations;
}

function dueIndexOperations(
  keys: OutboxKeys,
  previous: ApplicationDeliveryRecord | null,
  next: ApplicationDeliveryRecord,
): BatchOperation[] {
  const before =
    previous !== null && isApplicationDeliveryWaiting(previous)
      ? keys.due(previous.availableAt, previous.deliveryId)
      : null;
  const after = isApplicationDeliveryWaiting(next)
    ? keys.due(next.availableAt, next.deliveryId)
    : null;
  return moveIndexEntry(before, after, next.deliveryId);
}

function terminalIndexOperations(
  keys: OutboxKeys,
  previous: ApplicationDeliveryRecord | null,
  next: ApplicationDeliveryRecord,
): BatchOperation[] {
  const before =
    previous !== null && isTerminalRecord(previous)
      ? keys.terminal(previous.terminalAt, previous.deliveryId)
      : null;
  const after = isTerminalRecord(next) ? keys.terminal(next.terminalAt, next.deliveryId) : null;
  return moveIndexEntry(before, after, next.deliveryId);
}

function isTerminalRecord(
  record: ApplicationDeliveryRecord,
): record is ApplicationDeliveryTerminalRecord {
  return isApplicationDeliveryTerminalState(record.state);
}

/**
 * Commit one outbox transition, atomically with its fleet event when a sink is
 * configured. The outbox's binding of the shared commit.
 */
export function commitOutboxTransition(
  storage: Storage,
  events: ApplicationEventSink | undefined,
  plan: ApplicationCommitPlan,
): Promise<boolean> {
  return commitApplicationTransition(storage, events, plan, 'application outbox');
}

/**
 * Persist a delivery record plus its index maintenance as one plan.
 *
 * `expectedBytes` must be the exact bytes the record was read as, never a
 * re-encoding of the decoded value.
 */
export function planDeliveryTransition(
  keys: OutboxKeys,
  options: {
    readonly previous: ApplicationDeliveryRecord | null;
    readonly expectedBytes: Uint8Array | null;
    readonly next: ApplicationDeliveryRecord;
    readonly event: { readonly kind: string; readonly payload: unknown } | null;
    readonly now: number;
    readonly extraConditions?: readonly ConditionalBatchCondition[] | undefined;
    readonly extraOperations?: readonly BatchOperation[] | undefined;
  },
): ApplicationCommitPlan {
  return {
    sinkProbeKey: keys.sinkProbe(crypto.randomUUID()),
    conditions: [
      { key: keys.delivery(options.next.deliveryId), expectedValue: options.expectedBytes },
      ...(options.extraConditions ?? []),
    ],
    operations: [
      {
        type: 'put',
        key: keys.delivery(options.next.deliveryId),
        value: encodeApplicationDeliveryRecord(options.next),
      },
      ...indexOperationsFor(keys, options.previous, options.next),
      ...(options.extraOperations ?? []),
    ],
    event: options.event,
    now: options.now,
  };
}

/** The put operation that advances the outbox header. */
export function headerOperation(keys: OutboxKeys, record: ApplicationOutboxRecord): BatchOperation {
  return { type: 'put', key: keys.header, value: encodeApplicationOutboxRecord(record) };
}
