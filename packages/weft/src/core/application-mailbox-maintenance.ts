/**
 * The bounded maintenance pass for the application command mailbox (WFT-84).
 *
 * Maintenance is the only thing that advances time-driven work: releasing a
 * delayed command, reclaiming an expired lease at its original FIFO position,
 * dead-lettering a command past its absolute deadline, and retiring terminal
 * receipts past their retention window. Nothing here runs on a hidden timer — a
 * host with `backgroundTasks: 'manual'` calls `runMaintenance()` and gets
 * exactly one deterministic pass.
 *
 * Every pass is bounded. It walks the command keyspace in pages of
 * `maintenanceBatchSize` records, up to {@link MAILBOX_MAINTENANCE_MAX_PAGES}
 * pages per call, carrying its cursor to the next call when the cap cuts it
 * short; and it retires at most `maintenanceBatchSize` terminal receipts. A large
 * mailbox drains across several calls instead of one unbounded sweep.
 *
 * @module core/application-mailbox-maintenance
 */

import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { formatSortableStorageTimestamp, storageConditionalBatch } from '../storage/interface.ts';
import { decodeApplicationCommandRecord } from './application-mailbox-codec.ts';
import type {
  ApplicationMailboxMaintenanceReport,
  LoadedCommandRecord,
} from './application-mailbox-contract.ts';
import {
  decodeApplicationCommandIdempotencyRecord,
  decodeApplicationReadyEntry,
} from './application-mailbox-index-codec.ts';
import {
  ApplicationMailboxContentionError,
  commitCommandTransition,
  isTerminalRecord,
  leaseCommitSerial,
  MAILBOX_MAINTENANCE_MAX_PAGES,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  releaseAttemptController,
  releaseAttemptsForCommand,
  type MailboxRuntime,
} from './application-mailbox-internals.ts';
import { loadCommand } from './application-mailbox-storage.ts';
import { recoverExpiredCommand } from './application-mailbox-transitions-recovery.ts';
import { isCommandPastDeadline, releaseWaitingCommand } from './application-mailbox-transitions.ts';
import {
  isApplicationCommandLeased,
  type ApplicationCommandRecord,
} from './application-mailbox-types.ts';

type MaintenanceCounters = {
  released: number;
  reclaimed: number;
  deadLettered: number;
  cancelled: number;
  retired: number;
};

/** Which time-driven transition a record is due for, if any. */
function classify(record: ApplicationCommandRecord, now: number): 'release' | 'recover' | null {
  if (isTerminalRecord(record)) return null;
  if (isCommandPastDeadline(record, now)) return 'recover';
  if (record.state === 'accepted' && now >= record.availableAt) return 'release';
  if (isApplicationCommandLeased(record) && now >= record.visibilityExpiresAt) return 'recover';
  return null;
}

function countTransition(
  counters: MaintenanceCounters,
  previous: ApplicationCommandRecord,
  next: ApplicationCommandRecord,
): void {
  if (next.state === 'available' && previous.state === 'accepted') counters.released += 1;
  else if (next.state === 'accepted') counters.reclaimed += 1;
  else if (next.state === 'dead-lettered') counters.deadLettered += 1;
  else if (next.state === 'cancelled') counters.cancelled += 1;
}

/** Release every local attempt on a command that is not its current lease. */
function reconcileLocalAttempts(
  runtime: MailboxRuntime,
  commandId: string,
  record: ApplicationCommandRecord | undefined,
  observedAt: number,
): void {
  releaseAttemptsForCommand(
    runtime,
    commandId,
    'This attempt is no longer the current lease on its command.',
    record !== undefined && isApplicationCommandLeased(record) ? record.attemptToken : undefined,
    observedAt,
  );
}

/**
 * Apply the one time-driven transition a command is due for, re-reading durable
 * state after a lost compare-and-swap.
 *
 * Returns `true` when a transition committed. A record another actor already
 * advanced is simply no longer due, which is success, not contention.
 */
