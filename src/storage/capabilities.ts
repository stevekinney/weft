/**
 * Storage consistency/feature capability types and the runtime gate that acts
 * on them. Split out from `interface.ts` to keep that module focused. The
 * `Storage` interface lives in `interface.ts` and imports these types; this
 * module imports `Storage` type-only, so there is no runtime import cycle.
 *
 * @module storage/capabilities
 */

import type { Storage } from './interface.ts';

/**
 * Honest, self-reported consistency and feature profile for a {@link Storage}
 * backend, returned by {@link Storage.capabilities}. Values describe the
 * guarantees a backend actually provides, not what callers wish it provided.
 *
 * **Two kinds of capability.** Only `conditionalBatch` is gated at runtime
 * (see {@link requireStorageCapability}): a backend may legitimately omit
 * compare-and-swap, so its absence fails fast with a clear diagnostic at first
 * use. The remaining fields — `atomicBatch`, `readAfterWrite`,
 * `scanConsistency`, `boundedRangeDelete` — are **trusted correctness
 * contracts** the engine reads but does NOT verify at runtime. If a backend
 * reports `atomicBatch: true` but applies batches non-atomically, the failure
 * mode is checkpoint corruption, not a missing feature: honesty is the adapter
 * author's responsibility.
 *
 * **Why the engine needs these.** Checkpoint commit relies on `atomicBatch`
 * (all-or-nothing); resume relies on `readAfterWrite` (the just-written
 * checkpoint must be observable on the next read); visibility/index scans rely
 * on `scanConsistency` (a scan must not observe torn writes); compare-and-swap
 * state and quota reservation rely on `conditionalBatch`.
 *
 * **Consistency-level scope.** All levels are scoped to a single `Storage`
 * instance. The engine uses one storage instance shared across concurrent
 * workflows, so `linearizable` is the value it relies on for built-in
 * single-process backends.
 *
 * **Opaque-value invariant.** Storage adapters and decorators MUST treat stored
 * values as opaque bytes and MUST NOT inspect or depend on value contents;
 * values MAY later be encrypted or compressed. The engine ranges only over
 * keys, never value bytes. A value-transforming decorator (e.g.
 * `CompressedStorage`) MUST therefore downgrade `conditionalBatch` to `false`,
 * because a caller-supplied `expectedValue` cannot byte-match the transformed
 * stored value.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from 'weft';
 * import type { StorageCapabilities } from 'weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * const caps: StorageCapabilities = storage.capabilities();
 * console.log(caps.conditionalBatch); // true
 * console.log(caps.readAfterWrite);   // 'linearizable'
 * ```
 */
export type StorageCapabilities = {
  /**
   * Visibility of a completed write to a later read, scoped to one `Storage`
   * instance.
   * - `linearizable`: a completed `put`/`batch` is observable by **any**
   *   subsequent read through this instance, including reads issued by other
   *   concurrent callers sharing the instance (single-process backends
   *   serialize all callers).
   * - `session`: only the **same caller's own** ordered operation chain is
   *   guaranteed to read its writes; a concurrent caller sharing the instance,
   *   or a separate instance/replica, may lag.
   * - `eventual`: even a same-instance read may not observe a just-completed
   *   write.
   */
  readAfterWrite: 'linearizable' | 'session' | 'eventual';
  /**
   * Consistency of a single `scan()` iteration relative to concurrent writes.
   * - `snapshot`: the scan observes one point-in-time view; concurrent writes
   *   never appear partially within the iteration.
   * - `best-effort`: the scan may interleave with concurrent writes.
   */
  scanConsistency: 'snapshot' | 'best-effort';
  /**
   * `batch()` applies all operations atomically (all-or-nothing). Trusted
   * correctness contract — a `true` value the engine relies on for checkpoint
   * commit and does not verify at runtime.
   */
  atomicBatch: boolean;
  /** `conditionalBatch()` compare-and-swap preconditions are supported. */
  conditionalBatch: boolean;
  /**
   * `deletePrefix()` is implemented as a bounded range operation (a single
   * range-scoped SQL `DELETE`, an `IDBKeyRange` delete, an LMDB range delete in
   * one write transaction, or an in-memory range-bounded delete), NOT a
   * client-side scan-then-delete loop. Adapters that only fall back to the
   * derived `storageDeletePrefixCore` helper report `false` even though
   * `deletePrefix()` works. This is a strength-of-implementation claim about the
   * adapter's own method, not a guarantee about a remote backend behind it.
   */
  boundedRangeDelete: boolean;
};

/**
 * Capability keys whose values are booleans, and therefore gateable via
 * {@link requireStorageCapability}. Resolves to the union
 * `'atomicBatch' | 'conditionalBatch' | 'boundedRangeDelete'`, excluding the
 * enum-valued `readAfterWrite` and `scanConsistency`.
 *
 * @example
 * ```ts
 * import type { BooleanStorageCapabilityKey } from 'weft/storage/interface';
 *
 * // Only boolean capabilities are assignable.
 * const gateable: BooleanStorageCapabilityKey = 'conditionalBatch';
 * console.log(gateable); // 'conditionalBatch'
 * ```
 */
export type BooleanStorageCapabilityKey = {
  [K in keyof StorageCapabilities]: StorageCapabilities[K] extends boolean ? K : never;
}[keyof StorageCapabilities];

/**
 * Fail fast when a feature requires a boolean storage capability the backend
 * does not provide. Reads the honest {@link StorageCapabilities} report (not
 * mere method presence), so a value-transforming decorator that downgrades a
 * capability is respected. Call this at the first use of a feature — not at
 * engine startup — so the diagnostic points at the operation that needs the
 * guarantee.
 *
 * @throws {Error} When `storage.capabilities()[capability]` is `false`.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from 'weft';
 * import { requireStorageCapability } from 'weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * requireStorageCapability(storage, 'conditionalBatch', 'AtomicState compare-and-swap');
 * // Memory supports conditionalBatch, so this returns without throwing.
 * ```
 */
export function requireStorageCapability(
  storage: Storage,
  capability: BooleanStorageCapabilityKey,
  featureName: string,
): void {
  if (!storage.capabilities()[capability]) {
    throw new Error(
      `Feature "${featureName}" requires storage capability "${capability}", but this storage backend does not provide it.`,
    );
  }
}
