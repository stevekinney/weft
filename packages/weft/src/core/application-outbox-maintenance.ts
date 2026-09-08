/**
 * The bounded maintenance pass for the application delivery outbox (WFT-85):
 * recovering lapsed leases and retiring terminal receipts past retention.
 *
 * Nothing here runs on a hidden timer under `backgroundTasks: 'manual'`. A
 * pass walks the delivery keyspace in pages of `maintenanceBatchSize`, up to
 * {@link OUTBOX_MAINTENANCE_MAX_PAGES} pages per call, carrying its cursor to
 * the next call when the cap cuts it short.
 *
 * Unlike the mailbox, the outbox has no `accepted → available` release step:
 * the due index is time-keyed, so a delivery becomes claimable by the clock
 * alone, without a maintenance write.
 *
 * @module core/application-outbox-maintenance
 */

import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { formatSortableStorageTimestamp, storageConditionalBatch } from '../storage/interface.ts';
import { decodeApplicationDeliveryRecord } from './application-outbox-codec.ts';
import type {
  ApplicationOutboxMaintenanceReport,
  LoadedDeliveryRecord,
} from './application-outbox-contract.ts';
import {
  decodeApplicationDeliveryEntry,
  decodeApplicationDeliveryIdempotencyRecord,
} from './application-outbox-index-codec.ts';
import {
  ApplicationOutboxContentionError,
  commitDeliveryTransition,
  MAX_OUTBOX_TRANSITION_ATTEMPTS,
  OUTBOX_MAINTENANCE_MAX_PAGES,
  releaseAttemptController,
  releaseAttemptsForDelivery,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import { loadDelivery } from './application-outbox-storage.ts';
import { isTerminalDeliveryRecord } from './application-outbox-transition-helpers.ts';
import {
  isDeliveryLeaseExpired,
  recoverExpiredDelivery,
} from './application-outbox-transitions-recovery.ts';
import {
  isApplicationDeliveryLeased,
  type ApplicationDeliveryRecord,
} from './application-outbox-types.ts';
import { leaseCommitSerial } from './application-primitive-attempt-registry.ts';

type MaintenanceCounters = {
  rescheduled: number;
  parked: number;
  deadLettered: number;
  retired: number;
};

function countTransition(counters: MaintenanceCounters, next: ApplicationDeliveryRecord): void {
  if (next.state === 'retry-scheduled') counters.rescheduled += 1;
  else if (next.state === 'unknown-outcome') counters.parked += 1;
  else if (next.state === 'dead-lettered') counters.deadLettered += 1;
}

/** Release every local attempt on a delivery that is not its current lease. */
function reconcileLocalAttempts(
  runtime: OutboxRuntime,
  deliveryId: string,
  record: ApplicationDeliveryRecord | undefined,
  observedAt: number,
): void {
  releaseAttemptsForDelivery(
    runtime,
    deliveryId,
    'This attempt is no longer the current lease on its delivery.',
    record !== undefined && isApplicationDeliveryLeased(record) ? record.attemptToken : undefined,
    observedAt,
  );
}

/** Recover one lapsed lease, re-reading durable state after a lost compare-and-swap. */
async function recoverDelivery(
  runtime: OutboxRuntime,
  deliveryId: string,
  now: number,
  counters: MaintenanceCounters,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_OUTBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const observedAt = leaseCommitSerial();
    const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
    if (loaded === null) {
      reconcileLocalAttempts(runtime, deliveryId, undefined, observedAt);
      return;
    }
    if (!isDeliveryLeaseExpired(loaded.record, now)) {
      reconcileLocalAttempts(runtime, deliveryId, loaded.record, observedAt);
      return;
    }
    const transition = recoverExpiredDelivery(loaded.record, {
      now,
      retryBackoffMs: runtime.policy.retryBackoffMs,
      maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
    });
    // `isDeliveryLeaseExpired` and the transition decide on the same reading,
    // so this only narrows the type.
    if (!transition.ok) return;
    const committed = await commitDeliveryTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
    });
    if (!committed) continue;
    if (isApplicationDeliveryLeased(loaded.record)) {
      releaseAttemptController(
        runtime,
        loaded.record.attemptToken,
        'The application outbox recovered this attempt after its lease lapsed.',
      );
    }
    countTransition(counters, transition.next);
    return;
  }
  throw new ApplicationOutboxContentionError('maintenance', deliveryId);
}

