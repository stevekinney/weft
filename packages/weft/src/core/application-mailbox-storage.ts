/**
 * Durable reads, index maintenance, and the atomic state-plus-event commit for
 * the application command mailbox (WFT-84).
 *
 * Every mutation goes through {@link commitMailboxTransition}. When the mailbox
 * was built with an event sink, the caller's state operations and the sink's own
 * event write land in one `conditionalBatch`, so no restart can expose the state
 * transition without its event or the other way round. Without a sink the same
 * operations commit through `storageConditionalBatch` directly, which keeps the
 * atomicity guarantee and makes a lost compare-and-swap exactly detectable.
 *
 * @module core/application-mailbox-storage
 */

import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from '../storage/interface.ts';
import {
  decodeApplicationCommandIdempotencyRecord,
  decodeApplicationCommandRecord,
  decodeApplicationMailboxRecord,
  decodeApplicationReadyEntry,
  encodeApplicationCommandRecord,
  encodeApplicationMailboxRecord,
  encodeApplicationReadyEntry,
} from './application-mailbox-codec.ts';
import type {
  ApplicationMailboxEventSink,
  LoadedCommandRecord,
} from './application-mailbox-contract.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  type ApplicationCommandIdempotencyRecord,
  type ApplicationCommandRecord,
  type ApplicationCommandTerminalRecord,
  type ApplicationMailboxRecord,
} from './application-mailbox-types.ts';

/** Every key builder for one `(namespace, resourceId)` mailbox, bound once. */
export type MailboxKeys = Readonly<{
  header: string;
  sinkProbe: (nonce: string) => string;
  commandPrefix: string;
  command: (commandId: string) => string;
  readyPrefix: string;
  ready: (sequence: number) => string;
  bySequencePrefix: string;
  bySequence: (sequence: number) => string;
  idempotency: (key: string) => string;
  terminalPrefix: string;
  terminal: (terminalAt: number, commandId: string) => string;
}>;

/**
 * Bind every mailbox storage key to one namespace and resource.
 */
export function createMailboxKeys(namespace: string, resourceId: string): MailboxKeys {
  return {
    header: KEYS.applicationMailbox(namespace, resourceId),
    sinkProbe: (nonce) => KEYS.applicationMailboxSinkProbe(namespace, resourceId, nonce),
    commandPrefix: KEYS.applicationCommandPrefix(namespace, resourceId),
    command: (commandId) => KEYS.applicationCommand(namespace, resourceId, commandId),
    readyPrefix: KEYS.applicationCommandReadyPrefix(namespace, resourceId),
    ready: (sequence) => KEYS.applicationCommandReady(namespace, resourceId, sequence),
    bySequencePrefix: KEYS.applicationCommandBySequencePrefix(namespace, resourceId),
    bySequence: (sequence) => KEYS.applicationCommandBySequence(namespace, resourceId, sequence),
    idempotency: (key) => KEYS.applicationCommandIdempotency(namespace, resourceId, key),
    terminalPrefix: KEYS.applicationCommandTerminalPrefix(namespace, resourceId),
    terminal: (terminalAt, commandId) =>
      KEYS.applicationCommandTerminal(namespace, resourceId, terminalAt, commandId),
  };
}

/** The empty header a mailbox starts from, so a first admission has something to compare against. */
export function emptyMailboxRecord(
  namespace: string,
  resourceId: string,
): ApplicationMailboxRecord {
  return {
    recordVersion: APPLICATION_MAILBOX_RECORD_VERSION,
    namespace,
    resourceId,
    nextSequence: 0,
    openCount: 0,
    admittedCount: 0,
  };
}

/** A header read together with the exact bytes it decoded from, for compare-and-swap. */
export type LoadedMailboxRecord = {
  readonly record: ApplicationMailboxRecord;
  /** `null` when the mailbox has never been written — the condition for a first admission. */
  readonly bytes: Uint8Array | null;
};

/**
 * Read the per-mailbox header, treating an absent key as a fresh mailbox.
 *
 * @throws {PersistedDataCorruptError} When the stored header is malformed.
 */
export async function loadMailboxHeader(
  storage: Storage,
  keys: MailboxKeys,
  namespace: string,
  resourceId: string,
): Promise<LoadedMailboxRecord> {
  const bytes = await storage.get(keys.header);
  if (bytes === null) return { record: emptyMailboxRecord(namespace, resourceId), bytes: null };
  return { record: decodeApplicationMailboxRecord(bytes, keys.header), bytes };
}

/**
 * Read one command record with the exact bytes it decoded from.
 *
 * @throws {PersistedDataCorruptError} When the stored record is malformed.
 */
export async function loadCommand(
  storage: Storage,
  keys: MailboxKeys,
  commandId: string,
): Promise<LoadedCommandRecord | null> {
  const key = keys.command(commandId);
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  return { record: decodeApplicationCommandRecord(bytes, key), bytes };
}

