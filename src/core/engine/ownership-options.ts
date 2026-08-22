/**
 * Resolution of the `ownership` posture options (`Engine.create({ ownership })`)
 * into {@link ResolvedOptions}. Extracted from `construction.ts` to keep that
 * file under the `max-lines` ceiling; mirrors the second-instance resolver's
 * "only validate when the feature is enabled" discipline.
 *
 * `ownership` is a three-member discriminated union — `'none'`, `'lease'`
 * (a single store-wide lease), and `'workflow-lease'` (per-workflow fencing,
 * ADR 0002 at
 * `documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md`).
 * This module only widens and validates the option surface: it resolves the
 * `workflowClaimTtl`/`workflowClaimRenewInterval` tuning fields and rejects
 * incoherent configuration, but no engine behavior yet claims to fence
 * per-workflow execution — that lands in a later stage of the ADR rollout.
 *
 * @module core/engine/ownership-options
 */

import type { EngineConstructorOptions, ResolvedOptions } from './engine-internal-types.ts';
import { normalizeRetentionDuration } from './validation.ts';
import { WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER } from './workflow-claim-transitions.ts';

/** Default lease time-to-live for `ownership: 'lease'`. */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** Default lease renewal interval for `ownership: 'lease'`. */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 5_000;
/** Default boot-time lease acquisition wait window for `ownership: 'lease'`. */
export const DEFAULT_LEASE_WAIT_TIMEOUT_MS = 60_000;

/** Default per-workflow claim time-to-live for `ownership: 'workflow-lease'`. */
export const DEFAULT_WORKFLOW_CLAIM_TTL_MS = 30_000;
/** Default per-workflow claim renewal interval for `ownership: 'workflow-lease'`. */
export const DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS = 5_000;

export { WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER };

export function resolveBackgroundTaskMode(
  options: EngineConstructorOptions | undefined,
): ResolvedOptions['backgroundTaskMode'] {
  const mode = options?.backgroundTasks ?? 'automatic';
  if (mode !== 'automatic' && mode !== 'manual') {
    throw new Error('options.backgroundTasks must be "automatic" or "manual" when provided');
  }
  if (mode === 'manual') {
    assertManualBackgroundTaskCompatibility(options);
  }
  return mode;
}

function assertManualBackgroundTaskCompatibility(
  options: EngineConstructorOptions | undefined,
): void {
  if (options?.detectSecondInstance === true) {
    throw new Error('detectSecondInstance cannot be enabled when backgroundTasks is "manual"');
  }
  if (options?.ownership === 'lease') {
    throw new Error('ownership cannot be "lease" when backgroundTasks is "manual"');
  }
  // `'workflow-lease'` is deliberately NOT rejected here (ADR 0002): unlike the
  // global lease, per-workflow claim renewal is driven by `runMaintenance()` on
  // every awaited host tick, the same way manual mode already drives
  // scheduler/cleanup/retention/alerts, so it does not need a process-local
  // interval.
}

/**
 * Resolve the ownership posture and its per-mode tuning into their
 * `ResolvedOptions` fields. Defaults to `'none'`. The lease and workflow-claim
 * durations are documented as "ignored" outside their own mode, so they are
 * only normalized (and thus only able to throw on an invalid value) when that
 * mode is actually selected — an invalid duration must not make an off-by-
 * default config fatal at boot.
 */
export function resolveOwnershipFields(
  options: EngineConstructorOptions | undefined,
): Pick<
  ResolvedOptions,
  | 'ownershipMode'
  | 'leaseTtlMs'
  | 'leaseRenewIntervalMs'
  | 'leaseWaitTimeoutMs'
  | 'workflowClaimTtlMs'
  | 'workflowClaimRenewIntervalMs'
> {
  const ownershipMode = assertKnownOwnershipMode(options?.ownership ?? 'none');
  const leaseDefaults = {
    leaseTtlMs: DEFAULT_LEASE_TTL_MS,
    leaseRenewIntervalMs: DEFAULT_LEASE_RENEW_INTERVAL_MS,
    leaseWaitTimeoutMs: DEFAULT_LEASE_WAIT_TIMEOUT_MS,
  };
  const workflowClaimDefaults = {
    workflowClaimTtlMs: DEFAULT_WORKFLOW_CLAIM_TTL_MS,
    workflowClaimRenewIntervalMs: DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  };

  if (ownershipMode === 'lease') {
    return { ownershipMode, ...resolveLeaseTiming(options), ...workflowClaimDefaults };
  }
  if (ownershipMode === 'workflow-lease') {
    assertWorkflowLeaseCompatibleWithSecondInstanceDetection(options);
    return { ownershipMode, ...leaseDefaults, ...resolveWorkflowClaimTiming(options) };
  }
  return { ownershipMode, ...leaseDefaults, ...workflowClaimDefaults };
}