/**
 * Delete a terminal receipt past retention together with its listing entry
 * and idempotency binding, each fenced on the bytes observed here and deleted
 * only when it actually belongs to the record.
 */
async function retireOneReceipt(
  runtime: OutboxRuntime,
  indexKey: string,
  indexBytes: Uint8Array,
): Promise<boolean> {
  const deliveryId = deliveryIdFromTerminalKey(indexKey);
  const observedAt = leaseCommitSerial();
  const loaded =
    deliveryId === null ? null : await loadDelivery(runtime.storage, runtime.keys, deliveryId);
  if (deliveryId === null || (loaded !== null && !ownsTerminalEntry(runtime, indexKey, loaded))) {
    await discardTerminalEntry(runtime, indexKey, indexBytes);
    return false;
  }
  const operations: BatchOperation[] = [{ type: 'delete', key: indexKey }];
  if (loaded === null) {
    return storageConditionalBatch(
      runtime.storage,
      [{ key: indexKey, expectedValue: indexBytes }],
      operations,
    );
  }
  operations.push({ type: 'delete', key: runtime.keys.delivery(deliveryId) });
  const auxiliary = await ownedAuxiliaryEntries(runtime, loaded);
  operations.push(...auxiliary.operations);
  const retired = await storageConditionalBatch(
    runtime.storage,
    [
      { key: runtime.keys.delivery(deliveryId), expectedValue: loaded.bytes },
      ...auxiliary.conditions,
    ],
    operations,
  );
  if (retired) {
    releaseAttemptsForDelivery(
      runtime,
      deliveryId,
      'This delivery was retired; its attempt is over.',
      undefined,
      observedAt,
    );
  }
  return retired;
}

async function ownedAuxiliaryEntries(
  runtime: OutboxRuntime,
  loaded: LoadedDeliveryRecord,
): Promise<{ conditions: ConditionalBatchCondition[]; operations: BatchOperation[] }> {
  const conditions: ConditionalBatchCondition[] = [];
  const operations: BatchOperation[] = [];
  const sequenceKey = runtime.keys.bySequence(loaded.record.sequence);
  const sequenceBytes = await runtime.storage.get(sequenceKey);
  if (
    sequenceBytes !== null &&
    decodeApplicationDeliveryEntry(sequenceBytes, sequenceKey) === loaded.record.deliveryId
  ) {
    conditions.push({ key: sequenceKey, expectedValue: sequenceBytes });
    operations.push({ type: 'delete', key: sequenceKey });
  }
  if (loaded.record.idempotencyKey === undefined) return { conditions, operations };
  const bindingKey = runtime.keys.idempotency(loaded.record.idempotencyKey);
  const bindingBytes = await runtime.storage.get(bindingKey);
  if (
    bindingBytes !== null &&
    decodeApplicationDeliveryIdempotencyRecord(bindingBytes, bindingKey).deliveryId ===
      loaded.record.deliveryId
  ) {
    conditions.push({ key: bindingKey, expectedValue: bindingBytes });
    operations.push({ type: 'delete', key: bindingKey });
  }
  return { conditions, operations };
}

function ownsTerminalEntry(
  runtime: OutboxRuntime,
  indexKey: string,
  loaded: LoadedDeliveryRecord,
): boolean {
  return (
    isTerminalDeliveryRecord(loaded.record) &&
    runtime.keys.terminal(loaded.record.terminalAt, loaded.record.deliveryId) === indexKey
  );
}

