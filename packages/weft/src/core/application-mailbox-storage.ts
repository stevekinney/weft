/**
 * Durable reads, index maintenance, and the atomic state-plus-event commit for
 * the application command mailbox (WFT-84).
 *
 * Every mutation goes through {@link commitMailboxTransition}, the mailbox's binding
 * of the shared `commitApplicationTransition`. When the mailbox
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
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from '../storage/interface.ts';
import {
  decodeApplicationCommandRecord,
  encodeApplicationCommandRecord,
} from './application-mailbox-codec.ts';
import type { LoadedCommandRecord } from './application-mailbox-contract.ts';
import {
  decodeApplicationCommandIdempotencyRecord,
  decodeApplicationMailboxRecord,
  decodeApplicationReadyEntry,
  encodeApplicationMailboxRecord,
  encodeApplicationReadyEntry,
} from './application-mailbox-index-codec.ts';
import {
  APPLICATION_MAILBOX_RECORD_VERSION,
  type ApplicationCommandIdempotencyRecord,
  type ApplicationCommandRecord,
  type ApplicationCommandTerminalRecord,
  type ApplicationMailboxRecord,
} from './application-mailbox-types.ts';
import {
  commitApplicationTransition,
  type ApplicationCommitPlan,
  type ApplicationEventSink,
} from './application-primitive-commit.ts';

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
 * Commit one mailbox transition, atomically with its fleet event when a sink is
 * configured. The mailbox's binding of the shared commit: see
 * `application-primitive-commit.ts` for the compare-and-swap classification and
 * the sink probe.
 */
export function commitMailboxTransition(
  storage: Storage,
  events: ApplicationEventSink | undefined,
  plan: ApplicationCommitPlan,
): Promise<boolean> {
  return commitApplicationTransition(storage, events, plan, 'application mailbox');
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
): ApplicationCommitPlan {
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
