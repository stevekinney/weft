/**
 * Engine-level bootstrap for `ownership: 'workflow-lease'`
 * ([ADR 0002](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md)):
 * runs the two construction-time capability gates ({@link bootstrapOwnershipGates})
 * and, once they pass, constructs this engine's {@link WorkflowClaimRegistry}
 * and its claim-renewal task. Standalone from `Engine`/`EngineInternals` so the
 * idempotency, disposal-race, and background-task-mode wiring in
 * `src/core/engine/index.ts` stay thin call sites over one tested unit.
 *
 * **`ownership: 'lease'` is deliberately untouched here.** ADR 0002 describes
 * Gate 2 (the ownership-mode marker) as "extending the existing `ownership:
 * 'lease'` check" — this module does not do that. Wiring Gate 2 into the
 * `'lease'` path is out of scope for this stage, which requires `'lease'`
 * acquisition, fencing, health, and disposal to stay byte-for-byte unchanged.
 * This is a real, intentional ADR/code gap left for a follow-up stage, not an
 * oversight.
 *
 * **The renewal task's reclaim scan is fully wired here**, via
 * {@link createWorkflowClaimReclaimTarget}: candidate discovery
 * (`workflow-claim-reclaim-scan.ts`) plus a bounded-retry `registry.takeover`
 * loop, per the ADR's "bounded at 5 attempts" row. **Owner-side signal polling
 * is only a pass-through seam** — {@link WorkflowLeaseOwnershipBootstrapOptions.signalPollTarget}
 * is threaded straight into the renewal task, but this module cannot build a
 * real target itself: that needs `EngineInternals.signalWaiters` and
 * `inline-parking.ts`'s `resumeParkedInlineWorkflow`, both outside this
 * module's scope. A caller in `src/core/engine/index.ts` is expected to build
 * and pass one; until it does, `result.signalPoll` on every pass stays
 * `undefined` in production, even though the mechanism is fully tested at the
 * task level against a structural fake.
 *
 * @module core/engine/ownership-bootstrap
 */

import type { Storage } from '../../storage/interface.ts';
import type { OwnerSideSignalPollTarget } from './owner-side-signal-poll.ts';
import { bootstrapOwnershipGates } from './ownership-mode-marker.ts';
import { WorkflowClaimMetricsCollector } from './workflow-claim-metrics.ts';
import { listWorkflowClaimReclaimCandidates } from './workflow-claim-reclaim-scan.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';
import {
  createWorkflowClaimRenewalTask,
  type WorkflowClaimReclaimAttemptResult,
  type WorkflowClaimReclaimTarget,
  type WorkflowClaimRenewalTarget,
  type WorkflowClaimRenewalTask,
} from './workflow-claim-renewal-task.ts';

/** Bound on retrying a lost-race `takeover` CAS for one reclaim candidate within one pass — ADR 0002's `takeover` row. */
export const WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS = 5;

/** Input to {@link bootstrapWorkflowLeaseOwnership}. */
export type WorkflowLeaseOwnershipBootstrapOptions = {
  storage: Storage;
  /** Engine-clock source (ms), injected so tests can drive it deterministically. */
  getNow: () => number;
  /** Resolved `workflowClaimTtl` (ms). */
  claimTtlMs: number;
  /** Resolved `workflowClaimRenewInterval` (ms). */
  claimRenewIntervalMs: number;
  /**
   * Optional owner-side signal-poll target, built by a caller with access to
   * `EngineInternals`/`inline-parking.ts`. See the module doc's signal-poll
   * paragraph. Omitted leaves `result.signalPoll` `undefined` on every pass.
   */
  signalPollTarget?: OwnerSideSignalPollTarget;
};

/**
 * Everything `Engine` needs to hold on `EngineInternals` once bootstrap
 * succeeds. `metrics` is the concrete {@link WorkflowClaimMetricsCollector} —
 * not just the structural `WorkflowClaimMetricsRecorder` interface it also
 * satisfies — so a caller (tests, a later Prometheus-exporter bridge) can read
 * `snapshot()` directly instead of needing a second recorder reference.
 */
export type WorkflowLeaseOwnershipBootstrapResult = {
  registry: WorkflowClaimRegistry;
  renewalTask: WorkflowClaimRenewalTask;
  metrics: WorkflowClaimMetricsCollector;
};

/**
 * Adapt a {@link WorkflowClaimRegistry} to the renewal task's
 * {@link WorkflowClaimRenewalTarget} contract. `registry.renew()`'s
 * discriminated result never throws on a lost CAS — background scanning must
 * isolate a per-workflow failure and continue, so every `WorkflowClaimRegistry`
 * method returns a result instead of throwing. This adapter is where that gets
 * converted to the renewal task's reject-on-failure contract, without adding a
 * throwing method to the registry itself, so the registry's "none throw"
 * contract stays intact for every other caller.
 *
 * `'renewed'` resolves. `'not-held'` also resolves rather than rejects: it is
 * the benign race against this engine's own `release()` (the registry stops
 * new renewals for a workflow before it reads the bytes `release()` conditions
 * on — see `workflow-claim-registry.ts`'s module doc), not a lost claim, and
 * counting it as a renewal failure would inflate
 * `weft_workflow_claim_renewal_failures_total` on ordinary terminal shutdown.
 * Only `'lost'` rejects. The registry's own `renew()` already emits
 * `WeftWorkflowClaimLostWarning` on a `'lost'` result, so this adapter does not
 * double-emit.
 *
 * Exported (only) so its three-branch mapping can be pinned directly against a
 * canned `WorkflowClaimRenewResult`, without needing a storage-timing race to
 * reach `'not-held'` through a real registry.
 */
