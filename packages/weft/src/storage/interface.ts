import { APPLICATION_MAILBOX_KEYS } from './application-mailbox-keys.ts';
import { requireStorageCapability, type StorageCapabilities } from './capabilities.ts';
import { DEFAULT_SCOPE } from './default-scope.ts';
import type { DeleteRangeOptions } from './delete-range.ts';
import {
  storageCountCore,
  storageDeletePrefixCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';
import { encodeStorageKeyComponent, formatSortableStorageTimestamp } from './key-encoding.ts';
import { OWNERSHIP_CLAIM_KEYS } from './ownership-keys.ts';

export { assertDurableStorageForRecovery, requireStorageCapability } from './capabilities.ts';
export type { GatedStorageCapabilityKey, StorageCapabilities } from './capabilities.ts';
export { DEFAULT_SCOPE } from './default-scope.ts';
export { WEFT_RESERVED_KEY_PREFIXES } from './key-prefixes.ts';

/**
 * A single KV operation in a batch.
 *
 * Either a put (write `value` at `key`) or a delete (remove `key`). The `type`
 * discriminant selects the variant; delete operations carry no value.
 */
export type BatchOperation =
  { type: 'put'; key: string; value: Uint8Array } | { type: 'delete'; key: string };

/**
 * Maximum number of operations or conditions accepted by one storage batch call.
 *
 * @example
 * ```ts
 * import { MAX_BATCH_OPERATIONS } from '@lostgradient/weft/storage';
 *
 * console.log(MAX_BATCH_OPERATIONS); // 10000
 * ```
 */
export const MAX_BATCH_OPERATIONS = 10_000;

/**
 * Maximum `limit` accepted by raw storage scan administration routes.
 *
 * @example
 * ```ts
 * import { MAX_SCAN_LIMIT } from '@lostgradient/weft/storage';
 *
 * console.log(MAX_SCAN_LIMIT); // 10000
 * ```
 */
export const MAX_SCAN_LIMIT = 10_000;

/**
 * Batch input category named by {@link StorageBatchOperationLimitExceededError}.
 *
 * @example
 * ```ts
 * import type { StorageBatchOperationLimitTarget } from '@lostgradient/weft/storage';
 *
 * const target: StorageBatchOperationLimitTarget = 'batch operations';
 * void target;
 * ```
 */
export type StorageBatchOperationLimitTarget =
  'batch operations' | 'conditionalBatch conditions' | 'conditionalBatch operations';

/**
 * Error thrown before a storage batch exceeds {@link MAX_BATCH_OPERATIONS}.
 *
 * @example
 * ```ts
 * import { StorageBatchOperationLimitExceededError } from '@lostgradient/weft/storage';
 *
 * const error = new StorageBatchOperationLimitExceededError('batch operations', 10001);
 * console.log(error.cap); // 10000
 * ```
 */
export class StorageBatchOperationLimitExceededError extends Error {
  readonly code = 'StorageBatchOperationLimitExceededError' as const;
  readonly cap = MAX_BATCH_OPERATIONS;
  readonly count: number;
  readonly target: StorageBatchOperationLimitTarget;

  constructor(target: StorageBatchOperationLimitTarget, count: number) {
    super(`${target} count ${count} exceeds MAX_BATCH_OPERATIONS (${MAX_BATCH_OPERATIONS}).`);
    this.name = 'StorageBatchOperationLimitExceededError';
    this.target = target;
    this.count = count;
  }
}

/**
 * Throw when a storage batch target exceeds {@link MAX_BATCH_OPERATIONS}.
 *
 * @example
 * ```ts
 * import { assertStorageBatchOperationCount } from '@lostgradient/weft/storage';
 *
 * assertStorageBatchOperationCount('batch operations', 1);
 * ```
 */
export function assertStorageBatchOperationCount(
  target: StorageBatchOperationLimitTarget,
  count: number,
): void {
  if (count > MAX_BATCH_OPERATIONS) {
    throw new StorageBatchOperationLimitExceededError(target, count);
  }
}

/**
 * A key/value precondition for {@link Storage.conditionalBatch}.
 *
 * The batch commits only when every listed key currently matches the expected
 * value. Use `null` to require that the key is absent.
 */
export interface ConditionalBatchCondition {
  key: string;
  expectedValue: Uint8Array | null;
}

/**
 * Options for range scans.
 *
 * @example
 * ```ts
 * import { MemoryStorage, type ScanOptions } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * const options: ScanOptions = { limit: 10, reverse: true };
 * for await (const [key, value] of storage.scan('wf:', options)) {
 *   console.log(key);
 * }
 * ```
 */
export interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}