/**
 * Read the idempotency binding for a retry key.
 *
 * @throws {PersistedDataCorruptError} When the stored binding is malformed.
 */
export async function loadIdempotencyBinding(
  storage: Storage,
  keys: MailboxKeys,
  idempotencyKey: string,
): Promise<{
  readonly record: ApplicationCommandIdempotencyRecord;
  readonly bytes: Uint8Array;
} | null> {
  const key = keys.idempotency(idempotencyKey);
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  return { record: decodeApplicationCommandIdempotencyRecord(bytes, key), bytes };
}

/**
 * Read the FIFO head: the lowest-sequence entry still in the delivery index.
 *
 * Strict FIFO is the mailbox's ordering contract, so the head is the only entry
 * a claim may consider. A later command never overtakes a delayed head.
 *
 * @throws {PersistedDataCorruptError} When an index entry is malformed.
 */
export async function loadDeliveryHead(
  storage: Storage,
  keys: MailboxKeys,
): Promise<{
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly commandId: string;
} | null> {
  for await (const [key, value] of storage.scan(keys.readyPrefix, { limit: 1 })) {
    return { key, bytes: value, commandId: decodeApplicationReadyEntry(value, key) };
  }
  return null;
}

/**
 * Put/delete operations that keep the delivery and terminal indexes consistent
 * with a record's new state.
 *
 * The delivery entry is keyed by the command's original admission sequence, so
 * a redelivered command re-enters the queue at the position it was first
 * admitted to rather than at the back.
 */
export function indexOperationsFor(
  keys: MailboxKeys,
  previous: ApplicationCommandRecord | null,
  next: ApplicationCommandRecord,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  const wasWaiting = previous !== null && isWaitingState(previous);
  const willWait = isWaitingState(next);
  if (wasWaiting && !willWait) {
    operations.push({ type: 'delete', key: keys.ready(next.sequence) });
  }
  if (willWait && !wasWaiting) {
    operations.push({
      type: 'put',
      key: keys.ready(next.sequence),
      value: encodeApplicationReadyEntry(next.commandId),
    });
  }
  if (isTerminalState(next) && (previous === null || !isTerminalState(previous))) {
    operations.push({
      type: 'put',
      key: keys.terminal(next.terminalAt, next.commandId),
      value: encodeApplicationReadyEntry(next.commandId),
    });
  }
  return operations;
}

/** Whether a record is in the delivery index: admitted or released, not yet claimed or settled. */
export function isWaitingState(record: ApplicationCommandRecord): boolean {
  return record.state === 'accepted' || record.state === 'available';
}

function isTerminalState(
  record: ApplicationCommandRecord,
): record is ApplicationCommandTerminalRecord {
  return (
    record.state === 'applied' ||
    record.state === 'rejected' ||
    record.state === 'cancelled' ||
    record.state === 'dead-lettered'
  );
}

/**
 * Whether every compare-and-swap condition still matches durable state.
 *
 * Used to classify a failed event-sink append: if the caller's own conditions
 * still hold, the append failed for the feed's own reasons and the error must
 * propagate; if one moved, another actor won the race and the caller retries.
 */