async function advanceCommand(
  runtime: MailboxRuntime,
  commandId: string,
  now: number,
  counters: MaintenanceCounters,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const observedAt = leaseCommitSerial();
    const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
    if (loaded === null) {
      reconcileLocalAttempts(runtime, commandId, undefined, observedAt);
      return;
    }
    const due = classify(loaded.record, now);
    if (due === null) {
      // Not due — possibly because another process already reclaimed or
      // terminalized it between this pass's scan and this load. That process
      // cannot reach the local registry, so any local attempt that is not the
      // record's current lease is released here.
      reconcileLocalAttempts(runtime, commandId, loaded.record, observedAt);
      return;
    }
    const transition =
      due === 'release'
        ? releaseWaitingCommand(loaded.record, now)
        : recoverExpiredCommand(loaded.record, {
            now,
            retryBackoffMs: runtime.policy.retryBackoffMs,
            maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
          });
    // `classify` and the transition decide on the same clock reading, so a
    // record the former called due is never refused by the latter; this only
    // narrows the type.
    if (!transition.ok) return;
    const committed = await commitCommandTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
    });
    if (!committed) continue;
    if (isApplicationCommandLeased(loaded.record)) {
      releaseAttemptController(
        runtime,
        loaded.record.attemptToken,
        'The application mailbox reclaimed this attempt after its lease expired.',
      );
    }
    countTransition(counters, loaded.record, transition.next);
    return;
  }
  throw new ApplicationMailboxContentionError('maintenance', commandId);
}

/**
 * Delete terminal receipts whose retention window has passed.
 *
 * The command record, its terminal index entry, and its idempotency binding are
 * removed together. Dropping the binding is deliberate and is the reason
 * `terminalRetentionMs` is a real policy decision: after retention, a retry of
 * that idempotency key admits a NEW command rather than resolving the original
 * receipt. Retaining bindings forever would be the only alternative, and that
 * grows without bound.
 */
async function retireOneReceipt(
  runtime: MailboxRuntime,
  indexKey: string,
  indexBytes: Uint8Array,
): Promise<boolean> {
  const commandId = commandIdFromTerminalKey(indexKey);
  const loaded =
    commandId === null ? null : await loadCommand(runtime.storage, runtime.keys, commandId);
  // Only a terminal record whose own `terminalAt` rebuilds this exact index key
  // is retired through it. A malformed entry, a stale or corrupted one naming a
  // live command, or a terminal one under a different timestamp is an orphaned
  // index entry: it is removed on its own so it cannot monopolize every
  // retention pass, and the record it points at is left alone rather than
  // deleted out from under the mailbox.
  if (commandId === null || (loaded !== null && !ownsTerminalEntry(runtime, indexKey, loaded))) {
    await discardTerminalEntry(runtime, indexKey, indexBytes);
    return false;
  }
  const operations: BatchOperation[] = [{ type: 'delete', key: indexKey }];
  // The record is already gone: the entry is the last trace of a retired
  // receipt, and removing it completes that retirement. The compare-and-swap is
  // against the bytes the scan saw, so a concurrent pass that already removed
  // the entry makes this one lose rather than count the same receipt twice.
  if (loaded === null) {
    return storageConditionalBatch(
      runtime.storage,
      [{ key: indexKey, expectedValue: indexBytes }],
      operations,
    );
  }
  operations.push({ type: 'delete', key: runtime.keys.command(commandId) });
  const auxiliary = await ownedAuxiliaryEntries(runtime, loaded);
  operations.push(...auxiliary.operations);
  return storageConditionalBatch(
    runtime.storage,
    [
      { key: runtime.keys.command(commandId), expectedValue: loaded.bytes },
      ...auxiliary.conditions,
    ],
    operations,
  );
}

/**
 * The sequence-index entry and idempotency binding a terminal record names are
 * deleted with it only when they actually belong to it. A record whose
 * persisted `sequence` or `idempotencyKey` is stale or corrupted would
 * otherwise take another live command's listing entry or deduplication fence
 * down with it. Each entry that is owned is fenced on the bytes observed here.
 */
