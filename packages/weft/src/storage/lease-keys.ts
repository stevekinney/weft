/**
 * Storage key builders for engine liveness heartbeats and the store-wide
 * lease-fenced single-writer lock.
 *
 * These are spread into `KEYS` in `interface.ts` rather than declared there, so
 * the liveness and lease keyspace can carry its full rationale without pushing
 * that file's documented line ceiling. Callers still reach them through `KEYS`,
 * which keeps one import contract for storage keys.
 *
 * @module storage/lease-keys
 */

import { encodeStorageKeyComponent } from './key-encoding.ts';

/**
 * Engine liveness heartbeat keys plus the lease-fenced single-writer ownership
 * keys (`ownership: 'lease'`).
 *
 * Spread into `KEYS`; not intended to be imported directly by engine code.
 */
export const LEASE_KEYS = {
  /** Scan prefix for engine liveness heartbeats (best-effort second-instance detection). */
  livenessPrefix: () => 'liveness:',
  /** Per-engine liveness heartbeat key. One key per engine instance under the shared store. */
  liveness: (instanceId: string) => `liveness:${encodeStorageKeyComponent(instanceId)}`,
  /**
   * Scan/match prefix for the lease-fenced single-writer ownership keys
   * (`leaseEpoch` and `leaseHolder`). Reserved so a caller can recognize
   * lease-owned keys; the lease itself uses the two exact keys below, not a scan.
   */
  leasePrefix: () => 'lease:',
  /**
   * The fencing epoch for lease-fenced ownership. A single shared key (one lease
   * per durable store) holding an 8-byte big-endian uint64. It changes ONLY on
   * ownership transfer (initial acquire or a steal after expiry), never on a
   * renewal — so a holder's cached epoch stays stable across heartbeats and can
   * be used unchanged as a `conditionalBatch` fencing condition. Kept separate
   * from `leaseHolder` precisely because `conditionalBatch` compares the whole
   * stored value as bytes: folding the churning holder fields into the fencing
   * token would make every renewal invalidate the fence.
   */
  leaseEpoch: () => 'lease:epoch',
  /**
   * The current lease holder record for lease-fenced ownership. A single shared
   * key (one lease per durable store) holding a JSON `{ holderId, expiresAt,
   * epoch }`. Renewed every heartbeat tick (the `expiresAt` field advances), so
   * its bytes churn and it must NOT be used as the fencing token — see
   * `leaseEpoch`.
   */
  leaseHolder: () => 'lease:holder',
} as const;