function resolveLeaseTiming(
  options: EngineConstructorOptions | undefined,
): Pick<ResolvedOptions, 'leaseTtlMs' | 'leaseRenewIntervalMs' | 'leaseWaitTimeoutMs'> {
  const leaseTtlMs =
    normalizeRetentionDuration(options?.leaseTtl, 'options.leaseTtl') ?? DEFAULT_LEASE_TTL_MS;
  const leaseRenewIntervalMs =
    normalizeRetentionDuration(options?.leaseRenewInterval, 'options.leaseRenewInterval') ??
    DEFAULT_LEASE_RENEW_INTERVAL_MS;
  const leaseWaitTimeoutMs =
    normalizeRetentionDuration(options?.leaseWaitTimeout, 'options.leaseWaitTimeout') ??
    DEFAULT_LEASE_WAIT_TIMEOUT_MS;
  assertLeaseTimingCoherent(leaseTtlMs, leaseRenewIntervalMs, leaseWaitTimeoutMs);
  return { leaseTtlMs, leaseRenewIntervalMs, leaseWaitTimeoutMs };
}

function resolveWorkflowClaimTiming(
  options: EngineConstructorOptions | undefined,
): Pick<ResolvedOptions, 'workflowClaimTtlMs' | 'workflowClaimRenewIntervalMs'> {
  const workflowClaimTtlMs =
    normalizeRetentionDuration(options?.workflowClaimTtl, 'options.workflowClaimTtl') ??
    DEFAULT_WORKFLOW_CLAIM_TTL_MS;
  const workflowClaimRenewIntervalMs =
    normalizeRetentionDuration(
      options?.workflowClaimRenewInterval,
      'options.workflowClaimRenewInterval',
    ) ?? DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS;
  assertWorkflowClaimTimingCoherent(workflowClaimTtlMs, workflowClaimRenewIntervalMs);
  return { workflowClaimTtlMs, workflowClaimRenewIntervalMs };
}

/**
 * Fail fast on an unknown ownership posture rather than silently degrading to
 * `'none'`. A JS consumer (or a TS `as any`) passing a typo like
 * `ownership: 'leases'` must not quietly disable boot-time ownership — mirror the
 * runtime validation other string-union options get in construction. Returns the
 * value narrowed to the accepted union.
 */
function assertKnownOwnershipMode(mode: string): 'none' | 'lease' | 'workflow-lease' {
  if (mode !== 'none' && mode !== 'lease' && mode !== 'workflow-lease') {
    throw new Error(
      `Unknown ownership posture "${mode}". Expected 'none', 'lease', or 'workflow-lease'.`,
    );
  }
  return mode;
}

/**
 * `ownership: 'workflow-lease'` is rejected together with
 * `detectSecondInstance: true` (ADR 0002): second-instance detection is a
 * best-effort, single-global-owner liveness check, and `'workflow-lease'`
 * exists specifically so multiple engines can own the same store at once —
 * the two postures contradict each other. NOTE: the ADR describes this as
 * mirroring `ownership: 'lease'`, but `'lease'` + `detectSecondInstance: true`
 * is not actually rejected anywhere in the current codebase; that appears to
 * be a pre-existing gap the ADR misdescribes as already closed, not something
 * this stage is scoped to fix.
 */
function assertWorkflowLeaseCompatibleWithSecondInstanceDetection(
  options: EngineConstructorOptions | undefined,
): void {
  if (options?.detectSecondInstance === true) {
    throw new Error(
      "ownership: 'workflow-lease' cannot be combined with detectSecondInstance: true " +
        '— second-instance detection assumes a single global owner.',
    );
  }
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

/**
 * Workflow-lease analogue of {@link assertLeaseTimingCoherent}. Enforces the
 * same "renewal fires before the claim can lapse" relationship, plus the ADR's
 * additional safety-margin relationship: `workflowClaimTtl` must be at least
 * {@link WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER} times `workflowClaimRenewInterval`.
 * A renewal interval close to the TTL leaves no room for a slow renewal (a
 * scheduling delay, a storage round-trip) before the claim is eligible for
 * takeover; the multiplier turns "comfortably longer" into a mechanically
 * checkable floor.
 */
function assertWorkflowClaimTimingCoherent(
  workflowClaimTtlMs: number,
  workflowClaimRenewIntervalMs: number,
): void {
  if (workflowClaimTtlMs <= 0 || workflowClaimRenewIntervalMs <= 0) {
    throw new Error(
      `ownership: 'workflow-lease' requires positive workflowClaimTtl and workflowClaimRenewInterval ` +
        `(got workflowClaimTtl=${workflowClaimTtlMs}ms, workflowClaimRenewInterval=${workflowClaimRenewIntervalMs}ms).`,
    );
  }
  if (workflowClaimRenewIntervalMs >= workflowClaimTtlMs) {
    throw new Error(
      `ownership: 'workflow-lease' requires workflowClaimRenewInterval (${workflowClaimRenewIntervalMs}ms) ` +
        `to be strictly less than workflowClaimTtl (${workflowClaimTtlMs}ms), so a renewal fires before ` +
        `the claim can lapse.`,
    );
  }
  const requiredTtlMs = WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER * workflowClaimRenewIntervalMs;
  if (workflowClaimTtlMs < requiredTtlMs) {
    throw new Error(
      `ownership: 'workflow-lease' requires workflowClaimTtl (${workflowClaimTtlMs}ms) to be at least ` +
        `WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER (${WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER}) times ` +
        `workflowClaimRenewInterval (${workflowClaimRenewIntervalMs}ms), i.e. at least ${requiredTtlMs}ms, ` +
        `so a stalled renewal has margin before the claim can be taken over.`,
    );
  }
}
