/**
 * The three individual sub-pass implementations `workflow-claim-renewal-task.ts`
 * composes into its combined `runOnce()` pass and, in interval mode, its two
 * independently single-flight-guarded tick passes (see that module's
 * "Renewal cadence is independent of the reclaim scan and signal poll in
 * interval mode" doc section, WFT-79 Finding 2). Split into its own module so
 * `workflow-claim-renewal-task.ts` stays under the repository's
 * implementation-file-size ceiling; these are pure, target-driven functions
 * with no dependency on the renewal task's own scheduling/single-flight
 * state.
 *
 * Also home to every structural target/result type these sub-passes and
 * `workflow-claim-renewal-task.ts` share, for the same reason —
 * `ownership-bootstrap.ts` imports several of these types directly from
 * `workflow-claim-renewal-task.ts` (not from here), so that module re-exports
 * them; this module is the one place they are actually defined.
 *
 * @module core/engine/workflow-claim-renewal-subpasses
 */

import {
  runOwnerSideSignalPoll,
  type OwnerSideSignalPollResult,
  type OwnerSideSignalPollTarget,
} from './owner-side-signal-poll.ts';

/**
 * The minimal structural shape the renewal sub-pass needs from a per-workflow
 * claim holder. A `WorkflowClaimRegistry` (built separately) is expected to
 * satisfy this interface; it is defined locally, rather than imported, so
 * this module has no dependency on that registry's concrete shape or module
 * path.
 */
export type WorkflowClaimRenewalTarget = {
  /**
   * Every workflow id this engine currently holds a live claim for, active or
   * parked. Read fresh at the start of every pass — implementations may
   * return a live or a defensive-copy array; the caller never mutates it and
   * takes its own snapshot before iterating.
   */
  listHeldWorkflowIds(): readonly string[];
  /**
   * Renew this engine's claim for one workflow. Resolves when the renewal
   * committed; rejects (with any error shape) when it did not — a lost-race
   * CAS failure, a storage error, or anything else. The implementation is
   * responsible for its own per-workflow in-flight-renewal guard against a
   * concurrent `release`, and for reacting to a lost claim (aborting
   * in-flight work, emitting `WeftWorkflowClaimLostWarning`). The caller only
   * calls it, catches whatever it throws, and continues to the next
   * workflow.
   */
  renewWorkflowClaim(workflowId: string): Promise<void>;
};

/** One workflow's outcome within a single renewal pass. */
export type WorkflowClaimRenewalOutcome =
  | { workflowId: string; status: 'renewed' }
  | { workflowId: string; status: 'failed'; error: unknown };

/**
 * The minimal structural shape the reclaim-scan sub-pass needs. Defined
 * locally for the same decoupling reason as {@link WorkflowClaimRenewalTarget}
 * — expected to be satisfied by an adapter over
 * `listWorkflowClaimReclaimCandidates` (`workflow-claim-reclaim-scan.ts`) and
 * `WorkflowClaimRegistry.takeover`, built by `ownership-bootstrap.ts`.
 */
export type WorkflowClaimReclaimTarget = {
  /**
   * Every workflow id with a currently-persisted holder record this engine
   * does not itself already hold. Read fresh at the start of every pass.
   */
  listReclaimCandidateWorkflowIds(): Promise<readonly string[]>;
  /**
   * Attempt to reclaim one candidate. Retrying a lost-race CAS (bounded, per
   * the ADR, at 5 attempts within this call) and gating on the per-workflow-id
   * anti-thrash cooldown are the implementation's responsibility — the caller
   * calls it exactly once per candidate, catches whatever it throws, and
   * continues to the next one.
   */
  attemptWorkflowClaimTakeover(workflowId: string): Promise<WorkflowClaimReclaimAttemptResult>;
};

/** One candidate's non-throwing outcome from {@link WorkflowClaimReclaimTarget.attemptWorkflowClaimTakeover}. */
export type WorkflowClaimReclaimAttemptResult =
  | { status: 'reclaimed' }
  | { status: 'not-eligible' }
  | { status: 'backoff-skipped' }
  | { status: 'lost-race' };

/** One workflow's outcome within a single reclaim-scan pass. */
export type WorkflowClaimReclaimOutcome =
  | ({ workflowId: string } & WorkflowClaimReclaimAttemptResult)
  | { workflowId: string; status: 'error'; error: unknown };

