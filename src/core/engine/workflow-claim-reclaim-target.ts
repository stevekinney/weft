/**
 * The reclaim-scan candidate-discovery and takeover-attempt machinery for
 * `ownership: 'workflow-lease'` ([ADR 0002](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md)).
 * Extracted from `ownership-bootstrap.ts` — which still composes this module's
 * {@link createWorkflowClaimReclaimTarget} into the renewal task's
 * `reclaimTarget` option — so that file stays under the repository's
 * implementation-file-size ceiling as this seam grows disposal-quiescence and
 * epoch-fenced-release handling on top of the original takeover-retry loop.
 * This is a real responsibility boundary, not an arbitrary split: everything
 * here is "how one engine discovers and attempts to reclaim a stranded
 * workflow's claim," while `ownership-bootstrap.ts` keeps gate execution,
 * registry/renewal-task construction, and the owner-side signal-poll seam.
 *
 * @module core/engine/workflow-claim-reclaim-target
 */

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decodeWorkflowState } from './validation.ts';
import type { WorkflowClaimMetricsCollector } from './workflow-claim-metrics.ts';
import { listWorkflowClaimReclaimCandidates } from './workflow-claim-reclaim-scan.ts';
import type { WorkflowClaimRegistry } from './workflow-claim-registry.ts';
import type {
  WorkflowClaimReclaimAttemptResult,
  WorkflowClaimReclaimTarget,
} from './workflow-claim-renewal-task.ts';

/** Bound on retrying a lost-race `takeover` CAS for one reclaim candidate within one pass — ADR 0002's `takeover` row. */
export const WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS = 5;

/**
 * Fresh read: is `workflowId` still `running`? Used to gate a fresh
 * `registry.acquire()` behind an up-to-date status check — mirrors
 * `resume.ts`'s `acquireStandaloneClaimBeforeResume`, which gates its own
 * standalone acquire the same way — so a workflow that reached a terminal
 * state is never handed a fresh claim it will never use. Absent or corrupt
 * state reads as "not running" (fail closed: no claim is safer than a wrong
 * one here, since this is opportunistic background reconciliation, not a
 * request a caller is blocked on).
 */
async function isWorkflowStillRunning(storage: Storage, workflowId: string): Promise<boolean> {
  const bytes = await storage.get(KEYS.workflow(workflowId));
  if (bytes === null) return false;
  try {
    return decodeWorkflowState(bytes).status === 'running';
  } catch {
    return false;
  }
}

/**
 * A {@link WorkflowClaimReclaimTarget} with one additional, non-interface
 * method: {@link markDisposing}. Structurally still a valid
 * `WorkflowClaimReclaimTarget` (every caller that only knows that narrower
 * type — e.g. `createWorkflowClaimRenewalTask`'s `reclaimTarget` option —
 * keeps working unchanged), so existing tests that only exercise
 * `listReclaimCandidateWorkflowIds`/`attemptWorkflowClaimTakeover` are
 * unaffected by this addition.
 */
export type WorkflowClaimReclaimTargetHandle = WorkflowClaimReclaimTarget & {
  /**
   * Synchronously flip this target into "disposing" mode: every future
   * `attemptWorkflowClaimTakeover` call becomes an immediate `'not-eligible'`
   * no-op (no CAS attempted, no `onReclaimed` drive invoked), and
   * `listReclaimCandidateWorkflowIds` returns `[]`. A reclaim attempt already
   * past this checkpoint when disposal begins keeps running to its next
   * checkpoint — every checkpoint after an `await` re-checks the flag — and,
   * if it lands a takeover/acquire CAS after disposal was signaled, releases
   * that claim immediately instead of driving it or leaving it held. See this
   * module's doc and `ownership-bootstrap.ts`'s `bootstrapWorkflowLeaseOwnership`
   * for how this is wired to `WorkflowClaimRenewalTask.stop()`.
   *
   * Idempotent. Calling this before any pass has started simply prevents one
   * from ever discovering or attempting a candidate.
   */
  markDisposing(): void;
};