async function ownedAuxiliaryEntries(
  runtime: MailboxRuntime,
  loaded: LoadedCommandRecord,
): Promise<{ conditions: ConditionalBatchCondition[]; operations: BatchOperation[] }> {
  const conditions: ConditionalBatchCondition[] = [];
  const operations: BatchOperation[] = [];
  const sequenceKey = runtime.keys.bySequence(loaded.record.sequence);
  const sequenceBytes = await runtime.storage.get(sequenceKey);
  if (
    sequenceBytes !== null &&
    decodeApplicationReadyEntry(sequenceBytes, sequenceKey) === loaded.record.commandId
  ) {
    conditions.push({ key: sequenceKey, expectedValue: sequenceBytes });
    operations.push({ type: 'delete', key: sequenceKey });
  }
  if (loaded.record.idempotencyKey === undefined) return { conditions, operations };
  const bindingKey = runtime.keys.idempotency(loaded.record.idempotencyKey);
  const bindingBytes = await runtime.storage.get(bindingKey);
  if (
    bindingBytes !== null &&
    decodeApplicationCommandIdempotencyRecord(bindingBytes, bindingKey).commandId ===
      loaded.record.commandId
  ) {
    conditions.push({ key: bindingKey, expectedValue: bindingBytes });
    operations.push({ type: 'delete', key: bindingKey });
  }
  return { conditions, operations };
}

function ownsTerminalEntry(
  runtime: MailboxRuntime,
  indexKey: string,
  loaded: LoadedCommandRecord,
): boolean {
  return (
    isTerminalRecord(loaded.record) &&
    runtime.keys.terminal(loaded.record.terminalAt, loaded.record.commandId) === indexKey
  );
}

/**
 * Remove an index entry that nothing owns, fenced on the bytes it was seen
 * with. Not a retirement: no receipt is retired, so it is not counted as one.
 */
async function discardTerminalEntry(
  runtime: MailboxRuntime,
  indexKey: string,
  indexBytes: Uint8Array,
): Promise<void> {
  await storageConditionalBatch(
    runtime.storage,
    [{ key: indexKey, expectedValue: indexBytes }],
    [{ type: 'delete', key: indexKey }],
  );
}

async function retireTerminalReceipts(
  runtime: MailboxRuntime,
  now: number,
  counters: MaintenanceCounters,
): Promise<void> {
  const horizon = now - runtime.policy.terminalRetentionMs;
  if (horizon < 0) return;
  const expired: [string, Uint8Array][] = [];
  const malformed: [string, Uint8Array][] = [];
  for await (const [key, value] of runtime.storage.scan(runtime.keys.terminalPrefix, {
    limit: runtime.policy.maintenanceBatchSize,
  })) {
    const terminalAt = parseTerminalAt(key, runtime.keys.terminalPrefix);
    // An entry whose timestamp cannot be parsed is malformed, not "not yet due";
    // stopping at it would leave every valid receipt behind it unretired on
    // every pass. It is discarded on its own and never counted as retired.
    if (terminalAt === null) {
      malformed.push([key, value]);
      continue;
    }
    if (terminalAt >= horizon) break;
    expired.push([key, value]);
  }
  for (const [indexKey, bytes] of malformed) await discardTerminalEntry(runtime, indexKey, bytes);
  for (const [indexKey, bytes] of expired) {
    if (await retireOneReceipt(runtime, indexKey, bytes)) counters.retired += 1;
  }
}

/** The terminal index encodes `…:<16-digit terminalAt>:<encoded commandId>`. */
function parseTerminalAt(key: string, prefix: string): number | null {
  const suffix = key.slice(prefix.length);
  const separator = suffix.indexOf(':');
  if (separator === -1) return null;
  const segment = suffix.slice(0, separator);
  const parsed = Number(segment);
  // Only the canonical fixed-width encoding sorts chronologically. A value
  // that parses but is not what the encoder writes (over-padded, say) could
  // sort ahead of every expired receipt while naming a future instant, and
  // stop the sweep there on every pass; it is malformed.
  return Number.isSafeInteger(parsed) && formatSortableStorageTimestamp(parsed) === segment
    ? parsed
    : null;
}