/**
 * KV-oriented storage interface. All storage adapters implement this.
 *
 * Required methods are `get`, `put`, `delete`, `scan`, and `batch`. Optional
 * fast paths are `conditionalBatch`, `has`, `deletePrefix`, `deleteRange`,
 * `keys`, `count`, `scoped`, and `query`. Adapters that omit optional methods
 * get generic fallbacks via `storageHas`, `storageKeys`, `storageCount`,
 * `storageDeletePrefix`, and `storageConditionalBatch` (all from this module),
 * plus `storageDeleteRange` (exported from `@lostgradient/weft` / `@lostgradient/weft/storage`, defined in
 * `storage/delete-range.ts`). Callers should use those wrappers rather than
 * calling optional methods directly.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import type { Storage } from '@lostgradient/weft/storage/interface';
 *
 * await using storage: Storage = new MemoryStorage();
 * const encoded = new TextEncoder().encode('hello');
 * await storage.put('my-key', encoded);
 * const value = await storage.get('my-key');
 * console.log(new TextDecoder().decode(value!)); // 'hello'
 * ```
 */
export interface Storage extends Disposable {
  /**
   * Self-report the backend's consistency and feature guarantees. Required on
   * every adapter so the engine and feature gates can act on an honest,
   * declarative profile rather than duck-typing optional methods. See
   * {@link StorageCapabilities} for the contract each field promises and which
   * fields are runtime-gated versus trusted.
   */
  capabilities(): StorageCapabilities;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  conditionalBatch?(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean>;
  has?(key: string): Promise<boolean>;
  deletePrefix?(prefix: string): Promise<number>;
  deleteRange?(prefix: string, options: DeleteRangeOptions): Promise<number>;
  keys?(prefix: string, options?: ScanOptions): AsyncIterable<string>;
  count?(prefix: string): Promise<number>;
  scoped?(prefix: string): Storage;

  /** Optional SQL passthrough for dashboard/debugging. */
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Resolve the exclusive upper bound for a lexicographic prefix scan.
 *
 * @example
 * ```ts
 * import { resolvePrefixRangeEnd } from '@lostgradient/weft/storage/interface';
 *
 * const end = resolvePrefixRangeEnd('wf:');
 * console.log(end); // 'wf;'
 * // Use as an exclusive upper bound in range queries
 * ```
 */
export function resolvePrefixRangeEnd(prefix: string): string {
  return prefix.length > 0
    ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    : '\xff';
}

/**
 * Apply gt/gte/lt/lte scan bounds to a single key.
 *
 * @example
 * ```ts
 * import { matchesScanOptions } from '@lostgradient/weft/storage/interface';
 *
 * console.log(matchesScanOptions('wf:b', { gt: 'wf:a', lt: 'wf:c' })); // true
 * console.log(matchesScanOptions('wf:a', { gt: 'wf:a' }));              // false
 * ```
 */
export function matchesScanOptions(key: string, options: ScanOptions = {}): boolean {
  if (options.gt !== undefined && key <= options.gt) {
    return false;
  }

  if (options.gte !== undefined && key < options.gte) {
    return false;
  }

  if (options.lt !== undefined && key >= options.lt) {
    return false;
  }

  if (options.lte !== undefined && key > options.lte) {
    return false;
  }

  return true;
}

/**
 * Compare two storage values for byte-for-byte equality.
 *
 * @example
 * ```ts
 * import { storageValuesEqual } from '@lostgradient/weft';
 *
 * const a = new Uint8Array([1, 2, 3]);
 * const b = new Uint8Array([1, 2, 3]);
 * console.log(storageValuesEqual(a, b)); // true
 * console.log(storageValuesEqual(a, null)); // false
 * ```
 */
export function storageValuesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Check key existence using the adapter method when available or a core fallback otherwise.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageHas } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('my-key', new Uint8Array([1]));
 * console.log(await storageHas(storage, 'my-key'));    // true
 * console.log(await storageHas(storage, 'other-key')); // false
 * ```
 */
export async function storageHas(storage: Storage, key: string): Promise<boolean> {
  if (storage.has) {
    return storage.has(key);
  }

  return storageHasCore(storage, key);
}

/**
 * Iterate keys only, using the adapter shortcut when available or `scan()` as a fallback.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageKeys } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * for await (const key of storageKeys(storage, 'wf:')) {
 *   console.log(key); // 'wf:abc'
 * }
 * ```
 */
export function storageKeys(
  storage: Storage,
  prefix: string,
  options?: ScanOptions,
): AsyncIterable<string> {
  if (storage.keys) {
    return storage.keys(prefix, options);
  }

  return storageKeysCore(storage, prefix, options);
}

/**
 * Count keys for a prefix using the adapter method when available or iteration otherwise.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageCount } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('wf:1', new Uint8Array([1]));
 * await storage.put('wf:2', new Uint8Array([2]));
 * console.log(await storageCount(storage, 'wf:')); // 2
 * ```
 */
export async function storageCount(storage: Storage, prefix: string): Promise<number> {
  if (storage.count) {
    return storage.count(prefix);
  }

  return storageCountCore(storage, prefix);
}

/**
 * Delete a whole prefix using the adapter method when available or a batched fallback otherwise.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageDeletePrefix } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('wf:a', new Uint8Array([1]));
 * await storage.put('wf:b', new Uint8Array([2]));
 * const deleted = await storageDeletePrefix(storage, 'wf:');
 * console.log(deleted); // 2
 * ```
 */
export async function storageDeletePrefix(storage: Storage, prefix: string): Promise<number> {
  if (storage.deletePrefix) {
    return storage.deletePrefix(prefix);
  }

  return storageDeletePrefixCore(storage, prefix);
}

/**
 * Run a storage batch after enforcing Weft's operation-count guardrail.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageBatch } from '@lostgradient/weft/storage';
 *
 * await using storage = new MemoryStorage();
 * await storageBatch(storage, []);
 * ```
 */
export async function storageBatch(storage: Storage, operations: BatchOperation[]): Promise<void> {
  assertStorageBatchOperationCount('batch operations', operations.length);
  await storage.batch(operations);
}

/**
 * Run a conditional batch or throw when the backend does not support it.
 *
 * Built-in Memory, BunSQLite, NodeSQLite, LMDB, Turso, and IndexedDB backends
 * provide `conditionalBatch`; custom adapters may omit it.
 *
 * @throws {Error} This storage backend does not support conditionalBatch(), which is required for this operation.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { storageConditionalBatch } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * const key = 'my-key';
 * // Commit only if key is absent
 * const applied = await storageConditionalBatch(
 *   storage,
 *   [{ key, expectedValue: null }],
 *   [{ type: 'put', key, value: new Uint8Array([1]) }],
 * );
 * console.log(applied); // true
 * ```
 */
export async function storageConditionalBatch(
  storage: Storage,
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
): Promise<boolean> {
  assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
  assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

  // Trust the declared capability, not method presence: an adapter that has the
  // method but honestly reports conditionalBatch: false (e.g. a remote HTTP
  // backend known to lack CAS) must not silently execute the swap.
  requireStorageCapability(storage, 'conditionalBatch', 'storageConditionalBatch');
  if (!storage.conditionalBatch) {
    throw new Error(
      'This storage backend reports conditionalBatch capability but does not implement the conditionalBatch() method.',
    );
  }

  return storage.conditionalBatch(conditions, operations);
}

export {
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  tryDecodeStorageKeyComponent,
} from './key-encoding.ts';

const formatSortableTimestamp = formatSortableStorageTimestamp;

// Leading sort-class digit for a buffered-signal key. `consumeSignal` scans the
// `sig:<workflowId>:<name>:` prefix with `limit: 1` and takes the lexically-first
// key, so a `startOrSignal` start-signal — which must be consumed before any
// signal that arrives later in the same tick, before the workflow's first park —
// gets class `0` and every other signal gets class `1`. `'0'` < `'1'` under raw
// byte sort, so the start-signal always sorts first regardless of how the two id
// namespaces (explicit signalId vs `anonymous:<seq>:<uuid>`) compare (issue #458).
const SIGNAL_SORT_CLASS_START = '0';
const SIGNAL_SORT_CLASS_NORMAL = '1';

// `name` is encoded (like `id` and `workflowId`) so a name containing the `:`
// separator cannot prefix-collide with another name on the `consumeSignal` scan
// path; the consume/peek/has scan prefixes in `signals.ts` encode `name` to match.
const signalStorageKey = (
  workflowId: string,
  name: string,
  id: string,
  sortClass: string,
): string =>
  `sig:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(name)}:${sortClass}:${encodeStorageKeyComponent(id)}`;

/**
 * Key layout constants for hierarchical key encoding. Timestamps are
 * zero-padded to 16 digits for lexicographic ordering.
 *
 * This registry grows as storage features are added, which is why this file
 * carries a `max-lines` override in `.oxlintrc.json` above the repository
 * default of 500. Extracting `KEYS` into its own module — and dropping the
 * override — is tracked in WFT-90. Prefer adding new key families as a separate
 * module spread into `KEYS` (see `ownership-keys.ts`) over growing this file.
 *
 * @example
 * ```ts
 * import { KEYS } from '@lostgradient/weft/storage/interface';
 * KEYS.workflow('workflow-id');
 * ```
 */
export const KEYS = {
  workflow: (id: string) => `wf:${encodeStorageKeyComponent(id)}`,
  checkpoint: (id: string) => `wf:${encodeStorageKeyComponent(id)}:ckpt`,
  checkpointHistory: (id: string, step: number) =>
    `wf:${encodeStorageKeyComponent(id)}:ckpt:${String(step).padStart(10, '0')}`,
  timelinePrefix: (id: string) => `wf:${encodeStorageKeyComponent(id)}:timeline:`,
  timeline: (id: string, step: number) =>
    `wf:${encodeStorageKeyComponent(id)}:timeline:${String(step).padStart(10, '0')}`,
  schedule: (id: string) => `schedule:${encodeStorageKeyComponent(id)}`,
  scheduleTick: (fireAt: number, id: string) =>
    `schedule-due:${String(fireAt).padStart(16, '0')}:${encodeStorageKeyComponent(id)}`,
  scheduleRun: (workflowId: string) => `schedule-run:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Durable per-workflow manifest for the schedule that launched a run. Unlike
   * `scheduleRun`, this link survives terminal cleanup so schedule history can
   * be queried until the workflow itself is purged.
   */
  scheduleRunLink: (workflowId: string) =>
    `schedule-run-link:${encodeStorageKeyComponent(workflowId)}`,
  scheduleRunBySchedulePrefix: (scheduleId: string) =>
    `schedule-run-by-schedule:${encodeStorageKeyComponent(scheduleId)}:`,
  scheduleRunBySchedule: (scheduleId: string, workflowId: string) =>
    `schedule-run-by-schedule:${encodeStorageKeyComponent(scheduleId)}:${encodeStorageKeyComponent(workflowId)}`,
  operation: (queue: string, scheduledAt: number, id: string) =>
    `op:${queue}:${formatSortableTimestamp(scheduledAt)}:${id}`,
  operationInflight: (id: string) => `op:inflight:${id}`,
  operationQueued: (id: string) => `op:queued:${id}`,
  operationResolved: (id: string) => `op:resolved:${id}`,
  bulkOperationAuditPrefix: () => 'audit:bulk:',
  bulkOperationAudit: (timestamp: number, requestId: string, confirmationToken: string) =>
    `audit:bulk:${formatSortableTimestamp(timestamp)}:${encodeStorageKeyComponent(requestId)}:${encodeStorageKeyComponent(confirmationToken)}`,
  operationResolvedByTimePrefix: () => 'op:resolved-by-time:',
  operationResolvedByTime: (resolvedAt: number, id: string) =>
    `op:resolved-by-time:${formatSortableTimestamp(resolvedAt)}:${encodeStorageKeyComponent(id)}`,
  asyncActivity: (workflowId: string, token: string) =>
    `async-act:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(token)}`,
  // The raw `:resolution` suffix cannot collide with a token key: token
  // components are percent-encoded, so an encoded token never contains `:`.
  asyncActivityResolution: (workflowId: string, token: string) =>
    `async-act:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(token)}:resolution`,
  activityReconciliationPrefix: (workflowId: string) =>
    `actrec:v1:${encodeStorageKeyComponent(workflowId)}:`,
  activityReconciliation: (
    workflowId: string,
    activityName: string,
    idempotencyKeyDigest: string,
  ) =>
    `actrec:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(activityName)}:${idempotencyKeyDigest}`,
  eventPrefix: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:`,
  event: (workflowId: string, sequence: number) =>
    `ev:${encodeStorageKeyComponent(workflowId)}:${String(sequence).padStart(10, '0')}`,
  eventHead: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:head`,
  eventWatermark: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:watermark`,
  fleetEventPrefix: () => 'fleet-event:',
  fleetEvent: (sequence: number) => `fleet-event:${String(sequence).padStart(10, '0')}`,
  fleetEventTail: () => 'fleet-event-tail',
  fleetEventWatermark: () => 'fleet-event-watermark',
  fleetEventByWorkflowPrefix: (workflowId: string) =>
    `fleet-event-by-workflow:${encodeStorageKeyComponent(workflowId)}:`,
  fleetEventByWorkflow: (workflowId: string, sequence: number) =>
    `fleet-event-by-workflow:${encodeStorageKeyComponent(workflowId)}:${String(sequence).padStart(10, '0')}`,
  signal: (workflowId: string, name: string, id: string) =>
    signalStorageKey(workflowId, name, id, SIGNAL_SORT_CLASS_NORMAL),
  startSignal: (workflowId: string, name: string, id: string) =>
    signalStorageKey(workflowId, name, id, SIGNAL_SORT_CLASS_START),
  signalSequence: (workflowId: string) => `sigseq:v1:${encodeStorageKeyComponent(workflowId)}`,
  signalAcceptedResponsePrefix: (workflowId: string) =>
    `sigres:v1:${encodeStorageKeyComponent(workflowId)}:`,
  signalAcceptedResponse: (workflowId: string, name: string, signalId: string) =>
    `sigres:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(name)}:${encodeStorageKeyComponent(signalId)}`,
  deadline: (deadline: number, workflowId: string) =>
    `wf-deadline:${formatSortableTimestamp(deadline)}:${encodeStorageKeyComponent(workflowId)}`,
  terminalCleanup: (fireAt: number, timerId: string) =>
    `wf-cleanup:${formatSortableTimestamp(fireAt)}:${encodeStorageKeyComponent(timerId)}`,
  /**
   * Durable timer that drives a workflow's finalizer after a `cancelled`/`timed-out`
   * terminal (issue #446 Phase 2). Sortable by `fireAt` and scanned by its own
   * source (`wf-teardown:`) so it dispatches as the `teardown` timer kind rather
   * than `terminal-cleanup`. Re-armed with exponential backoff on a failed finalizer
   * attempt; the scheduler deletes the fired entry after the drive returns without
   * throwing, so a backoff reschedule is a write of a new entry at the later `fireAt`.
   */
  teardownTimer: (fireAt: number, timerId: string) =>
    `wf-teardown:${formatSortableTimestamp(fireAt)}:${encodeStorageKeyComponent(timerId)}`,
  delayedStart: (startAt: number, workflowId: string) =>
    `wf-delayed:${formatSortableTimestamp(startAt)}:${encodeStorageKeyComponent(workflowId)}`,
  terminalWorkflowPrefix: () => 'wf-terminal:',
  terminalWorkflow: (updatedAt: number, workflowId: string) =>
    `wf-terminal:${formatSortableTimestamp(updatedAt)}:${encodeStorageKeyComponent(workflowId)}`,
  attribute: (workflowId: string) => `attr:${encodeStorageKeyComponent(workflowId)}`,
  attributeIndex: (attributeName: string, encodedValue: string, workflowId: string) =>
    `idx:${attributeName}:${encodedValue}:${encodeStorageKeyComponent(workflowId)}`,
  tagIndex: (tag: string, workflowId: string) =>
    `tag:${encodeStorageKeyComponent(tag)}:${encodeStorageKeyComponent(workflowId)}`,
  updatePrefix: (workflowId: string) => `upd:${encodeStorageKeyComponent(workflowId)}:`,
  update: (workflowId: string, updateId: string) =>
    `upd:${encodeStorageKeyComponent(workflowId)}:${updateId}`,
  updateResponse: (updateId: string) => `upr:${updateId}`,
  updateIdempotency: (workflowId: string, key: string) =>
    `upk:${encodeStorageKeyComponent(workflowId)}:${key}`,
  /**
   * Maps a start `idempotencyKey` to the workflow id created for it. Written
   * atomically with the workflow record under a `conditionalBatch` gated on this
   * key being absent, so concurrent same-key starts converge on one workflow.
   * Unlike `updateIdempotency`, it is keyed by the idempotency key alone (no
   * workflow id) because the workflow id is the value it resolves to. It is
   * intentionally NOT swept on terminal cleanup: it must outlive the run so a
   * post-completion `startOrSignal` sees a terminal workflow (and conflicts)
   * rather than missing the mapping and creating a fresh run.
   */
  startIdempotency: (key: string) => `start-idem:${encodeStorageKeyComponent(key)}`,
  /**
   * The convergence signal id that `startOrSignal` derives from an idempotency
   * key so independent same-key callers deliver ONE signal. Deliberately uses the
   * RAW key (not `encodeStorageKeyComponent`): unlike `startIdempotency` this is a
   * signal id, not a storage key, and `validateSignalId` is character-agnostic, so
   * the raw key is always a valid id as long as it fits the byte cap (enforced as
   * ≤117 bytes so `"start-idem:"` + key stays within the 128-byte signal-id
   * ceiling). The two derivations are independent namespaces; both are individually
   * correct, so the raw-vs-encoded difference is harmless.
   */
  startIdempotencySignalId: (key: string) => `start-idem:${key}`,
  /** Scan prefix for engine liveness heartbeats (best-effort second-instance detection). */
  livenessPrefix: () => 'liveness:',
  /** Per-engine liveness heartbeat key. One key per engine instance under the shared store. */
  liveness: (instanceId: string) => `liveness:${encodeStorageKeyComponent(instanceId)}`,
  /**
   * Scan/match prefix for the lease-fenced single-writer ownership keys
   * ({@link KEYS.leaseEpoch} and {@link KEYS.leaseHolder}). Reserved so a
   * caller can recognize lease-owned keys; the lease itself uses the two exact
   * keys below, not a scan.
   */
  leasePrefix: () => 'lease:',
  /**
   * The fencing epoch for lease-fenced ownership. A single shared key (one lease
   * per durable store) holding an 8-byte big-endian uint64. It changes ONLY on
   * ownership transfer (initial acquire or a steal after expiry), never on a
   * renewal — so a holder's cached epoch stays stable across heartbeats and can
   * be used unchanged as a `conditionalBatch` fencing condition. Kept separate
   * from {@link KEYS.leaseHolder} precisely because `conditionalBatch` compares
   * the whole stored value as bytes: folding the churning holder fields into the
   * fencing token would make every renewal invalidate the fence.
   */
  leaseEpoch: () => 'lease:epoch',
  /**
   * The current lease holder record for lease-fenced ownership. A single shared
   * key (one lease per durable store) holding a JSON `{ holderId, expiresAt,
   * epoch }`. Renewed every heartbeat tick (the `expiresAt` field advances), so
   * its bytes churn and it must NOT be used as the fencing token — see
   * {@link KEYS.leaseEpoch}.
   */
  leaseHolder: () => 'lease:holder',
  ...APPLICATION_MAILBOX_KEYS,
  ...OWNERSHIP_CLAIM_KEYS,
  budget: (namespace: string, period: string, date: string) =>
    `budget:${namespace}:${period}:${date}`,
  review: (workflowId: string, reviewId: string) =>
    `review:${encodeStorageKeyComponent(workflowId)}:${reviewId}`,
  workflowHeaders: (workflowId: string) => `wf-headers:${encodeStorageKeyComponent(workflowId)}`,
  childCancellationPrefix: (workflowId: string) =>
    `child-cancel:${encodeStorageKeyComponent(workflowId)}:`,
  childCancellation: (workflowId: string, childWorkflowId: string) =>
    `child-cancel:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(childWorkflowId)}`,
  childWorkflowByParentPrefix: (parentWorkflowId: string, parentWorkflowExecutionToken?: string) =>
    `child-by-parent:${encodeStorageKeyComponent(parentWorkflowId)}:${
      parentWorkflowExecutionToken === undefined
        ? ''
        : `${encodeStorageKeyComponent(parentWorkflowExecutionToken)}:`
    }`,
  childWorkflowByParent: (
    parentWorkflowId: string,
    parentWorkflowExecutionToken: string | undefined,
    childWorkflowId: string,
  ) =>
    `child-by-parent:${encodeStorageKeyComponent(parentWorkflowId)}:${
      parentWorkflowExecutionToken === undefined
        ? ''
        : `${encodeStorageKeyComponent(parentWorkflowExecutionToken)}:`
    }${encodeStorageKeyComponent(childWorkflowId)}`,
  terminalCleanupNeeded: (workflowId: string) =>
    `wf-cleanup-needed:${encodeStorageKeyComponent(workflowId)}`,
  workflowConcurrency: (workflowType: string, partitionKey: string) =>
    `wf-concurrency:${encodeStorageKeyComponent(workflowType)}:${encodeStorageKeyComponent(partitionKey)}`,
  workflowConcurrencyHolder: (workflowId: string) =>
    `wf-concurrency-holder:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Presence-only marker written at start only when a run is launched with a
   * non-serialized `services` value (see `start-batch.ts`). It lets a
   * fresh-process recovery tell a run whose services were lost on crash apart
   * from one that never had any — the services value itself is never persisted,
   * so this bit is the only durable trace. Cleared on terminal cleanup.
   */
  workflowHasServices: (workflowId: string) =>
    `wf-has-services:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Last-write-wins payload that `ctx.setFinalizerState(value)` records for a
   * workflow's definition-level `finalizer` activity (issue #446). Staged as a
   * pending atomic side-effect so it commits with the next checkpoint or the
   * terminal batch, and swept on terminal cleanup.
   *
   * **Current behavior (this release): recorded only.** Nothing reads this value
   * yet. **Planned behavior (future release):** the engine will pass the decoded
   * value as the finalizer's input when driving teardown after a
   * `cancelled`/`timed-out` terminal, where presence means "a resource was
   * recorded" and absence means the finalizer is skipped.
   */
  finalizerState: (workflowId: string) =>
    `wf-finalizer-state:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Durable execution-claim + attempt marker for a workflow that owes a finalizer
   * run after a `cancelled`/`timed-out` terminal (issue #446 Phase 2). Mirrors the
   * `wf-cleanup-needed:` lifecycle. The value is the encoded claim record
   * `{ status: 'owed' | 'running'; attempts: number; token: string; claimedAt?: number }`:
   * the engine fenced-CAS's `owed → running` (stamping `claimedAt`) before invoking the
   * finalizer, and settle-CAS's the exact `running` bytes it wrote when clearing or
   * rescheduling. Liveness is decided purely by TIME: a `running` claim is reclaimable
   * once `claimedAt` is older than the finalizer's per-attempt timeout plus a margin
   * (see `teardownStaleThresholdMs`), so crash recovery is an ordinary stale-claim retry
   * driven by the timer that survived the terminal batch — there is no in-memory liveness
   * set and no epoch in the record. The cost is that a finalizer running past the stale
   * threshold may be re-driven concurrently, which is why workflow finalizers must be
   * idempotent. Present while teardown is outstanding; deleted by the finalizer on
   * success or when it dead-letters, which is what unblocks purge.
   */
  teardownOwed: (workflowId: string) =>
    `wf-teardown-needed:${encodeStorageKeyComponent(workflowId)}`,
  /** Durable successful finalizer outcome, retained until workflow purge or retention. */
  teardownSucceeded: (workflowId: string) =>
    `wf-teardown-succeeded:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Durable audit record written when a workflow's finalizer permanently fails — the
   * retry horizon is reached, or the recorded resource state vanished so the finalizer
   * can never run (issue #446 Phase 2). Holds the `TeardownDeadLetterRecord` shape
   * `{ type, lastError, attempts, deadLetteredAt, workflowExecutionToken?, finalizerInput? }`.
   * **Excluded from the workflow purge delete-set** so it survives as the operator's
   * evidence of a leaked external resource and remains queryable through the durable
   * finalizer-status API after purge.
   */
  teardownDeadLetter: (workflowId: string) =>
    `wf-teardown-deadletter:${encodeStorageKeyComponent(workflowId)}`,
  offload: (workflowId: string, key: string) =>
    `offload:${encodeStorageKeyComponent(workflowId)}:${key}`,
  archive: (workflowId: string, key: string) =>
    `archive:${encodeStorageKeyComponent(workflowId)}:${key}`,
  stateExecution: (ownerWorkflowId: string, key: string) =>
    `state:execution:${encodeStorageKeyComponent(ownerWorkflowId)}:${encodeStorageKeyComponent(key)}`,
  stateWorkflow: (workflowType: string, key: string) =>
    `state:workflow-scope:${DEFAULT_SCOPE}:${encodeStorageKeyComponent(workflowType)}:${encodeStorageKeyComponent(key)}`,
  streamChunkPrefix: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:chunk:`,
  streamChunk: (workflowId: string, key: string, chunkIndex: number) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:chunk:${String(chunkIndex).padStart(10, '0')}`,
  streamTail: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:tail`,
  streamMetadata: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:meta`,
  budgetCharged: (operationId: string) => `budget-charged:${operationId}`,
  toolEffect: (workflowId: string, agentId: string, semanticHash: string) =>
    `tool-effect:${encodeStorageKeyComponent(workflowId)}:${agentId}:${semanticHash}`,
  // Visibility index timestamps lex-sort correctly; see `workflow-indexes.ts`.
  workflowVisibilityStatus: (status: string, workflowId: string) =>
    `wf-idx-status:${encodeStorageKeyComponent(status)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityType: (type: string, workflowId: string) =>
    `wf-idx-type:${encodeStorageKeyComponent(type)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityCreated: (createdAt: number, workflowId: string) =>
    `wf-idx-created:${formatSortableTimestamp(createdAt)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityUpdated: (updatedAt: number, workflowId: string) =>
    `wf-idx-updated:${formatSortableTimestamp(updatedAt)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityDeadline: (deadline: number, workflowId: string) =>
    `wf-idx-deadline:${formatSortableTimestamp(deadline)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityManifest: (workflowId: string) =>
    `wf-idx-manifest:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityMetaVersion: () => 'wf-idx-meta:version',
  workflowVisibilityMetaBuiltAt: () => 'wf-idx-meta:built-at',
  workflowVisibilityMetaCursor: () => 'wf-idx-meta:cursor',
} as const;