/**
 * Adapt a {@link WorkflowClaimRegistry} plus `storage` to the renewal task's
 * {@link WorkflowClaimReclaimTarget} contract. Candidate discovery excludes
 * this engine's own currently-held ids (`registry.listHeldWorkflowIds()`) —
 * see `workflow-claim-reclaim-scan.ts`'s doc for why — then adds back any
 * workflow this engine holds but whose `onReclaimed` drive previously
 * failed (see `driveReclaimedWorkflow` below). `attemptWorkflowClaimTakeover`
 * retries a `'lost-race'` CAS, bounded at {@link WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS}
 * per the ADR, and records `weft_workflow_claim_attempts_total{outcome="backoff_skipped"}`
 * the moment the registry's own anti-thrash cooldown suppresses an attempt —
 * the one `WorkflowClaimAttemptOutcome` this stage wires; the other four
 * remain unrecorded by design (see the ADR's Observability section for the
 * full set — that wiring is a later stage's work).
 *
 * **A failed `onReclaimed` drive is retried in place, never released.**
 * Releasing on failure was considered and rejected: `onReclaimed` (bound to
 * `resumeWorkflowFromStorage` in production) can throw AFTER
 * `relaunchInlineWorkflowAfterResume` has already adopted the generator —
 * `InlineExecutionStrategy#continueWorkflow` fires the drive and returns
 * without awaiting it, so a caught error here does not prove no local user
 * code started. Releasing the claim in that state would let another engine
 * `acquire` it while this engine may still be mid-turn — the exact
 * duplicate-execution hazard ADR 0002 exists to close, just re-opened via
 * the failure path instead of the happy path. Retrying in place keeps the
 * claim (and its write fence) intact and simply asks `onReclaimed` again on
 * a later pass, via `pendingRedriveWorkflowIds` below.
 *
 * **Discovered and pending-redrive candidates are merged through a `Set`
 * (WFT-79 Finding 4).** After a failed redrive loses this engine's local
 * claim (a renewal loss between the failed drive and the next pass), the
 * same workflow id can surface BOTH through `listWorkflowClaimReclaimCandidates`
 * (as a foreign holder, since `registry.listHeldWorkflowIds()` no longer
 * excludes it) AND through `pendingRedriveWorkflowIds`. Without deduping,
 * one renewal pass would call `attemptWorkflowClaimTakeover` for that id
 * twice, and each call independently retries up to
 * {@link WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS} — doubling the advertised
 * per-pass bound to 10 attempts for that workflow, exactly when contention is
 * already highest (deposition churn).
 *
 * **Disposal quiescence (WFT-79 Finding 2).** {@link WorkflowClaimReclaimTargetHandle.markDisposing}
 * closes two related hazards when disposal overlaps an in-flight
 * interval-driven pass: a late-landing takeover/acquire CAS stranding a claim
 * this engine will never renew again, and a late `onReclaimed` drive running
 * against a torn-down host. Every checkpoint that follows an `await` inside
 * this target re-checks the flag; a CAS that lands after disposal was
 * signaled is released immediately rather than driven, so the claim never
 * outlives this engine's own best-effort `WorkflowClaimRegistry.releaseAll()`
 * call regardless of the ordering race between them.
 */
