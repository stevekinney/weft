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
 * **Three kinds of capability, treated differently:**
 * - **Runtime-gated:** `conditionalBatch` is the only capability the engine
 *   enforces at runtime (see {@link requireStorageCapability}). A backend may
 *   legitimately omit compare-and-swap, so its absence fails fast with a clear
 *   diagnostic at the first feature that needs it.
 * - **Trusted correctness contracts:** `atomicBatch`, `readAfterWrite`, and
 *   `scanConsistency` are read by the engine but NOT verified at runtime. If a
 *   backend reports `atomicBatch: true` but applies batches non-atomically, the
 *   failure mode is checkpoint corruption, not a missing feature — honesty is
 *   the adapter author's responsibility.
 * - **Operational hint:** `boundedRangeDelete` is a strength-of-implementation
 *   claim about the adapter's bounded-delete methods — `deletePrefix()` and, when
 *   present, `deleteRange()` — being single bounded range ops rather than a
 *   scan-and-delete fallback. It affects performance, not correctness, and nothing
 *   gates on it. In every built-in adapter the two methods share the same native
 *   path (both native, or both fall back), so one boolean describes both honestly;
 *   a custom adapter whose two methods differ in strength should report `false`
 *   rather than overclaim.
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
 * import { MemoryStorage } from '@lostgradient/weft';
 * import type { StorageCapabilities } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * const caps: StorageCapabilities = storage.capabilities();
 * console.log(caps.conditionalBatch); // true
 * console.log(caps.readAfterWrite);   // 'linearizable'
 * ```
 */
export type StorageCapabilities = {
  /**
   * Persistence scope for data written through this storage instance.
   * - `ephemeral`: data is process- or session-local and is lost when the
   *   runtime exits or the storage area is cleared (`MemoryStorage`, in-memory
   *   SQLite/libSQL, browser-extension session storage).
   * - `local`: data is durably persisted by a local runtime or origin-backed
   *   store suitable for same-process recovery checks.
   * - `remote`: data is owned by a remote service or synchronized storage area
   *   whose durability and freshness depend on that service.
   */
  persistence?: 'ephemeral' | 'local' | 'remote';
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
   * The adapter's bounded-delete methods — `deletePrefix()` and, when present,
   * `deleteRange()` — are implemented natively against the backend's own range
   * machinery rather than as a generic client-side scan-then-`batch()` loop:
   * a single range-scoped SQL `DELETE`, an `IDBKeyRange` delete, or an
   * in-memory range-bounded delete. Adapters that use a two-phase approach
   * (scan keys into an array, then delete in a batch) report `false` even if
   * the delete phase runs in a single transaction — the two-phase pattern IS
   * the scan-and-delete fallback. Adapters that only fall back to the derived
   * `storageDeletePrefixCore`/`storageDeleteRangeCore` helpers also report
   * `false` even though those methods work. This is a strength-of-implementation
   * claim about the adapter's own methods, not a guarantee about a remote
   * backend behind it; an adapter whose two methods differ in strength reports
   * `false`.
   */
  boundedRangeDelete: boolean;
};

/**
 * The boolean capabilities the engine enforces at runtime via
 * {@link requireStorageCapability}. Today this is only `conditionalBatch` —
 * see the "three kinds of capability" note on {@link StorageCapabilities}. A
 * future capability that needs gating is added here deliberately, keeping the
 * type in lockstep with what is actually enforced rather than implying every
 * boolean capability is gateable.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { requireStorageCapability } from '@lostgradient/weft/storage/interface';
 * import type { GatedStorageCapabilityKey } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * // The third argument's type is GatedStorageCapabilityKey — only the
 * // runtime-gated 'conditionalBatch' is accepted.
 * const capability: GatedStorageCapabilityKey = 'conditionalBatch';
 * requireStorageCapability(storage, capability, 'MyFeature compare-and-swap');
 * ```
 */
export type GatedStorageCapabilityKey = 'conditionalBatch';

/**
 * Fail fast when a feature requires a runtime-gated storage capability the
 * backend does not provide. Reads the honest {@link StorageCapabilities} report
 * (not mere method presence), so a value-transforming decorator that downgrades
 * a capability is respected. Call this at the first use of a feature — not at
 * engine startup — so the diagnostic points at the operation that needs the
 * guarantee.
 *
 * Only {@link GatedStorageCapabilityKey} capabilities are accepted: the
 * non-gated `atomicBatch`/`readAfterWrite`/`scanConsistency` are trusted
 * contracts the engine does not enforce, and `boundedRangeDelete` is an
 * operational hint, so gating on any of them would be meaningless.
 *
 * @throws {Error} When `storage.capabilities()[capability]` is `false`.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { requireStorageCapability } from '@lostgradient/weft/storage/interface';
 *
 * await using storage = new MemoryStorage();
 * requireStorageCapability(storage, 'conditionalBatch', 'AtomicState compare-and-swap');
 * // Memory supports conditionalBatch, so this returns without throwing.
 * ```
 */
export function requireStorageCapability(
  storage: Storage,
  capability: GatedStorageCapabilityKey,
  featureName: string,
): void {
  if (!storage.capabilities()[capability]) {
    throw new Error(
      `Feature "${featureName}" requires storage capability "${capability}", but this storage backend does not provide it.`,
    );
  }
}

/**
 * Fail fast when a storage backend is not conservative enough for boot-time
 * durable recovery. This is intentionally stricter than the engine's per-feature
 * gates: it rejects ephemeral, eventual, best-effort, non-atomic, and non-CAS
 * storage before an application starts in durable mode.
 *
 * Persistence may be `local` (a same-process file-backed store) or `remote` (a
 * durable service such as Neon Postgres). A `remote` backend is acceptable only
 * because the other four axes are still required at their strongest:
 * `linearizable` read-after-write, `snapshot` scans, atomic batches, and
 * compare-and-swap. A remote store that cannot promise all four (an eventually
 * consistent HTTP backend, say) is still rejected — by those axes, not by its
 * persistence scope.
 *
 * @throws {Error} When the backend's capability row is not suitable for recovery.
 *
 * @example
 * ```ts
 * import { assertDurableStorageForRecovery } from '@lostgradient/weft';
 * import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';
 *
 * await using storage = new SQLiteStorage('./weft.db');
 * assertDurableStorageForRecovery(storage);
 * ```
 */
export function assertDurableStorageForRecovery(storage: Storage): void {
  const capabilities = storage.capabilities();
  const failures: string[] = [];

  if (capabilities.persistence !== 'local' && capabilities.persistence !== 'remote') {
    failures.push(`persistence must be "local" or "remote" (got "${capabilities.persistence}")`);
  }
  if (capabilities.readAfterWrite !== 'linearizable') {
    failures.push(`readAfterWrite must be "linearizable" (got "${capabilities.readAfterWrite}")`);
  }
  if (capabilities.scanConsistency !== 'snapshot') {
    failures.push(`scanConsistency must be "snapshot" (got "${capabilities.scanConsistency}")`);
  }
  if (!capabilities.atomicBatch) {
    failures.push('atomicBatch must be true');
  }
  if (!capabilities.conditionalBatch) {
    failures.push('conditionalBatch must be true');
  }

  if (failures.length > 0) {
    throw new Error(`Storage is not durable enough for recovery: ${failures.join('; ')}.`);
  }
}
