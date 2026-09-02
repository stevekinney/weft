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
 * Every pass is bounded. It examines at most
 * {@link batchSize} command records and retires at most
 * that many terminal receipts, so a large mailbox drains across several calls
 * instead of one unbounded sweep.
 *
 * @module core/application-mailbox-maintenance
 */

import type { BatchOperation } from '../storage/interface.ts';
import { storageConditionalBatch } from '../storage/interface.ts';
import { decodeApplicationCommandRecord } from './application-mailbox-codec.ts';
import type { ApplicationMailboxMaintenanceReport } from './application-mailbox-contract.ts';
import {
  ApplicationMailboxContentionError,
  commitCommandTransition,
  isTerminalRecord,
  MAILBOX_MAINTENANCE_MAX_PAGES,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  releaseAttemptController,
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
    const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
    if (loaded === null) return;
    const due = classify(loaded.record, now);
    if (due === null) return;
    const transition =
      due === 'release'
        ? releaseWaitingCommand(loaded.record, now)
        : recoverExpiredCommand(loaded.record, {
            now,
            retryBackoffMs: runtime.policy.retryBackoffMs,
            maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
          });
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
async function retireOneReceipt(runtime: MailboxRuntime, indexKey: string): Promise<boolean> {
  const commandId = commandIdFromTerminalKey(indexKey);
  if (commandId === null) return false;
  const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
  const operations: BatchOperation[] = [{ type: 'delete', key: indexKey }];
  if (loaded === null) {
    return storageConditionalBatch(
      runtime.storage,
      [{ key: indexKey, expectedValue: await runtime.storage.get(indexKey) }],
      operations,
    );
  }
  operations.push({ type: 'delete', key: runtime.keys.command(commandId) });
  operations.push({ type: 'delete', key: runtime.keys.bySequence(loaded.record.sequence) });
  if (loaded.record.idempotencyKey !== undefined) {
    operations.push({
      type: 'delete',
      key: runtime.keys.idempotency(loaded.record.idempotencyKey),
    });
  }
  return storageConditionalBatch(
    runtime.storage,
    [{ key: runtime.keys.command(commandId), expectedValue: loaded.bytes }],
    operations,
  );
}

async function retireTerminalReceipts(
  runtime: MailboxRuntime,
  now: number,
  counters: MaintenanceCounters,
): Promise<void> {
  const horizon = now - runtime.policy.terminalRetentionMs;
  if (horizon < 0) return;
  const expired: string[] = [];
  for await (const [key] of runtime.storage.scan(runtime.keys.terminalPrefix, {
    limit: runtime.policy.maintenanceBatchSize,
  })) {
    const terminalAt = parseTerminalAt(key, runtime.keys.terminalPrefix);
    if (terminalAt === null || terminalAt >= horizon) break;
    expired.push(key);
  }
  for (const indexKey of expired) {
    if (await retireOneReceipt(runtime, indexKey)) counters.retired += 1;
  }
}

/** The terminal index encodes `…:<16-digit terminalAt>:<encoded commandId>`. */
function parseTerminalAt(key: string, prefix: string): number | null {
  const suffix = key.slice(prefix.length);
  const separator = suffix.indexOf(':');
  if (separator === -1) return null;
  const parsed = Number(suffix.slice(0, separator));
  return Number.isSafeInteger(parsed) ? parsed : null;
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
    for await (const [key, value] of runtime.storage.scan(runtime.keys.commandPrefix, options)) {
      seen += 1;
      cursor = key;
      const record = decodeApplicationCommandRecord(value, key);
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
  const scan = await collectDueCommands(runtime, now, runtime.readMaintenanceCursor());
  runtime.writeMaintenanceCursor(scan.nextCursor);
  const due = scan.due;
  for (const commandId of due) {
    await advanceCommand(runtime, commandId, now, counters);
  }
  await retireTerminalReceipts(runtime, now, counters);
  return Object.freeze({ ...counters });
}
