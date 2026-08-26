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
import type { OwnerSideSignalPollTarget, ParkedSignalWait } from './owner-side-signal-poll.ts';
import { bootstrapOwnershipGates } from './ownership-mode-marker.ts';
import { WorkflowClaimMetricsCollector } from './workflow-claim-metrics.ts';
import { createWorkflowClaimReclaimTarget } from './workflow-claim-reclaim-target.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';
import {
  createWorkflowClaimRenewalTask,
  type WorkflowClaimRenewalTarget,
  type WorkflowClaimRenewalTask,
} from './workflow-claim-renewal-task.ts';

export {
  createWorkflowClaimReclaimTarget,
  WORKFLOW_CLAIM_TAKEOVER_MAX_ATTEMPTS,
  type WorkflowClaimReclaimTargetHandle,
} from './workflow-claim-reclaim-target.ts';

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
  /**
   * Optional pre-wake ownership confirmation for the LIVE in-memory waiter
   * branch only (WFT-79 Finding 1). Mirrors `wake-ownership-guard.ts`'s
   * `confirmWakeOwnership` three-way decision tree: `'discard'` means this
   * engine no longer holds the claim generation it registered the waiter
   * under, so `wakeSignalWaiter` must NOT be called — doing so would let a
   * signal buffered for a `ctx.race()`/`ctx.all()` branch wake a generator
   * this engine has since been deposed from, driving it concurrently with
   * whichever engine now legitimately owns the workflow (the exact
   * duplicate-execution hazard ADR 0002 exists to close). `'proceed'` (or
   * this source being omitted entirely) preserves the pre-guard behavior:
   * every confirmed-buffered live waiter is woken unconditionally.
   *
   * **Not called for the checkpoint-parked branch above.** A checkpoint-parked
   * resume goes through `resumeParkedInlineWorkflow` →
   * `resumeWorkflowFromStorage`'s standalone-acquire path, which already
   * re-acquires (or re-confirms) this engine's claim on its own — guarding it
   * here too would be redundant, not unsafe, but the finding is scoped to the
   * live-waiter release this module makes directly.
   *
   * **Required, deliberately.** This module cannot call `confirmWakeOwnership`
   * directly: that helper takes `EngineInternals`, and this module stays
   * independent of that concrete shape (see this module's doc comment) so it
   * never couples to `src/core/engine/index.ts`'s internals layout. The caller
   * therefore supplies it — `src/core/engine/index.ts` passes
   * `(workflowId) => confirmWakeOwnership(internals, workflowId, 'signal')`.
   *
   * It is NOT optional, because an optional fence is one that silently does
   * nothing when a call site forgets it — which is exactly how the owner-side
   * signal poll shipped unwired in the first place. Making it required turns a
   * missing fence into a compile error rather than a duplicate-execution bug
   * that only a reviewer can catch. A caller that genuinely needs no fence
   * (`ownership: 'none'`/`'lease'`) still passes one; `confirmWakeOwnership`
   * returns `'proceed'` when no claim registry is installed.
   */
  confirmSignalWakeOwnership(workflowId: string): Promise<'proceed' | 'discard'>;
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
          if ((await sources.confirmSignalWakeOwnership(workflowId)) === 'discard') continue;
          sources.wakeSignalWaiter(workflowId, waiterKey);
        }
      }
    },
  };
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
 *
 * **`renewalTask.stop()` also quiesces the reclaim target (WFT-79 Finding 2).**
 * `createWorkflowClaimRenewalTask`'s own `stop()` only clears the interval —
 * a reclaim pass already in flight (started by the last tick before `stop()`)
 * still runs to completion, per that module's own doc. Left alone, a
 * disposal that races an in-flight interval-driven pass could let the
 * {@link createWorkflowClaimReclaimTarget reclaim target} land a fresh
 * takeover/acquire CAS, or drive a freshly reclaimed workflow's `onReclaimed`
 * against a host that is mid-teardown, AFTER `Engine`'s disposal path has
 * already snapshotted the registry for `WorkflowClaimRegistry.releaseAll()`.
 * The `renewalTask` this function returns wraps the raw task's `stop` so it
 * synchronously calls {@link WorkflowClaimReclaimTargetHandle.markDisposing}
 * first: since JS has no preemption, that flag flip happens strictly before
 * any other code runs, so every reclaim-target checkpoint after an `await`
 * (including one a suspended continuation resumes into after `stop()` was
 * called) observes it. A checkpoint that finds itself disposing self-releases
 * any claim it just landed rather than driving it — see that module's doc —
 * so the hazard closes without `Engine`'s disposal path (`index.ts`, out of
 * this module's scope) needing to await anything new. This wrapping makes
 * `stop()` permanent: a later `start()` on the returned task still clears
 * `disposing` for renewal-interval purposes, but the reclaim target itself
 * never un-disposes. That is intentional — `index.ts` never restarts a
 * renewal task after detaching it — and is pinned by a test.
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
  const reclaimTarget = createWorkflowClaimReclaimTarget(
    registry,
    options.storage,
    metrics,
    options.onWorkflowClaimReclaimed,
  );
  const rawRenewalTask = createWorkflowClaimRenewalTask({
    target: createWorkflowClaimRenewalTarget(registry, metrics),
    reclaimTarget,
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
  const renewalTask: WorkflowClaimRenewalTask = {
    runOnce: () => rawRenewalTask.runOnce(),
    start: () => rawRenewalTask.start(),
    stop: () => {
      reclaimTarget.markDisposing();
      rawRenewalTask.stop();
    },
  };

  return { registry, renewalTask, metrics };
}
