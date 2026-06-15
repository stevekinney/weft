/**
 * Resolution of the `ownership` posture options (`Engine.create({ ownership })`)
 * into {@link ResolvedOptions}. Extracted from `construction.ts` to keep that
 * file under the `max-lines` ceiling; mirrors the second-instance resolver's
 * "only validate when the feature is enabled" discipline.
 *
 * @module core/engine/ownership-options
 */

import type { EngineConstructorOptions, ResolvedOptions } from './engine-internal-types.ts';
import { normalizeRetentionDuration } from './validation.ts';

/** Default lease time-to-live for `ownership: 'lease'`. */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** Default lease renewal interval for `ownership: 'lease'`. */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 5_000;
/** Default boot-time lease acquisition wait window for `ownership: 'lease'`. */
export const DEFAULT_LEASE_WAIT_TIMEOUT_MS = 60_000;

/**
 * Resolve the ownership posture and lease tuning into their `ResolvedOptions`
 * fields. Defaults to `'none'`. The lease durations are documented as "ignored
 * when ownership is not 'lease'", so they are only normalized (and thus only
 * able to throw on an invalid value) when lease ownership is actually enabled —
 * an invalid duration must not make an off-by-default config fatal at boot.
 */
export function resolveOwnershipFields(
  options: EngineConstructorOptions | undefined,
): Pick<
  ResolvedOptions,
  'ownershipMode' | 'leaseTtlMs' | 'leaseRenewIntervalMs' | 'leaseWaitTimeoutMs'
> {
  const ownershipMode = options?.ownership ?? 'none';
  if (ownershipMode !== 'lease') {
    return {
      ownershipMode,
      leaseTtlMs: DEFAULT_LEASE_TTL_MS,
      leaseRenewIntervalMs: DEFAULT_LEASE_RENEW_INTERVAL_MS,
      leaseWaitTimeoutMs: DEFAULT_LEASE_WAIT_TIMEOUT_MS,
    };
  }
  const leaseTtlMs =
    normalizeRetentionDuration(options?.leaseTtl, 'options.leaseTtl') ?? DEFAULT_LEASE_TTL_MS;
  const leaseRenewIntervalMs =
    normalizeRetentionDuration(options?.leaseRenewInterval, 'options.leaseRenewInterval') ??
    DEFAULT_LEASE_RENEW_INTERVAL_MS;
  const leaseWaitTimeoutMs =
    normalizeRetentionDuration(options?.leaseWaitTimeout, 'options.leaseWaitTimeout') ??
    DEFAULT_LEASE_WAIT_TIMEOUT_MS;
  assertLeaseTimingCoherent(leaseTtlMs, leaseRenewIntervalMs, leaseWaitTimeoutMs);
  return { ownershipMode, leaseTtlMs, leaseRenewIntervalMs, leaseWaitTimeoutMs };
}

/**
 * Reject lease timing that cannot hold the lease: a renewal interval at or above
 * the TTL lets the lease lapse before (or exactly as) the first renewal fires, so
 * a second instance could acquire while the first still believes it owns the
 * lease — defeating the handoff the option exists to provide. Non-positive values
 * are equally nonsensical. `normalizeRetentionDuration` already rejects malformed
 * durations; this checks the cross-field relationship the lease protocol requires.
 */
function assertLeaseTimingCoherent(
  leaseTtlMs: number,
  leaseRenewIntervalMs: number,
  leaseWaitTimeoutMs: number,
): void {
  if (leaseTtlMs <= 0 || leaseRenewIntervalMs <= 0 || leaseWaitTimeoutMs <= 0) {
    throw new Error(
      `ownership: 'lease' requires positive leaseTtl, leaseRenewInterval, and leaseWaitTimeout ` +
        `(got leaseTtl=${leaseTtlMs}ms, leaseRenewInterval=${leaseRenewIntervalMs}ms, leaseWaitTimeout=${leaseWaitTimeoutMs}ms).`,
    );
  }
  if (leaseRenewIntervalMs >= leaseTtlMs) {
    throw new Error(
      `ownership: 'lease' requires leaseRenewInterval (${leaseRenewIntervalMs}ms) to be strictly less than ` +
        `leaseTtl (${leaseTtlMs}ms), so a renewal fires before the lease can lapse.`,
    );
  }
}