async function discardTerminalEntry(
  runtime: OutboxRuntime,
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
  runtime: OutboxRuntime,
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
    const terminalAt = parseSortableInstant(key, runtime.keys.terminalPrefix);
    if (terminalAt === null) {
      malformed.push([key, value]);
      continue;
    }
    if (terminalAt >= horizon) break;
    expired.push([key, value]);
  }
  for (const [indexKey, bytes] of malformed) {
    if (runtime.disposal.aborted) return;
    await discardTerminalEntry(runtime, indexKey, bytes);
  }
  for (const [indexKey, bytes] of expired) {
    if (runtime.disposal.aborted) return;
    if (await retireOneReceipt(runtime, indexKey, bytes)) counters.retired += 1;
  }
}

/** The time-keyed indexes encode `…:<16-digit instant>:<encoded deliveryId>`. */
export function parseSortableInstant(key: string, prefix: string): number | null {
  const suffix = key.slice(prefix.length);
  const separator = suffix.indexOf(':');
  if (separator === -1) return null;
  const segment = suffix.slice(0, separator);
  const parsed = Number(segment);
  return Number.isSafeInteger(parsed) && formatSortableStorageTimestamp(parsed) === segment
    ? parsed
    : null;
}

/** The encoded delivery id after the key's last separator, or `null` when it is not decodable. */
function deliveryIdFromTerminalKey(key: string): string | null {
  try {
    return decodeURIComponent(key.slice(key.lastIndexOf(':') + 1));
  } catch {
    return null;
  }
}

/**
 * Collect every delivery whose lease lapsed, paging through the whole keyspace
 * with a cursor so a large outbox is reached across successive passes.
 */
async function collectLapsedDeliveries(
  runtime: OutboxRuntime,
  now: number,
  startAfter: string | undefined,
): Promise<{ lapsed: string[]; nextCursor: string | undefined }> {
  const batchSize = runtime.policy.maintenanceBatchSize;
  const lapsed: string[] = [];
  let cursor = startAfter;
  for (let page = 0; page < OUTBOX_MAINTENANCE_MAX_PAGES; page += 1) {
    let seen = 0;
    const options = cursor === undefined ? { limit: batchSize } : { limit: batchSize, gt: cursor };
    const observedAt = leaseCommitSerial();
    if (runtime.disposal.aborted) return { lapsed: [], nextCursor: startAfter };
    for await (const [key, value] of runtime.storage.scan(runtime.keys.deliveryPrefix, options)) {
      seen += 1;
      cursor = key;
      const record = decodeApplicationDeliveryRecord(value, key);
      reconcileLocalAttempts(runtime, record.deliveryId, record, observedAt);
      if (isDeliveryLeaseExpired(record, now)) lapsed.push(record.deliveryId);
    }
    if (seen < batchSize) return { lapsed, nextCursor: undefined };
  }
  return { lapsed, nextCursor: cursor };
}

/**
 * Run one bounded maintenance pass: recover lapsed leases and retire terminal
 * receipts past retention.
 *
 * A corrupt record halts the pass with `PersistedDataCorruptError`: an outbox
 * whose durable state is untrustworthy must not keep recovering and parking
 * deliveries around the damage.
 */
export async function runOutboxMaintenance(
  runtime: OutboxRuntime,
  now: number,
): Promise<ApplicationOutboxMaintenanceReport> {
  const counters: MaintenanceCounters = { rescheduled: 0, parked: 0, deadLettered: 0, retired: 0 };
  const previousCursor = runtime.readMaintenanceCursor();
  const scan = await collectLapsedDeliveries(runtime, now, previousCursor);
  try {
    for (const deliveryId of scan.lapsed) {
      // A pass already in flight when the outbox is disposed stops at its next
      // step rather than continuing to write against resources the caller
      // may have released with the handle.
      if (runtime.disposal.aborted) return Object.freeze({ ...counters });
      await recoverDelivery(runtime, deliveryId, now, counters);
    }
  } catch (error) {
    runtime.writeMaintenanceCursor(previousCursor);
    throw error;
  }
  runtime.writeMaintenanceCursor(scan.nextCursor);
  if (!runtime.disposal.aborted) await retireTerminalReceipts(runtime, now, counters);
  return Object.freeze({ ...counters });
}
