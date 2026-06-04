import { requireStorageCapability, type StorageCapabilities } from './capabilities.ts';
import { DEFAULT_SCOPE } from './default-scope.ts';
import type { DeleteRangeOptions } from './delete-range.ts';
import {
  storageCountCore,
  storageDeletePrefixCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';

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
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };

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

/**
 * Encode an untrusted string so it is safe to embed in a colon-delimited storage key.
 *
 * @example
 * ```ts
 * import { encodeStorageKeyComponent } from '@lostgradient/weft/storage/interface';
 *
 * const safe = encodeStorageKeyComponent('user:123/profile');
 * console.log(safe); // 'user%3A123%2Fprofile'
 * ```
 */
export function encodeStorageKeyComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Decode a storage-key component produced by {@link encodeStorageKeyComponent}.
 * Throws when `value` is malformed percent-encoded text. Callers handling
 * untrusted input should prefer {@link tryDecodeStorageKeyComponent}.
 *
 * @throws {URIError} When `value` contains malformed percent-encoded data.
 *
 * @example
 * ```ts
 * import { encodeStorageKeyComponent, decodeStorageKeyComponent } from '@lostgradient/weft/storage/interface';
 *
 * const encoded = encodeStorageKeyComponent('user:123');
 * const decoded = decodeStorageKeyComponent(encoded);
 * console.log(decoded); // 'user:123'
 * ```
 */
export function decodeStorageKeyComponent(value: string): string {
  return decodeURIComponent(value);
}

/**
 * Decode a storage-key component produced by {@link encodeStorageKeyComponent}.
 * Returns `null` when the component is malformed instead of throwing.
 *
 * @example
 * ```ts
 * import { tryDecodeStorageKeyComponent } from '@lostgradient/weft/storage/interface';
 *
 * console.log(tryDecodeStorageKeyComponent('user%3A123')); // 'user:123'
 * console.log(tryDecodeStorageKeyComponent('%GG'));        // null
 * ```
 */
export function tryDecodeStorageKeyComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const formatSortableTimestamp = (timestamp: number): string => String(timestamp).padStart(16, '0');

/**
 * Key layout constants for hierarchical key encoding. Timestamps are
 * zero-padded to 16 digits for lexicographic ordering.
 *
 * This registry grows as storage features are added, which is why this file
 * carries a `max-lines: 600` override (above the repo default ceiling) in
 * `.oxlintrc.json` — 600 matches the documented split threshold in
 * `.claude/rules/conventions.md`. When `KEYS` next approaches that line, extract
 * it into its own module rather than raising the ceiling again.
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
  signal: (workflowId: string, name: string, id: string) =>
    `sig:${encodeStorageKeyComponent(workflowId)}:${name}:${encodeStorageKeyComponent(id)}`,
  signalSequence: (workflowId: string) => `sigseq:v1:${encodeStorageKeyComponent(workflowId)}`,
  signalAcceptedResponsePrefix: (workflowId: string) =>
    `sigres:v1:${encodeStorageKeyComponent(workflowId)}:`,
  signalAcceptedResponse: (workflowId: string, name: string, signalId: string) =>
    `sigres:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(name)}:${encodeStorageKeyComponent(signalId)}`,
  deadline: (deadline: number, workflowId: string) =>
    `wf-deadline:${formatSortableTimestamp(deadline)}:${encodeStorageKeyComponent(workflowId)}`,
  terminalCleanup: (fireAt: number, timerId: string) =>
    `wf-cleanup:${formatSortableTimestamp(fireAt)}:${encodeStorageKeyComponent(timerId)}`,
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
  budget: (namespace: string, period: string, date: string) =>
    `budget:${namespace}:${period}:${date}`,
  review: (workflowId: string, reviewId: string) =>
    `review:${encodeStorageKeyComponent(workflowId)}:${reviewId}`,
  workflowHeaders: (workflowId: string) => `wf-headers:${encodeStorageKeyComponent(workflowId)}`,
  terminalCleanupNeeded: (workflowId: string) =>
    `wf-cleanup-needed:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Presence-only marker written at start only when a run is launched with a
   * non-serialized `services` value (see `start-batch.ts`). It lets a
   * fresh-process recovery tell a run whose services were lost on crash apart
   * from one that never had any — the services value itself is never persisted,
   * so this bit is the only durable trace. Cleared on terminal cleanup.
   */
  workflowHasServices: (workflowId: string) =>
    `wf-has-services:${encodeStorageKeyComponent(workflowId)}`,
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
