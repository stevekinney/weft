/**
 * Why a holder lost its lease while running. `deposed` is confirmed ownership
 * loss; `renewal-unconfirmable` means storage failures outlasted the last
 * confirmed lease expiry.
 *
 * @example
 * ```ts
 * import type { LeaseLostReason } from '@lostgradient/weft';
 *
 * function requiresImmediateHandoff(reason: LeaseLostReason): boolean {
 *   return reason === 'deposed';
 * }
 * void requiresImmediateHandoff;
 * ```
 */
export type LeaseLostReason = 'deposed' | 'renewal-unconfirmable';

/** Process-local, last-known ownership state exposed through the operator API. */
export type LeaseManagerHealth =
  | { status: 'no-lease'; holdsLease: false }
  | {
      status: 'healthy';
      holdsLease: true;
      holderId: string;
      heldSince: number;
      expiresAt: number;
      lastRenewedAt: number;
      fencingEpoch: number;
    }
  | {
      status: 'contested';
      holdsLease: false;
      lossReason?: LeaseLostReason;
      holderId: string;
      heldSince: number;
      expiresAt: number;
      lastRenewedAt: number;
      fencingEpoch: number;
    };

/**
 * Public engine ownership-health snapshot returned by
 * {@link Engine.getLeaseHealth} and `weft.system.lease`.
 *
 * @example
 * ```ts
 * import type { EngineLeaseHealth } from '@lostgradient/weft';
 *
 * function needsOperatorAttention(health: EngineLeaseHealth): boolean {
 *   return health.status === 'contested';
 * }
 * void needsOperatorAttention;
 * ```
 */
export type EngineLeaseHealth =
  | { mode: 'none'; status: 'disabled'; holdsLease: false }
  | ({ mode: 'lease' } & LeaseManagerHealth)
  | {
      mode: 'lease';
      status: 'contested';
      holdsLease: false;
      lossReason: 'deposed';
    };
