/**
 * Recurring driver for the per-workflow claim-renewal lifecycle task described
 * in [ADR 0002 § Reclaiming stranded claims](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#reclaiming-stranded-claims)
 * and its `renew` transition row.
 *
 * **Why this must be its own driver, independent of the durable-timer
 * scheduler.** Renewal keeps a *parked* workflow's claim alive — sleep,
 * wait-signal, wait-update, wait-condition, wait-async-activity, and
 * await-child-completion all keep the claim held rather than releasing it (see
 * the ADR's `wf-owner-holder` row). A parked workflow has no pending durable
 * timer of its own to piggyback on, and `startScheduler: false` is an
 * explicitly supported, orthogonal configuration — tying renewal to
 * `Scheduler#tick` would silently expire every parked claim the moment the
 * scheduler is disabled, even though the owning engine is perfectly healthy.
 * This task runs on its own cadence, or on an explicitly awaited host tick
 * under `backgroundTasks: 'manual'` (see `Engine#runMaintenance()`), and never
 * depends on the scheduler being started.
 *
 * **What this module owns.** `runOnce()` — the manual/`backgroundTasks:
 * 'manual'` combined pass — plus the public options/result/task types. The
 * actual claim storage transitions (`buildWorkflowClaimRenewTransition`), the
 * in-flight-renewal guard *per workflow* that serializes a renewal against a
 * concurrent `release` (ADR `renew` row), and the deposition side effects of
 * a failed renewal — aborting the workflow's in-flight work and emitting
 * {@link WeftWorkflowClaimLostWarning} — all belong to the claim holder this
 * task is handed ({@link WorkflowClaimRenewalTarget}), typically a
 * `WorkflowClaimRegistry`. This module never imports that registry directly
 * and never imports `lease-deposition.ts`: coupling to the registry's exact
 * shape here would tie two patches built in parallel together, and duplicating
 * its warning-emission would double-emit once the two are wired together.
 * Interval-mode driving (four independent single-flight sub-pass slots) lives
 * in `workflow-claim-renewal-interval.ts`, split out to keep this file under
 * the repository's implementation-file-size ceiling — see that module's doc
 * for the full "each sub-pass gets its own slot" rationale (WFT-79 Finding 2
 * and its extensions).
 *
 * **`runOnce()` still runs every configured sub-step sequentially in one
 * awaited call**, exactly as ADR 0002 describes — a host calling
 * `runMaintenance()` gets one coherent pass (serialized against any other
 * concurrent `runOnce()` call — see `inFlightManualPass`). Interval mode's
 * `start()`/`stop()` (delegated to `workflow-claim-renewal-interval.ts`)
 * gives renewal, reclaim, signal poll, and update poll each their own
 * cadence instead.
 *
 * **Three more ADR 0002 responsibilities besides renewal itself**, each
 * OPTIONAL: a reclaim scan that attempts `takeover` for workflows whose
 * holders have passed the grace-adjusted `expire` judgment (ADR § Reclaiming
 * stranded claims), driven through the {@link WorkflowClaimReclaimTarget}
 * structural seam — expected to be satisfied by
 * `listWorkflowClaimReclaimCandidates` (`workflow-claim-reclaim-scan.ts`)
 * plus `WorkflowClaimRegistry.takeover`, adapted by `ownership-bootstrap.ts`
 * — owner-side polling of the durable signal buffer for parked
 * `waitForSignal` workflows (ADR § signal delivery, "owner-side polling"),
 * and owner-side polling of pending coordinated updates (WFT-79). All three
 * are `undefined` in {@link WorkflowClaimRenewalPassResult} when their target
 * option is omitted, which is how a caller with only the renewal target (or
 * a test) opts out of running them at all.
 *
 * @module core/engine/workflow-claim-renewal-task
 */

import type { OwnerSideSignalPollTarget } from './owner-side-signal-poll.ts';
import type { OwnerSideUpdatePollTarget } from './owner-side-update-poll.ts';
import {
  createWorkflowClaimRenewalIntervalDriver,
  defaultWorkflowClaimRenewalScheduler,
} from './workflow-claim-renewal-interval.ts';
import {
  runReclaimPass,
  runRenewalSubPass,
  runSignalPollSubPass,
  runUpdatePollSubPass,
  type WorkflowClaimReclaimTarget,
  type WorkflowClaimRenewalIntervalScheduler,
  type WorkflowClaimRenewalPassResult,
  type WorkflowClaimRenewalTarget,
} from './workflow-claim-renewal-subpasses.ts';

// Re-exported from `workflow-claim-renewal-subpasses.ts`, where these are
// actually defined — see that module for why (avoiding an import cycle with
// `workflow-claim-renewal-interval.ts`, which needs both types too).
export type {
  WorkflowClaimRenewalIntervalScheduler,
  WorkflowClaimRenewalPassResult,
} from './workflow-claim-renewal-subpasses.ts';