/**
 * The reclaim-scan sub-pass's result. `'discovery-failed'` covers
 * `listReclaimCandidateWorkflowIds()` itself throwing — without a candidate
 * list there is no per-workflow loop to run, but that must not fail the rest
 * of an enclosing combined pass (renewals already committed by then, and a
 * `backgroundTasks: 'manual'` host awaiting `runMaintenance()` must not see a
 * rejected promise for a problem isolated to this one sub-step).
 */
export type WorkflowClaimReclaimPassResult =
  | { status: 'completed'; outcomes: WorkflowClaimReclaimOutcome[]; reclaimedCount: number }
  | { status: 'discovery-failed'; error: unknown };

/**
 * The owner-side signal-poll sub-pass's result. `'failed'` covers
 * {@link runOwnerSideSignalPoll} itself rejecting (e.g. its target's
 * `hasBufferedSignal` throwing) — same non-fatal-to-the-enclosing-pass
 * treatment as {@link WorkflowClaimReclaimPassResult}'s `'discovery-failed'`.
 */
export type WorkflowClaimSignalPollOutcome =
  | { status: 'completed'; result: OwnerSideSignalPollResult }
  | { status: 'failed'; error: unknown };

/**
 * Run one reclaim-scan sub-pass: list candidates, attempt each once, and
 * catch both a per-candidate throw and the listing call itself throwing. See
 * {@link WorkflowClaimReclaimPassResult}'s doc for why discovery failure is a
 * result, not a rejection.
 */
export async function runReclaimPass(
  target: WorkflowClaimReclaimTarget,
): Promise<WorkflowClaimReclaimPassResult> {
  let candidates: readonly string[];
  try {
    candidates = await target.listReclaimCandidateWorkflowIds();
  } catch (error) {
    return { status: 'discovery-failed', error };
  }
  const outcomes: WorkflowClaimReclaimOutcome[] = [];
  for (const workflowId of candidates) {
    try {
      const attempt = await target.attemptWorkflowClaimTakeover(workflowId);
      outcomes.push({ workflowId, ...attempt });
    } catch (error) {
      outcomes.push({ workflowId, status: 'error', error });
    }
  }
  return {
    status: 'completed',
    outcomes,
    reclaimedCount: outcomes.filter((outcome) => outcome.status === 'reclaimed').length,
  };
}

/**
 * Renew every id in `workflowIds` in turn, continuing past a per-workflow
 * failure. Pure loop — no clock reads, no `onPassComplete` — so it is shared
 * verbatim by `workflow-claim-renewal-task.ts`'s combined `runOnce()` pass
 * and interval mode's standalone renewal sub-pass.
 */
export async function runRenewalSubPass(
  target: WorkflowClaimRenewalTarget,
  workflowIds: readonly string[],
): Promise<{
  outcomes: WorkflowClaimRenewalOutcome[];
  renewedCount: number;
  failedCount: number;
}> {
  const outcomes: WorkflowClaimRenewalOutcome[] = [];
  for (const workflowId of workflowIds) {
    try {
      await target.renewWorkflowClaim(workflowId);
      outcomes.push({ workflowId, status: 'renewed' });
    } catch (error) {
      outcomes.push({ workflowId, status: 'failed', error });
    }
  }
  return {
    outcomes,
    renewedCount: outcomes.filter((outcome) => outcome.status === 'renewed').length,
    failedCount: outcomes.filter((outcome) => outcome.status === 'failed').length,
  };
}

/**
 * Run the owner-side signal-poll sub-step, translating a throw into the
 * `'failed'` result shape rather than letting it reject. Shared by
 * `workflow-claim-renewal-task.ts`'s combined `runOnce()` pass and interval
 * mode's standalone reclaim-plus-poll sub-pass.
 */
export async function runSignalPollSubPass(
  signalPollTarget: OwnerSideSignalPollTarget,
  getNow: () => number,
): Promise<WorkflowClaimSignalPollOutcome> {
  try {
    return {
      status: 'completed',
      result: await runOwnerSideSignalPoll({ target: signalPollTarget, getNow }),
    };
  } catch (error) {
    return { status: 'failed', error };
  }
}