function commandIdFromTerminalKey(key: string): string | null {
  const separator = key.lastIndexOf(':');
  if (separator === -1) return null;
  try {
    return decodeURIComponent(key.slice(separator + 1));
  } catch {
    return null;
  }
}

/**
 * Collect every command due for a time-driven transition, paging through the
 * whole keyspace rather than only its lexicographically first page.
 *
 * Command records are keyed by minted id, so a single bounded scan would keep
 * re-reading the same arbitrary page: a due command outside it would never be
 * released, reclaimed, or dead-lettered no matter how often maintenance ran.
 * Paging with a cursor keeps each read bounded while still reaching everything,
 * and {@link MAILBOX_MAINTENANCE_MAX_PAGES} keeps one pass from running away on
 * a very large mailbox — the next pass resumes the work.
 */
async function collectDueCommands(
  runtime: MailboxRuntime,
  now: number,
  startAfter: string | undefined,
): Promise<{ due: string[]; nextCursor: string | undefined }> {
  const batchSize = runtime.policy.maintenanceBatchSize;
  const due: string[] = [];
  let cursor = startAfter;
  for (let page = 0; page < MAILBOX_MAINTENANCE_MAX_PAGES; page += 1) {
    let seen = 0;
    const options = cursor === undefined ? { limit: batchSize } : { limit: batchSize, gt: cursor };
    // Fence before the page is read: a lease this process commits while the
    // page is in flight is newer than anything the page can say about it.
    const observedAt = leaseCommitSerial();
    for await (const [key, value] of runtime.storage.scan(runtime.keys.commandPrefix, options)) {
      seen += 1;
      cursor = key;
      const record = decodeApplicationCommandRecord(value, key);
      // Every record the pass visits is also the truth about which local
      // attempt, if any, still held it as of the page read. A lease reclaimed
      // or terminalized in another process cannot release the registration
      // here; this pass can.
      reconcileLocalAttempts(runtime, record.commandId, record, observedAt);
      if (classify(record, now) !== null) due.push(record.commandId);
    }
    // A short page means the keyspace is exhausted: start the next pass from the
    // beginning so newly admitted work is seen.
    if (seen < batchSize) return { due, nextCursor: undefined };
  }
  // The page cap stopped this pass mid-keyspace. Hand the cursor back so the next
  // call continues from here instead of re-reading the same prefix forever — a
  // mailbox larger than the cap would otherwise never examine records past it.
  return { due, nextCursor: cursor };
}

/**
 * Run one bounded maintenance pass.
 *
 * The scan decodes every command record it visits, so a single corrupt record
 * raises `PersistedDataCorruptError` and halts the pass. That is deliberate: a
 * mailbox whose durable state is untrustworthy must not keep reclaiming leases
 * and dead-lettering commands around the damage.
 */
export async function runMailboxMaintenance(
  runtime: MailboxRuntime,
  now: number,
): Promise<ApplicationMailboxMaintenanceReport> {
  const counters: MaintenanceCounters = {
    released: 0,
    reclaimed: 0,
    deadLettered: 0,
    cancelled: 0,
    retired: 0,
  };
  const previousCursor = runtime.readMaintenanceCursor();
  const scan = await collectDueCommands(runtime, now, previousCursor);
  // The cursor moves only once the collected work is done. A pass that fails
  // part-way keeps its starting point, so the retry revisits the command it
  // failed on instead of resuming past it — in a mailbox larger than the page
  // cap, that could otherwise leave an expired lease untouched for many passes.
  try {
    for (const commandId of scan.due) {
      await advanceCommand(runtime, commandId, now, counters);
    }
  } catch (error) {
    runtime.writeMaintenanceCursor(previousCursor);
    throw error;
  }
  runtime.writeMaintenanceCursor(scan.nextCursor);
  await retireTerminalReceipts(runtime, now, counters);
  return Object.freeze({ ...counters });
}