/** Options for {@link createWorkflowClaimRenewalTask}. */
export type WorkflowClaimRenewalTaskOptions = {
  /** The claim holder this task renews on behalf of. */
  target: WorkflowClaimRenewalTarget;
  /**
   * Wall-clock source (ms), injected so tests never depend on real time. There
   * is no default — every call site (the engine) already threads an injected
   * clock through the rest of the ownership machinery (see `lease-manager.ts`),
   * and an implicit `Date.now()` default would be a code path tests could
   * never exercise deterministically.
   */
  getNow: () => number;
  /** Interval-mode cadence (ms). Should be the configured `workflowClaimRenewInterval`. */
  intervalMs: number;
  /**
   * Interval-scheduling seam. Defaults to the real `setInterval`/`clearInterval`,
   * with the created interval `unref()`'d (when supported) so it never keeps an
   * otherwise-idle process alive — mirroring `lease-manager.ts`'s `startRenewal`.
   */
  scheduler?: WorkflowClaimRenewalIntervalScheduler;
  /**
   * Optional reclaim-scan target. Omitted (the default) runs renewal alone —
   * `result.reclaim` stays `undefined`. See {@link WorkflowClaimReclaimTarget}.
   */
  reclaimTarget?: WorkflowClaimReclaimTarget;
  /**
   * Optional owner-side signal-poll target. Omitted (the default) leaves
   * `result.signalPoll` `undefined`. See `owner-side-signal-poll.ts`'s
   * `OwnerSideSignalPollTarget`.
   */
  signalPollTarget?: OwnerSideSignalPollTarget;
  /**
   * Optional owner-side update-poll target (WFT-79). Omitted (the default)
   * leaves `result.updatePoll` `undefined`. See `owner-side-update-poll.ts`'s
   * `OwnerSideUpdatePollTarget`.
   */
  updatePollTarget?: OwnerSideUpdatePollTarget;
  /**
   * Called after every completed pass, interval-driven or explicit. This is
   * the reporting seam a later observability stage hangs a metrics counter
   * off of (e.g. `weft_workflow_claim_renewal_failures_total`); this task does
   * not touch any metrics registry itself.
   */
  onPassComplete?: (result: WorkflowClaimRenewalPassResult) => void;
};

/** A running claim-renewal task. */
export type WorkflowClaimRenewalTask = {
  /**
   * Run exactly one pass: snapshot the currently-held workflow ids, renew each
   * in turn, and continue past a failure on any one of them so a single lost
   * claim never stops the rest from renewing. A per-workflow renewal failure is
   * captured as a `'failed'` outcome rather than a rejection; the pass itself
   * rejects only if `listHeldWorkflowIds()` throws, since without a snapshot
   * there is no pass to run. A throwing `onPassComplete` sink never fails the
   * pass — the renewal work already committed by then.
   * This is the entry point `backgroundTasks: 'manual'` hosts drive from an
   * awaited host tick (`Engine#runMaintenance()`), and the one tests use to
   * step the task deterministically. Bypasses the interval-mode single-flight
   * slots by design — same as `renewOnce()` does relative to
   * `startRenewal()`'s timer in `lease-manager.ts` — so an explicit caller
   * is never silently skipped because an interval-driven pass happens to be
   * in flight. It IS, however, deduped against another concurrent `runOnce()`
   * call: `Engine.create()` documents concurrent `runMaintenance()` calls as
   * safe, and two independent combined passes sharing this task's targets
   * could otherwise both act on the same stale reclaim candidate. An
   * overlapping caller receives the already-running pass's result rather
   * than starting a second one.
   */
  runOnce(): Promise<WorkflowClaimRenewalPassResult>;
  /**
   * Start interval-driven passes. Idempotent — a second call while already
   * started does not create a second interval. Each interval tick is guarded
   * by a single-flight lock: if the previous interval-driven pass is still
   * running when the next tick fires, that tick is skipped rather than
   * starting an overlapping pass.
   */
  start(): void;
  /**
   * Stop interval-driven passes. Idempotent — a second call, or a call before
   * `start()`, does not throw. Only clears the interval; a pass already in
   * flight (started by the last tick before `stop()`) still runs to
   * completion, but no further tick fires afterward.
   */
  stop(): void;
};

/**
 * Create a claim-renewal task. Does not start any timer and does not run any
 * pass itself — the caller drives it, either via `start()` for interval mode
 * (delegated to `workflow-claim-renewal-interval.ts`) or by awaiting
 * `runOnce()` directly under `backgroundTasks: 'manual'`. The sub-pass
 * implementations both this module and the interval driver compose
 * (`runReclaimPass`, `runRenewalSubPass`, `runSignalPollSubPass`,
 * `runUpdatePollSubPass`) live in `workflow-claim-renewal-subpasses.ts`.
 */
