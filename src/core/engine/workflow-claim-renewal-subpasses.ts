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
 * How many reclaim attempts may be in flight at once within a single pass.
 *
 * A serial loop lets one stuck candidate block every later one indefinitely —
 * `attemptWorkflowClaimTakeover` can await an `onReclaimed` drive that never
 * settles (e.g. a stalled storage read during replay), and a serial `for`
 * loop never reaches the next candidate until that await resolves. Each
 * candidate's takeover/acquire CAS and drive are independent per-workflow
 * operations, so running them through the same bounded pool
 * `runRenewalSubPass` uses for renewals is safe here too — see that
 * function's doc for why a fixed-width pool is the right middle ground
 * between full serialization and an unbounded stampede.
 */
export const WORKFLOW_CLAIM_RECLAIM_CONCURRENCY = 16;

/**
 * Run one reclaim-scan sub-pass: list candidates, attempt each through a
 * bounded pool (see {@link WORKFLOW_CLAIM_RECLAIM_CONCURRENCY}), and catch
 * both a per-candidate throw and the listing call itself throwing. See
 * {@link WorkflowClaimReclaimPassResult}'s doc for why discovery failure is a
 * result, not a rejection. `outcomes` stays in `candidates` order regardless
 * of the order attempts actually settle, matching `runRenewalSubPass`'s own
 * positional-result discipline.
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

  const outcomes = Array.from<WorkflowClaimReclaimOutcome>({ length: candidates.length });

  async function attemptOne(index: number): Promise<void> {
    const workflowId = candidates[index]!;
    try {
      const attempt = await target.attemptWorkflowClaimTakeover(workflowId);
      outcomes[index] = { workflowId, ...attempt };
    } catch (error) {
      outcomes[index] = { workflowId, status: 'error', error };
    }
  }

  // Mirrors `runRenewalSubPass`'s single-claim fast path: with at most one
  // candidate there is nothing to overlap, so skip the pool's extra async
  // frames.
  if (candidates.length <= 1) {
    for (const [index] of candidates.entries()) {
      await attemptOne(index);
    }
  } else {
    let nextIndex = 0;
    // Single-threaded JS makes this index handout safe without a lock: each
    // worker takes an index synchronously before its first await.
    async function attemptFromQueue(): Promise<void> {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= candidates.length) return;
        await attemptOne(index);
      }
    }
    const workerCount = Math.min(WORKFLOW_CLAIM_RECLAIM_CONCURRENCY, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, attemptFromQueue));
  }

  return {
    status: 'completed',
    outcomes,
    reclaimedCount: outcomes.filter((outcome) => outcome.status === 'reclaimed').length,
  };
}

/**
 * How many claim renewals may be in flight at once within a single pass.
 *
 * A serial loop costs one storage round trip per held claim before returning to
 * the first one, so with many claims on a high-latency shared store the pass
 * itself can outlast `workflowClaimTtl`: later claims expire before their first
 * renewal, and earlier ones expire before the next pass. Separating the reclaim
 * scan out of the renewal single-flight does not help — this loop is unbounded
 * in the number of claims, independently of what else shares the tick.
 *
 * The opposite extreme is just as wrong: renewing every claim at once turns
 * starvation into a storage stampede that the store may then rate-limit or
 * queue, reproducing the latency it was meant to avoid. So renewals run through
 * a fixed-width pool.
 *
 * Sixteen is chosen to be wide enough that per-request latency dominates rather
 * than accumulates — it cuts a 1000-claim pass from 1000 sequential round trips
 * to 63 — while staying within the connection budget a modest remote store
 * offers. It is deliberately a constant rather than an option: it trades two
 * failure modes against each other and neither is something a caller is well
 * placed to tune. Revisit it with measurements, not intuition.
 */
export const WORKFLOW_CLAIM_RENEWAL_CONCURRENCY = 16;

/**
 * Renew every id in `workflowIds`, continuing past a per-workflow failure.
 *
 * Renewals run through a bounded pool (see
 * {@link WORKFLOW_CLAIM_RENEWAL_CONCURRENCY}) rather than one at a time, so a
 * large claim set cannot push the pass past the claim validity window. Losing
 * one claim still stops only that workflow: each renewal keeps its own
 * `try`/`catch`, and `outcomes` stays in `workflowIds` order regardless of the
 * order results actually arrive, so callers and tests see a stable, positional
 * result.
 *
 * Pure — no clock reads, no `onPassComplete` — so it is shared verbatim by
 * `workflow-claim-renewal-task.ts`'s combined `runOnce()` pass and interval
 * mode's standalone renewal sub-pass.
 */
export async function runRenewalSubPass(
  target: WorkflowClaimRenewalTarget,
  workflowIds: readonly string[],
): Promise<{
  outcomes: WorkflowClaimRenewalOutcome[];
  renewedCount: number;
  failedCount: number;
}> {
  const outcomes = Array.from<WorkflowClaimRenewalOutcome>({ length: workflowIds.length });
  let nextIndex = 0;

  // Single-threaded JS makes this index handout safe without a lock: each
  // worker takes an index synchronously before its first await.
  async function renewFromQueue(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= workflowIds.length) return;
      const workflowId = workflowIds[index]!;
      try {
        await target.renewWorkflowClaim(workflowId);
        outcomes[index] = { workflowId, status: 'renewed' };
      } catch (error) {
        outcomes[index] = { workflowId, status: 'failed', error };
      }
    }
  }

  // With at most one claim there is nothing to overlap, so the pool is pure
  // overhead. The loop is written out rather than delegated to
  // `renewFromQueue` so this path keeps the exact async-frame shape it had
  // before the pool existed: callers observe a single-claim pass settling in
  // the same number of microtask turns, and nothing that interleaves against it
  // shifts. Small duplication, deliberately, in exchange for not perturbing the
  // overwhelmingly common case.
  if (workflowIds.length <= 1) {
    for (const [index, workflowId] of workflowIds.entries()) {
      try {
        await target.renewWorkflowClaim(workflowId);
        outcomes[index] = { workflowId, status: 'renewed' };
      } catch (error) {
        outcomes[index] = { workflowId, status: 'failed', error };
      }
    }
  } else {
    const workerCount = Math.min(WORKFLOW_CLAIM_RENEWAL_CONCURRENCY, workflowIds.length);
    await Promise.all(Array.from({ length: workerCount }, renewFromQueue));
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