export function createWorkflowClaimRenewalTarget(
  registry: WorkflowClaimRegistry,
): WorkflowClaimRenewalTarget {
  return {
    listHeldWorkflowIds: () => registry.listHeldWorkflowIds(),
    async renewWorkflowClaim(workflowId: string): Promise<void> {
      const result = await registry.renew(workflowId);
      if (result.status === 'lost') {
        throw new Error(`workflow "${workflowId}" lost its ownership claim during renewal`);
      }
    },
  };
}

/**
 * Adapt a {@link WorkflowClaimRegistry} plus `storage` to the renewal task's
 * {@link WorkflowClaimReclaimTarget} contract. Candidate discovery excludes
 * this engine's own currently-held ids (`registry.listHeldWorkflowIds()`) —
 * see `workflow-claim-reclaim-scan.ts`'s doc for why. `attemptWorkflowClaimTakeover`
 * retries a `'lost-race'` CAS, bounded at {@link WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS}
 * per the ADR, and records `weft_workflow_claim_attempts_total{outcome="backoff_skipped"}`
 * the moment the registry's own anti-thrash cooldown suppresses an attempt —
 * the one `WorkflowClaimAttemptOutcome` this stage wires; the other four
 * remain unrecorded by design (see the ADR's Observability section for the
 * full set — that wiring is a later stage's work).
 */
export function createWorkflowClaimReclaimTarget(
  registry: WorkflowClaimRegistry,
  storage: Storage,
  metrics: WorkflowClaimMetricsCollector,
): WorkflowClaimReclaimTarget {
  return {
    listReclaimCandidateWorkflowIds: () =>
      listWorkflowClaimReclaimCandidates(storage, new Set(registry.listHeldWorkflowIds())),
    async attemptWorkflowClaimTakeover(workflowId): Promise<WorkflowClaimReclaimAttemptResult> {
      for (let attempt = 0; attempt < WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS; attempt += 1) {
        const result = await registry.takeover(workflowId);
        switch (result.status) {
          case 'acquired':
            return { status: 'reclaimed' };
          case 'backoff-skipped':
            metrics.recordClaimAttempt('backoff_skipped');
            return { status: 'backoff-skipped' };
          case 'not-expired':
          case 'no-claim':
            return { status: 'not-eligible' };
          case 'lost-race':
            continue;
        }
      }
      return { status: 'lost-race' };
    },
  };
}

/**
 * Run Gate 1 + Gate 2 for `ownership: 'workflow-lease'`, then construct this
 * engine's {@link WorkflowClaimRegistry} and claim-renewal task. Does not
 * start the renewal task's interval — the caller decides interval-mode vs.
 * `runMaintenance()`-driven mode, since only it knows `backgroundTaskMode`.
 * Throws whatever {@link bootstrapOwnershipGates} throws (a bare `Error` for
 * Gate 1, `OwnershipModeMismatchError` for Gate 2) before constructing
 * anything durable-adjacent — a failed gate leaves no registry, no renewal
 * task, and no metrics recorder behind.
 *
 * The renewal task's `onPassComplete` seam bridges every pass into the
 * returned {@link WorkflowClaimMetricsRecorder}: each `'failed'` renewal
 * outcome records one `weft_workflow_claim_renewal_failures_total`, and the
 * registry's own currently-held-id count (read fresh after the pass, since a
 * failed renewal can drop a claim mid-pass) sets `weft_workflow_claims_active`.
 */
export async function bootstrapWorkflowLeaseOwnership(
  options: WorkflowLeaseOwnershipBootstrapOptions,
): Promise<WorkflowLeaseOwnershipBootstrapResult> {
  await bootstrapOwnershipGates({
    storage: options.storage,
    ownershipMode: 'workflow-lease',
    getNow: options.getNow,
  });

  const registry = new WorkflowClaimRegistry({
    storage: options.storage,
    engineId: crypto.randomUUID(),
    getNow: options.getNow,
    claimTtlMs: options.claimTtlMs,
    claimRenewIntervalMs: options.claimRenewIntervalMs,
  });
  const metrics = new WorkflowClaimMetricsCollector();
  const renewalTask = createWorkflowClaimRenewalTask({
    target: createWorkflowClaimRenewalTarget(registry),
    reclaimTarget: createWorkflowClaimReclaimTarget(registry, options.storage, metrics),
    ...(options.signalPollTarget === undefined
      ? {}
      : { signalPollTarget: options.signalPollTarget }),
    getNow: options.getNow,
    intervalMs: options.claimRenewIntervalMs,
    onPassComplete: (result) => {
      for (const outcome of result.outcomes) {
        if (outcome.status === 'failed') {
          metrics.recordClaimRenewalFailure();
        }
      }
      metrics.setActiveClaims(registry.listHeldWorkflowIds().length);
    },
  });

  return { registry, renewalTask, metrics };
}