export function createWorkflowClaimRenewalTask(
  options: WorkflowClaimRenewalTaskOptions,
): WorkflowClaimRenewalTask {
  const {
    target,
    getNow,
    intervalMs,
    reclaimTarget,
    signalPollTarget,
    updatePollTarget,
    onPassComplete,
  } = options;
  const scheduler = options.scheduler ?? defaultWorkflowClaimRenewalScheduler();

  // `runOnce()` bypasses the interval-mode single-flight slots (owned by
  // `workflow-claim-renewal-interval.ts`) by design (see that method's own
  // doc), but two concurrent MANUAL calls (`backgroundTasks: 'manual'` hosts
  // calling `Engine.runMaintenance()` concurrently, which `Engine.create`
  // documents as safe) still share the same underlying
  // `target`/`reclaimTarget`/`signalPollTarget`/`updatePollTarget`. Without
  // this guard, two overlapping `runOnce()` reclaim passes can both observe
  // the same stale local epoch for a redrive candidate and both invoke
  // `onReclaimed` for it concurrently. This is a plain reentrancy guard, not
  // one of the interval-mode cadence slots: a manual caller always gets a
  // pass that reflects the most current state once its turn comes, it just
  // never overlaps another manual pass.
  let inFlightManualPass: Promise<WorkflowClaimRenewalPassResult> | null = null;

  /**
   * Fire `onPassComplete` for the combined pass, falling back to the console
   * on a throwing sink so a broken observability hook never turns
   * already-committed durable work into a rejection. Mirrors the engine's
   * `onLog` convention.
   */
  function emitPassComplete(result: WorkflowClaimRenewalPassResult): void {
    try {
      onPassComplete?.(result);
    } catch (error) {
      console.error('weft: workflow claim renewal onPassComplete sink threw', error);
    }
  }

  /**
   * The full combined pass: renewal, then reclaim, then signal poll, then
   * update poll, in one awaited call. This is what {@link runOnce} serializes
   * behind `inFlightManualPass` — a single coherent pass per ADR 0002, not
   * split across the independent slots interval mode uses.
   */
  async function runCombinedPass(): Promise<WorkflowClaimRenewalPassResult> {
    const startedAt = getNow();
    const workflowIds = [...target.listHeldWorkflowIds()];
    const renewal = await runRenewalSubPass(target, workflowIds);

    const reclaim = reclaimTarget === undefined ? undefined : await runReclaimPass(reclaimTarget);
    const signalPoll =
      signalPollTarget === undefined
        ? undefined
        : await runSignalPollSubPass(signalPollTarget, getNow);
    const updatePoll =
      updatePollTarget === undefined
        ? undefined
        : await runUpdatePollSubPass(updatePollTarget, getNow);

    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = {
      startedAt,
      finishedAt,
      ...renewal,
      ...(reclaim === undefined ? {} : { reclaim }),
      ...(signalPoll === undefined ? {} : { signalPoll }),
      ...(updatePoll === undefined ? {} : { updatePoll }),
    };
    emitPassComplete(result);
    return result;
  }

  /**
   * `Engine.runMaintenance()`'s entry point. `Engine.create()` documents
   * concurrent `runMaintenance()` calls as safe, but a second overlapping
   * call sharing this task's targets can otherwise observe the same stale
   * local state a first call has not finished updating yet — e.g. both calls
   * seeing the same redrive candidate's pre-takeover epoch and both invoking
   * `onReclaimed` for it concurrently. Dedupe to one in-flight combined pass
   * at a time: an overlapping caller gets the SAME promise as the pass
   * already running, rather than starting a second one, so "safe to call
   * concurrently" holds without ever double-driving a candidate. This is a
   * plain reentrancy guard, unrelated to interval mode's per-sub-pass cadence
   * slots — a manual caller still gets one coherent pass reflecting current
   * state, it is just never allowed to overlap another manual pass.
   */
  async function runOnce(): Promise<WorkflowClaimRenewalPassResult> {
    if (inFlightManualPass !== null) return inFlightManualPass;
    const pass = runCombinedPass().finally(() => {
      inFlightManualPass = null;
    });
    inFlightManualPass = pass;
    return pass;
  }

  const intervalDriver = createWorkflowClaimRenewalIntervalDriver({
    target,
    getNow,
    intervalMs,
    scheduler,
    ...(reclaimTarget === undefined ? {} : { reclaimTarget }),
    ...(signalPollTarget === undefined ? {} : { signalPollTarget }),
    ...(updatePollTarget === undefined ? {} : { updatePollTarget }),
    ...(onPassComplete === undefined ? {} : { onPassComplete }),
  });

  return {
    runOnce,
    start: () => intervalDriver.start(),
    stop: () => intervalDriver.stop(),
  };
}
