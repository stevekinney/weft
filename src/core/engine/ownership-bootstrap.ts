/**
 * Engine-level bootstrap for `ownership: 'workflow-lease'`
 * ([ADR 0002](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md)):
 * runs the two construction-time capability gates ({@link bootstrapOwnershipGates})
 * and, once they pass, constructs this engine's {@link WorkflowClaimRegistry}
 * and its claim-renewal task. Standalone from `Engine`/`EngineInternals` so the
 * idempotency, disposal-race, and background-task-mode wiring in
 * `src/core/engine/index.ts` stay thin call sites over one tested unit.
 *
 * **Both fencing modes run the gates.** This module builds the
 * `workflow-lease` machinery, but `Engine`'s ownership bootstrap also runs
 * Gate 1 and Gate 2 for `ownership: 'lease'` before it acquires the global
 * lease, so the store-wide mode marker rejects a mismatched pairing in either
 * direction. `'lease'` acquisition, fencing, health, and disposal are
 * otherwise unchanged.
 *
 * **The renewal task's reclaim scan is fully wired here**, via
 * {@link createWorkflowClaimReclaimTarget}: candidate discovery
 * (`workflow-claim-reclaim-scan.ts`, including its ownerless-but-running
 * scan — ADR 0002 § "Reclaiming stranded claims") plus a bounded-retry
 * `registry.takeover`/`registry.acquire` loop, per the ADR's "bounded at 5
 * attempts" row. A reclaimed or freshly-acquired claim's `onReclaimed` drive
 * is retried on every later pass if it throws — see
 * {@link createWorkflowClaimReclaimTarget}'s doc for why release-on-failure
 * is unsafe here.
 *
 * **Owner-side signal polling is composed here from small structural
 * sources** ({@link buildOwnerSideSignalPollTarget}) rather than built
 * against `EngineInternals` directly — this module stays independent of
 * that module's concrete shape, matching `owner-side-signal-poll.ts`'s own
 * decoupling discipline. `src/core/engine/index.ts` is the only expected
 * caller: it already has `EngineInternals` in scope and supplies
 * {@link OwnerSideSignalPollSources} as one-line closures over
 * `getInternals(this)`, then passes the composed target through
 * {@link WorkflowLeaseOwnershipBootstrapOptions.signalPollTarget}.
 *
 * @module core/engine/ownership-bootstrap
 */

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import type { OwnerSideSignalPollTarget, ParkedSignalWait } from './owner-side-signal-poll.ts';
import { bootstrapOwnershipGates } from './ownership-mode-marker.ts';
import { decodeWorkflowState } from './validation.ts';
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
   * `EngineInternals`/`inline-parking.ts` — typically
   * {@link buildOwnerSideSignalPollTarget} composed from
   * {@link OwnerSideSignalPollSources}. See the module doc's signal-poll
   * paragraph. Omitted leaves `result.signalPoll` `undefined` on every pass.
   */
  signalPollTarget?: OwnerSideSignalPollTarget;
  /**
   * Invoked after this engine reclaims a stranded claim, to actually drive the
   * workflow. Taking the claim only moves durable ownership keys; without this
   * the reclaimed workflow makes no progress while this engine's renewal keeps
   * its claim alive, shielding it from any engine that would have resumed it.
   */
  onWorkflowClaimReclaimed?: (workflowId: string) => Promise<void>;
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
 * Structural sources {@link buildOwnerSideSignalPollTarget} composes into a
 * real {@link OwnerSideSignalPollTarget} (ADR 0002 § "Signal delivery needs
 * more than a classification"). Defined as small closures rather than
 * accepting `EngineInternals` directly — see this module's doc comment.
 * `src/core/engine/index.ts` is the only expected caller.
 *
 * A parked `waitForSignal()` lands in one of two disjoint in-memory
 * populations, and both need owner-side polling to survive a signal
 * delivered on a non-owning engine:
 *
 * - **Checkpoint-parked** (`listParkedInlineWorkflowIds`/`parkedSignalName`):
 *   a top-level `waitForSignal()` with no live `ctx.onQuery`/update handler
 *   is evicted from memory (`inline-parking.ts`'s `parkInlineWorkflowAfterCheckpoint`)
 *   and tracked only as `EngineInternals.parkedInlineWorkflows` plus the
 *   checkpointed operation itself — recovered here via
 *   `EngineInternals.pendingTimelineEntries`, which every checkpoint commit
 *   sets to the just-persisted operation's timeline summary
 *   (`checkpoint-io.ts`) and only clears once that operation is finalized.
 *   For a still-parked `wait-signal` entry, `operationLabel` IS the awaited
 *   signal name (`state-utilities.ts`'s `getTimelineOperationLabel`).
 * - **Live in-memory waiters** (`listSignalWaiterEntries`): a `ctx.race`/
 *   `ctx.all` wait-signal branch, or a top-level `waitForSignal()` on a
 *   workflow WITH live query/update handlers, registers into
 *   `EngineInternals.signalWaiters`/`signalWaitersByWorkflow` instead
 *   (`operations-coordination.ts`, `coordination-branch-executors.ts`) — the
 *   generator's turn stays alive, blocked on an unresolved in-process
 *   promise, rather than being evicted.
 */
export type OwnerSideSignalPollSources = {
  /** `EngineInternals.parkedInlineWorkflows` — this engine's checkpoint-parked (memory-evicted) workflow ids. */
  listParkedInlineWorkflowIds(): Iterable<string>;
  /** Whether `workflowId` is currently checkpoint-parked. */
  isParkedInlineWorkflow(workflowId: string): boolean;
  /**
   * The signal name a checkpoint-parked workflow is currently awaiting —
   * `undefined` when `workflowId` is not parked on a `wait-signal`
   * operation. See this type's doc comment for the `pendingTimelineEntries`
   * source.
   */
  parkedSignalName(workflowId: string): string | undefined;
  /**
   * Every `[workflowId, waiterKey]` pair from
   * `EngineInternals.signalWaitersByWorkflow`. `waiterKey` is always
   * `` `${workflowId}:${signalName}` ``.
   */
  listSignalWaiterEntries(): Iterable<readonly [workflowId: string, waiterKey: string]>;
  /** `signals.ts`'s `hasBufferedSignal`. */
  hasBufferedSignal(workflowId: string, signalName: string): Promise<boolean>;
  /** `inline-parking.ts`'s `resumeParkedInlineWorkflow`, bound to this engine. */
  resumeParkedInlineWorkflow(workflowId: string): Promise<void>;
  /**
   * Wake exactly the in-memory signal waiter registered under `waiterKey` —
   * mirrors `signals.ts`'s (unexported) `deliverBufferedSignals` waiter
   * branch: release the waiter via the exported `releaseSignalWaiter`, then
   * invoke it. A no-op when no waiter is currently registered under that
   * exact key (already consumed by something else since discovery).
   */
  wakeSignalWaiter(workflowId: string, waiterKey: string): void;
};

/**
 * Compose {@link OwnerSideSignalPollSources} into a real
 * {@link OwnerSideSignalPollTarget}.
 *
 * `wakeWorkflow` re-confirms `hasBufferedSignal` for each live waiter key it
 * owns before firing it, rather than trusting the outer poll's per-entry
 * probe: `runOwnerSideSignalPoll` calls `wakeWorkflow(workflowId)` with no
 * `signalName` (`owner-side-signal-poll.ts`'s fixed contract), and one
 * workflow can have multiple live waiter keys at once (distinct `ctx.race`
 * branches waiting on different signals). Firing all of them because ONE was
 * confirmed buffered would spuriously "win" a branch whose signal never
 * arrived — `coordination-branch-executors.ts`'s race branch resolves
 * unconditionally once its waiter fires, with no re-check.
 */
export function buildOwnerSideSignalPollTarget(
  sources: OwnerSideSignalPollSources,
): OwnerSideSignalPollTarget {
  return {
    listParkedSignalWaits(): readonly ParkedSignalWait[] {
      const waits: ParkedSignalWait[] = [];
      for (const workflowId of sources.listParkedInlineWorkflowIds()) {
        const signalName = sources.parkedSignalName(workflowId);
        if (signalName !== undefined) {
          waits.push({ workflowId, signalName });
        }
      }
      for (const [workflowId, waiterKey] of sources.listSignalWaiterEntries()) {
        waits.push({ workflowId, signalName: waiterKey.slice(workflowId.length + 1) });
      }
      return waits;
    },
    hasBufferedSignal: (workflowId, signalName) =>
      sources.hasBufferedSignal(workflowId, signalName),
    async wakeWorkflow(workflowId: string): Promise<void> {
      if (sources.isParkedInlineWorkflow(workflowId)) {
        await sources.resumeParkedInlineWorkflow(workflowId);
        return;
      }
      for (const [waiterWorkflowId, waiterKey] of sources.listSignalWaiterEntries()) {
        if (waiterWorkflowId !== workflowId) continue;
        const signalName = waiterKey.slice(workflowId.length + 1);
        if (await sources.hasBufferedSignal(workflowId, signalName)) {
          sources.wakeSignalWaiter(workflowId, waiterKey);
        }
      }
    },
  };
}

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
  metrics?: WorkflowClaimMetricsCollector,
): WorkflowClaimRenewalTarget {
  return {
    listHeldWorkflowIds: () => registry.listHeldWorkflowIds(),
    async renewWorkflowClaim(workflowId: string): Promise<void> {
      const result = await registry.renew(workflowId);
      if (result.status === 'lost') {
        // A lost renewal is a deposition, not a transient failure: another
        // engine holds this workflow now. Recorded distinctly so operators can
        // tell contention apart from storage trouble, which the renewal-failure
        // counter alone cannot.
        metrics?.recordClaimAttempt('deposed');
        throw new Error(`workflow "${workflowId}" lost its ownership claim during renewal`);
      }
    },
  };
}

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
 */
export function createWorkflowClaimReclaimTarget(
  registry: WorkflowClaimRegistry,
  storage: Storage,
  metrics: WorkflowClaimMetricsCollector,
  onReclaimed?: (workflowId: string) => Promise<void>,
): WorkflowClaimReclaimTarget {
  // Workflow ids whose reclaim succeeded (this engine durably holds the
  // claim) but whose `onReclaimed` drive most recently threw. Reclaim
  // discovery excludes every currently-held id, so without this a failed
  // drive is never retried — the claim sits held, renewed, and idle forever
  // (ADR 0002's exact "stay stranded" failure mode, just relocated from "no
  // claim" to "an idle claim"). Merged back into the candidate list on every
  // pass and drained (or re-armed) by `attemptWorkflowClaimTakeover`.
  const pendingRedriveWorkflowIds = new Set<string>();

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

  // Redrive-only candidate: this engine already durably holds the claim (a
  // previous pass's takeover/acquire succeeded but the drive threw). Retry
  // the drive directly — no takeover/acquire CAS is needed, and attempting
  // one would be pure overhead against a claim already held.
  async function redriveAlreadyHeldClaim(
    workflowId: string,
  ): Promise<WorkflowClaimReclaimAttemptResult> {
    if (!(await isWorkflowStillRunning(storage, workflowId))) {
      // The workflow reached a terminal state while its redrive was pending
      // (e.g. an external cancel/timeout landed on it). Redriving a terminal
      // workflow can never succeed and would loop forever — release the
      // now-moot claim instead of renewing it indefinitely.
      pendingRedriveWorkflowIds.delete(workflowId);
      await registry.release(workflowId);
      return { status: 'not-eligible' };
    }
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
    if (!(await isWorkflowStillRunning(storage, workflowId))) {
      return { status: 'not-eligible' };
    }
    const acquireResult = await registry.acquire(workflowId);
    if (acquireResult.status === 'lost-race') {
      metrics.recordClaimAttempt('lost_race');
      return 'retry';
    }
    metrics.recordClaimAttempt('acquired');
    return await driveReclaimedWorkflow(workflowId);
  }

  return {
    async listReclaimCandidateWorkflowIds(): Promise<string[]> {
      const discovered = await listWorkflowClaimReclaimCandidates(
        storage,
        new Set(registry.listHeldWorkflowIds()),
      );
      return [...discovered, ...pendingRedriveWorkflowIds];
    },
    async attemptWorkflowClaimTakeover(workflowId): Promise<WorkflowClaimReclaimAttemptResult> {
      if (registry.currentEpoch(workflowId) !== null) {
        return await redriveAlreadyHeldClaim(workflowId);
      }
      // Stale bookkeeping: this engine no longer holds the claim (lost via a
      // failed renewal since being marked pending-redrive) — fall through to
      // the ordinary takeover/acquire path below instead of forcing a
      // redrive against a claim it does not have.
      pendingRedriveWorkflowIds.delete(workflowId);

      for (let attempt = 0; attempt < WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS; attempt += 1) {
        const result = await registry.takeover(workflowId);
        switch (result.status) {
          case 'acquired':
            metrics.recordClaimAttempt('takeover');
            // Reclaiming the claim is only half the job: drive the workflow too,
            // or it sits idle while this engine's renewal keeps its claim alive.
            return await driveReclaimedWorkflow(workflowId);
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
    target: createWorkflowClaimRenewalTarget(registry, metrics),
    reclaimTarget: createWorkflowClaimReclaimTarget(
      registry,
      options.storage,
      metrics,
      options.onWorkflowClaimReclaimed,
    ),
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