export function createWorkflowClaimReclaimTarget(
  registry: WorkflowClaimRegistry,
  storage: Storage,
  metrics: WorkflowClaimMetricsCollector,
  onReclaimed?: (workflowId: string) => Promise<void>,
): WorkflowClaimReclaimTargetHandle {
  // Workflow ids whose reclaim succeeded (this engine durably holds the
  // claim) but whose `onReclaimed` drive most recently threw. Reclaim
  // discovery excludes every currently-held id, so without this a failed
  // drive is never retried — the claim sits held, renewed, and idle forever
  // (ADR 0002's exact "stay stranded" failure mode, just relocated from "no
  // claim" to "an idle claim"). Merged back into the candidate list on every
  // pass and drained (or re-armed) by `attemptWorkflowClaimTakeover`.
  const pendingRedriveWorkflowIds = new Set<string>();

  // See `WorkflowClaimReclaimTargetHandle.markDisposing`'s doc. Checked at
  // entry to every attempt and again after every `await` inside one, so a
  // continuation resuming after disposal was signaled mid-flight notices at
  // its very next checkpoint rather than completing unguarded.
  let disposing = false;

  async function driveReclaimedWorkflow(
    workflowId: string,
  ): Promise<WorkflowClaimReclaimAttemptResult> {
    if (onReclaimed === undefined) {
      pendingRedriveWorkflowIds.delete(workflowId);
      return { status: 'reclaimed' };
    }
    try {
      await onReclaimed(workflowId);
      pendingRedriveWorkflowIds.delete(workflowId);
      return { status: 'reclaimed' };
    } catch (error) {
      pendingRedriveWorkflowIds.add(workflowId);
      // Rethrow (rather than swallow) so the renewal task's per-candidate
      // error handling records `{ status: 'error', error }` for this pass —
      // the claim is held either way, but a silently swallowed drive failure
      // is exactly what let this bug hide originally.
      throw error;
    }
  }

  /**
   * A claim just landed (fresh takeover or acquire CAS) while this target was
   * already disposing. Never drive it — `onReclaimed` may resume against
   * torn-down host internals — and never leave it held past this call, since
   * this engine's renewal is being stopped and the claim would otherwise sit
   * stranded until TTL/grace expiry. Best-effort, matching
   * `WorkflowClaimRegistry.releaseAll()`'s own posture: a process crash
   * between the CAS landing and this release still leaves the claim for
   * `expire`/`takeover` to reclaim later, same as any other ungraceful exit.
   */
  async function releaseClaimAcquiredWhileDisposing(workflowId: string): Promise<void> {
    await registry.release(workflowId);
  }

  // Redrive-only candidate: this engine already durably holds the claim (a
  // previous pass's takeover/acquire succeeded but the drive threw). Retry
  // the drive directly — no takeover/acquire CAS is needed, and attempting
  // one would be pure overhead against a claim already held.
  async function redriveAlreadyHeldClaim(
    workflowId: string,
  ): Promise<WorkflowClaimReclaimAttemptResult> {
    if (disposing) return { status: 'not-eligible' };
    // Captured before the only await in this function so a concurrent
    // `onTerminalConflict: 'start-new'` replacing this terminal run on the
    // same id (WFT-79 Finding 3) is detectable: if the epoch this engine
    // tracks for `workflowId` differs by the time the read below resolves,
    // the registry's entry is no longer the generation this call inspected.
    const expectedEpoch = registry.currentEpoch(workflowId);
    if (!(await isWorkflowStillRunning(storage, workflowId))) {
      // The workflow reached a terminal state while its redrive was pending
      // (e.g. an external cancel/timeout landed on it). Redriving a terminal
      // workflow can never succeed and would loop forever — release the
      // now-moot claim instead of renewing it indefinitely.
      pendingRedriveWorkflowIds.delete(workflowId);
      if (registry.currentEpoch(workflowId) === expectedEpoch) {
        await registry.release(workflowId);
      }
      // Else: a replacement run (`start-new`) was minted on this same
      // workflow id while the terminal-state read above was pending.
      // `registry.release(workflowId)` keys purely on workflow id, so
      // calling it here would delete the REPLACEMENT run's live holder
      // record, not the terminal generation this call actually inspected.
      // Skip — there is nothing this generation still needs to release.
      return { status: 'not-eligible' };
    }
    if (disposing) return { status: 'not-eligible' };
    return await driveReclaimedWorkflow(workflowId);
  }

  // `takeover` returned `'no-claim'` — no holder record at all, which
  // `takeover` cannot CAS against. Either a benign race against a concurrent
  // release/terminal-commit (the discovery scan read a holder record that is
  // already gone by the time this attempt runs), or ADR 0002's
  // "ownerless-but-running" rolling-handoff shape
  // (`workflow-claim-reclaim-scan.ts`'s second scan). Both need `acquire`,
  // not `takeover`. Confirm the workflow is still running first, mirroring
  // `resume.ts`'s `acquireStandaloneClaimBeforeResume`, so a workflow that
  // reached a terminal state in the same race is never handed a fresh claim
  // it will never use. Returns `'retry'` (rather than looping itself) so the
  // caller's bounded takeover retry loop stays the single place that counts
  // attempts.
  async function acquireOwnerlessRunningClaim(
    workflowId: string,
  ): Promise<WorkflowClaimReclaimAttemptResult | 'retry'> {
    if (disposing) return { status: 'not-eligible' };
    if (!(await isWorkflowStillRunning(storage, workflowId))) {
      return { status: 'not-eligible' };
    }
    if (disposing) return { status: 'not-eligible' };
    const acquireResult = await registry.acquire(workflowId);
    if (acquireResult.status === 'lost-race') {
      metrics.recordClaimAttempt('lost_race');
      return 'retry';
    }
    metrics.recordClaimAttempt('acquired');
    if (disposing) {
      await releaseClaimAcquiredWhileDisposing(workflowId);
      return { status: 'not-eligible' };
    }
    return await driveReclaimedWorkflow(workflowId);
  }

  // Handles `takeover`'s `'acquired'` outcome: split out of
  // `attemptWorkflowClaimTakeover`'s loop purely to keep that function's own
  // cyclomatic complexity under the repository's ceiling — the disposing
  // check and self-release below duplicate the same guard
  // `acquireOwnerlessRunningClaim` applies for its own `'acquired'` outcome.
  async function handleTakeoverAcquired(
    workflowId: string,
  ): Promise<WorkflowClaimReclaimAttemptResult> {
    metrics.recordClaimAttempt('takeover');
    if (disposing) {
      await releaseClaimAcquiredWhileDisposing(workflowId);
      return { status: 'not-eligible' };
    }
    // Reclaiming the claim is only half the job: drive the workflow too, or
    // it sits idle while this engine's renewal keeps its claim alive.
    return await driveReclaimedWorkflow(workflowId);
  }

  // The bounded `takeover` retry loop itself, once this engine holds nothing
  // for `workflowId` to redrive. Split out of `attemptWorkflowClaimTakeover`
  // purely to keep that function's own cyclomatic complexity under the
  // repository's ceiling — see {@link WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS}.
  async function takeoverWithRetries(
    workflowId: string,
  ): Promise<WorkflowClaimReclaimAttemptResult> {
    for (let attempt = 0; attempt < WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS; attempt += 1) {
      if (disposing) return { status: 'not-eligible' };
      const result = await registry.takeover(workflowId);
      switch (result.status) {
        case 'acquired':
          return await handleTakeoverAcquired(workflowId);
        case 'backoff-skipped':
          metrics.recordClaimAttempt('backoff_skipped');
          return { status: 'backoff-skipped' };
        case 'not-expired':
          return { status: 'not-eligible' };
        case 'no-claim': {
          const outcome = await acquireOwnerlessRunningClaim(workflowId);
          if (outcome === 'retry') continue;
          return outcome;
        }
        case 'lost-race':
          metrics.recordClaimAttempt('lost_race');
          continue;
      }
    }
    return { status: 'lost-race' };
  }

  return {
    async listReclaimCandidateWorkflowIds(): Promise<string[]> {
      if (disposing) return [];
      const discovered = await listWorkflowClaimReclaimCandidates(
        storage,
        new Set(registry.listHeldWorkflowIds()),
      );
      // WFT-79 Finding 4: merge through a `Set` so a workflow id present in
      // both collections is attempted at most once per pass.
      return [...new Set([...discovered, ...pendingRedriveWorkflowIds])];
    },
    async attemptWorkflowClaimTakeover(workflowId): Promise<WorkflowClaimReclaimAttemptResult> {
      if (disposing) return { status: 'not-eligible' };
      if (registry.currentEpoch(workflowId) !== null) {
        return await redriveAlreadyHeldClaim(workflowId);
      }
      // Stale bookkeeping: this engine no longer holds the claim (lost via a
      // failed renewal since being marked pending-redrive) — fall through to
      // the ordinary takeover/acquire path below instead of forcing a
      // redrive against a claim it does not have.
      pendingRedriveWorkflowIds.delete(workflowId);
      return await takeoverWithRetries(workflowId);
    },
    markDisposing(): void {
      disposing = true;
    },
  };
}