export async function conditionsStillHold(
  storage: Storage,
  conditions: readonly ConditionalBatchCondition[],
): Promise<boolean> {
  for (const condition of conditions) {
    const current = await storage.get(condition.key);
    if (condition.expectedValue === null) {
      if (current !== null) return false;
      continue;
    }
    if (current === null || !bytesEqual(current, condition.expectedValue)) return false;
  }
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** One durable state transition, optionally paired with the fleet event that describes it. */
export type MailboxCommitPlan = {
  readonly conditions: readonly ConditionalBatchCondition[];
  readonly operations: readonly BatchOperation[];
  readonly event: { readonly kind: string; readonly payload: unknown } | null;
  readonly now: number;
  /**
   * Where the first commit through an event sink writes its verification
   * probe. Unique per plan, so a concurrent transition on the record can never
   * be mistaken for a sink that committed somewhere else.
   */
  readonly sinkProbeKey: string;
};

/**
 * Commit one transition, atomically with its fleet event when a sink is
 * configured.
 *
 * Returns `false` when a compare-and-swap condition was lost, which means
 * another actor transitioned the record first and the caller should re-read and
 * re-decide. Any other failure throws.
 */
export async function commitMailboxTransition(
  storage: Storage,
  events: ApplicationMailboxEventSink | undefined,
  plan: MailboxCommitPlan,
): Promise<boolean> {
  if (events === undefined || plan.event === null) {
    return storageConditionalBatch(storage, [...plan.conditions], [...plan.operations]);
  }
  // A sink is only allowed to commit against THIS mailbox's storage. A feed
  // built over a different backend would apply these operations there and
  // report success, so `admit()` would hand back a durable-looking receipt that
  // never existed here. The first commit through a sink carries a single-use
  // probe key that is read back afterwards: unlike the record itself, nothing
  // else ever writes that key, so a concurrent transition on the record between
  // the commit and the read cannot be mistaken for a sink that committed
  // elsewhere — which would otherwise fail a keyless admission into a retry
  // that creates a second command.
  const probe = isSinkVerified(storage, events)
    ? null
    : { key: plan.sinkProbeKey, value: new TextEncoder().encode(plan.sinkProbeKey) };
  try {
    await events.append(
      { kind: plan.event.kind, emittedAtMs: plan.now, payload: plan.event.payload },
      {
        conditions: plan.conditions,
        operations:
          probe === null
            ? plan.operations
            : [...plan.operations, { type: 'put', key: probe.key, value: probe.value }],
      },
    );
  } catch (error) {
    // The feed retries its own sequence allocation internally and only throws
    // once it has exhausted those attempts. That exhaustion is indistinguishable
    // from our record condition being lost, so re-read the conditions we own: if
    // they still hold, the failure was genuinely the feed's and must propagate.
    if (await conditionsStillHold(storage, plan.conditions)) throw error;
    return false;
  }
  // Outside the catch above on purpose. A missing probe after a successful
  // append is unambiguous — the batch did not land here — and must never be
  // reported as a lost compare-and-swap for the caller to retry.
  if (probe !== null) await assertSinkCommittedLocally(storage, events, probe);
  return true;
}

/**
 * Storage backends already proven to receive an event sink's committed writes.
 *
 * The check runs once per backend rather than per transition: a sink that
 * commits to the right place once will keep doing so, and a misconfiguration is
 * a construction-time mistake that shows up on the very first commit.
 */
const VERIFIED_SINK_BACKENDS = new WeakMap<ApplicationMailboxEventSink, WeakSet<Storage>>();

/**
 * Keyed by the sink AND the backend. Keying by backend alone would let one
 * correctly configured mailbox mark a store verified, after which a second
 * mailbox on the same store with a feed over a DIFFERENT store would skip the
 * check entirely and report durable-looking admissions that never landed here.
 */
function verifiedBackendsFor(events: ApplicationMailboxEventSink): WeakSet<Storage> {
  let verified = VERIFIED_SINK_BACKENDS.get(events);
  if (verified === undefined) {
    verified = new WeakSet();
    VERIFIED_SINK_BACKENDS.set(events, verified);
  }
  return verified;
}

function isSinkVerified(storage: Storage, events: ApplicationMailboxEventSink): boolean {
  return verifiedBackendsFor(events).has(storage);
}

async function assertSinkCommittedLocally(
  storage: Storage,
  events: ApplicationMailboxEventSink,
  probe: { readonly key: string; readonly value: Uint8Array },
): Promise<void> {
  const stored = await storage.get(probe.key);
  if (stored === null || !bytesEqual(stored, probe.value)) {
    throw new Error(
      'The configured application mailbox event sink committed to a different storage backend than the mailbox. Build the fleet event feed over the same Storage instance the mailbox uses.',
    );
  }
  verifiedBackendsFor(events).add(storage);
  // The probe has done its job and the batch that wrote it is durable either
  // way, so cleanup is best-effort: a transient delete failure must not turn a
  // committed operation into a rejection the caller would retry — for a keyless
  // admission that retry would create a second command.
  try {
    await storage.delete(probe.key);
  } catch {
    // Left behind. It is inert, unique to this plan, and never read again.
  }
}

/**
 * Persist a command record plus its index maintenance as one plan.
 *
 * `expectedBytes` must be the exact bytes the record was read as — not a
 * re-encoding of the decoded value, which `conditionalBatch`'s whole-value byte
 * comparison would reject.
 */
export function planCommandTransition(
  keys: MailboxKeys,
  options: {
    readonly previous: ApplicationCommandRecord | null;
    readonly expectedBytes: Uint8Array | null;
    readonly next: ApplicationCommandRecord;
    readonly event: { readonly kind: string; readonly payload: unknown } | null;
    readonly now: number;
    readonly extraConditions?: readonly ConditionalBatchCondition[] | undefined;
    readonly extraOperations?: readonly BatchOperation[] | undefined;
  },
): MailboxCommitPlan {
  return {
    sinkProbeKey: keys.sinkProbe(crypto.randomUUID()),
    conditions: [
      { key: keys.command(options.next.commandId), expectedValue: options.expectedBytes },
      ...(options.extraConditions ?? []),
    ],
    operations: [
      {
        type: 'put',
        key: keys.command(options.next.commandId),
        value: encodeApplicationCommandRecord(options.next),
      },
      ...indexOperationsFor(keys, options.previous, options.next),
      ...(options.extraOperations ?? []),
    ],
    event: options.event,
    now: options.now,
  };
}

/** The put operation that advances the mailbox header. */
export function headerOperation(
  keys: MailboxKeys,
  record: ApplicationMailboxRecord,
): BatchOperation {
  return { type: 'put', key: keys.header, value: encodeApplicationMailboxRecord(record) };
}
