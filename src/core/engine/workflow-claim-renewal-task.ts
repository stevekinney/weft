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
 * **What this module owns.** Exactly the loop: read the set of held workflow
 * ids, renew each one, keep going when one fails, and report what happened.
 * The actual claim storage transitions (`buildWorkflowClaimRenewTransition`),
 * the in-flight-renewal guard *per workflow* that serializes a renewal
 * against a concurrent `release` (ADR `renew` row), and the deposition
 * side effects of a failed renewal — aborting the workflow's in-flight work
 * and emitting {@link WeftWorkflowClaimLostWarning} — all belong to the claim
 * holder this task is handed ({@link WorkflowClaimRenewalTarget}), typically a
 * `WorkflowClaimRegistry`. This module never imports that registry directly
 * and never imports `lease-deposition.ts`: coupling to the registry's exact
 * shape here would tie two patches built in parallel together, and duplicating
 * its warning-emission would double-emit once the two are wired together. This
 * task's only failure handling is: catch, record the outcome, move on to the
 * next workflow.
 *
 * **Renewal, reclaim, and signal poll each run on independent cadences in
 * interval mode.** `runOnce()` (the `backgroundTasks: 'manual'` entry point,
 * and what every test drives directly) still runs all three sub-steps
 * sequentially in one awaited call, exactly as ADR 0002 describes—a host
 * calling `runMaintenance()` gets one coherent pass (serialized against any
 * other concurrent `runOnce()` call — see `inFlightManualPass`). But
 * `start()`/interval-mode `tick()` gives renewal, reclaim, and signal poll
 * *three separate* single-flight slots. The reclaim scan is an unbounded
 * store-wide operation (a holder-keyed prefix scan, a running-status prefix
 * scan with serial point reads, and serial takeover attempts — any one of
 * which can await an `onReclaimed` drive that never settles) that can run
 * past `intervalMs`, even past `workflowClaimTtl`, on a large or
 * high-latency shared store. Renewal itself is cheap—one `conditionalBatch`
 * per held claim—and MUST keep firing on every tick regardless of how long
 * the previous tick's reclaim/poll work is still running, or an engine can
 * lose claims it is actively renewing simply because its own reclaim scan
 * from an earlier tick has not finished yet. Signal poll is likewise cheap
 * and time-sensitive — ADR 0002 advertises cross-engine signal delivery
 * within one renewal interval — so it MUST NOT share reclaim's slot either:
 * a slow or hung reclaim scan must never delay waking a parked
 * `waitForSignal` workflow. Coupling any two of these behind one shared
 * single-flight slot was the WFT-79 Finding 2 defect this module now avoids;
 * see `workflow-claim-renewal-task.test.ts`'s "renewal keeps its own
 * cadence" tests for the regression coverage.
 *
 * **The same cadence also drives two more ADR 0002 responsibilities**, each
 * OPTIONAL and each following the identical decoupling discipline: a reclaim
 * scan that attempts `takeover` for workflows whose holders have passed the
 * grace-adjusted `expire` judgment (ADR § Reclaiming stranded claims), driven
 * through the {@link WorkflowClaimReclaimTarget} structural seam — expected to
 * be satisfied by `listWorkflowClaimReclaimCandidates`
 * (`workflow-claim-reclaim-scan.ts`) plus `WorkflowClaimRegistry.takeover`,
 * adapted by `ownership-bootstrap.ts` — and owner-side polling of the durable
 * signal buffer for parked `waitForSignal` workflows (ADR § signal delivery,
 * "owner-side polling"), driven by calling `owner-side-signal-poll.ts`'s
 * {@link runOwnerSideSignalPoll} directly against an injected
 * {@link OwnerSideSignalPollTarget} — that module's own concrete adapter needs
 * `EngineInternals`/`inline-parking.ts`, which this module still does not
 * import. Both are `undefined` in {@link WorkflowClaimRenewalPassResult} when
 * their target option is omitted, which is how a caller with only the
 * renewal target (or a test) opts out of running them at all.
 *
 * @module core/engine/workflow-claim-renewal-task
 */

import type { OwnerSideSignalPollTarget } from './owner-side-signal-poll.ts';
import {
  runReclaimPass,
  runRenewalSubPass,
  runSignalPollSubPass,
  type WorkflowClaimReclaimPassResult,
  type WorkflowClaimReclaimTarget,
  type WorkflowClaimRenewalOutcome,
  type WorkflowClaimRenewalTarget,
  type WorkflowClaimSignalPollOutcome,
} from './workflow-claim-renewal-subpasses.ts';

/**
 * The result of one full pass ({@link WorkflowClaimRenewalTask.runOnce}).
 * `reclaim`/`signalPoll` are `undefined` exactly when the matching target
 * option was omitted — that omission is how a caller (or a test exercising
 * renewal alone) opts out of running that sub-step at all.
 */
export type WorkflowClaimRenewalPassResult = {
  /** `getNow()` read at the start of the pass, before any renewal call. */
  startedAt: number;
  /** `getNow()` read after renewal, reclaim, and signal-poll have all settled. */
  finishedAt: number;
  /** One entry per workflow id the pass attempted, in iteration order. */
  outcomes: WorkflowClaimRenewalOutcome[];
  /** `outcomes.filter(o => o.status === 'renewed').length`, precomputed for observability consumers. */
  renewedCount: number;
  /** `outcomes.filter(o => o.status === 'failed').length`, precomputed for observability consumers. */
  failedCount: number;
  /** Present only when this task was constructed with a `reclaimTarget`. */
  reclaim?: WorkflowClaimReclaimPassResult;
  /** Present only when this task was constructed with a `signalPollTarget`. */
  signalPoll?: WorkflowClaimSignalPollOutcome;
};

/**
 * The interval-scheduling seam this task drives its interval-mode cadence
 * through. The handle type is deliberately `unknown` on this public interface
 * — this task never inspects a handle, only round-trips whatever
 * `setInterval` returned back into `clearInterval` — so a test double can use
 * a plain number, object, or anything else as its handle without either side
 * needing to know the real timer type.
 */
export type WorkflowClaimRenewalIntervalScheduler = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
};

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
 * Real-timer scheduler used when no `scheduler` is injected. Keeps each real
 * `Timer` in a private map, keyed by an opaque token, so the public
 * {@link WorkflowClaimRenewalIntervalScheduler} interface never needs to name
 * the concrete timer type — `clearInterval` looks the real timer back up by
 * token rather than requiring a narrowed `unknown` parameter.
 */
function defaultScheduler(): WorkflowClaimRenewalIntervalScheduler {
  const timers = new Map<number, ReturnType<typeof setInterval>>();
  let nextToken = 1;
  return {
    setInterval(callback, intervalMs) {
      const token = nextToken;
      nextToken += 1;
      const handle = setInterval(callback, intervalMs);
      // Don't let the renewal timer keep an otherwise-idle process alive —
      // mirrors `lease-manager.ts`'s `startRenewal`.
      handle.unref?.();
      timers.set(token, handle);
      return token;
    },
    clearInterval(handle) {
      if (typeof handle !== 'number') return;
      const timer = timers.get(handle);
      if (timer === undefined) return;
      clearInterval(timer);
      timers.delete(handle);
    },
  };
}

/**
 * Create a claim-renewal task. Does not start any timer and does not run any
 * pass itself — the caller drives it, either via `start()` for interval mode
 * or by awaiting `runOnce()` directly under `backgroundTasks: 'manual'`. The
 * three sub-pass implementations it composes (`runReclaimPass`,
 * `runRenewalSubPass`, `runSignalPollSubPass`) live in
 * `workflow-claim-renewal-subpasses.ts`.
 */
export function createWorkflowClaimRenewalTask(
  options: WorkflowClaimRenewalTaskOptions,
): WorkflowClaimRenewalTask {
  const { target, getNow, intervalMs, reclaimTarget, signalPollTarget, onPassComplete } = options;
  const scheduler: WorkflowClaimRenewalIntervalScheduler = options.scheduler ?? defaultScheduler();

  let intervalHandle: unknown = null;
  // Interval mode uses THREE independent single-flight slots, not one shared
  // slot, so a slow sub-pass from an earlier tick can never block a different
  // sub-pass from firing on a later tick. See the module doc's "Renewal
  // cadence is independent..." section for why renewal is split from the rest
  // (WFT-79 Finding 2). Reclaim and signal-poll are ALSO split from each
  // other: `runReclaimPass` is an unbounded, store-wide scan that can await
  // every takeover/redrive candidate — including one whose `onReclaimed`
  // drive never settles — before returning, and sharing one slot with signal
  // polling would make cross-engine signal delivery's advertised
  // one-renewal-interval bound unbounded whenever reclaim runs long or hangs.
  let inFlightRenewal: Promise<WorkflowClaimRenewalPassResult> | null = null;
  let inFlightReclaim: Promise<WorkflowClaimRenewalPassResult> | null = null;
  let inFlightSignalPoll: Promise<WorkflowClaimRenewalPassResult> | null = null;
  // `runOnce()` bypasses the interval-mode single-flight slots above by
  // design (see that method's own doc), but two concurrent MANUAL calls
  // (`backgroundTasks: 'manual'` hosts calling `Engine.runMaintenance()`
  // concurrently, which `Engine.create` documents as safe) still share the
  // same underlying `target`/`reclaimTarget`/`signalPollTarget`. Without this
  // guard, two overlapping `runOnce()` reclaim passes can both observe the
  // same stale local epoch for a redrive candidate and both invoke
  // `onReclaimed` for it concurrently. This is a plain reentrancy guard, not
  // one of the interval-mode cadence slots: a manual caller always gets a
  // pass that reflects the most current state once its turn comes, it just
  // never overlaps another manual pass.
  let inFlightManualPass: Promise<WorkflowClaimRenewalPassResult> | null = null;

  /**
   * Fire `onPassComplete` for one completed sub-pass (or combined pass),
   * falling back to the console on a throwing sink so a broken observability
   * hook never turns already-committed durable work into a rejection.
   * Mirrors the engine's `onLog` convention.
   */
  function emitPassComplete(result: WorkflowClaimRenewalPassResult): void {
    try {
      onPassComplete?.(result);
    } catch (error) {
      console.error('weft: workflow claim renewal onPassComplete sink threw', error);
    }
  }

  /**
   * The full combined pass: renewal, then reclaim, then signal poll, in one
   * awaited call. This is what {@link runOnce} serializes behind
   * `inFlightManualPass` — a single coherent pass per ADR 0002, not split
   * across the independent slots the way interval mode's `tick()` is below.
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

    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = {
      startedAt,
      finishedAt,
      ...renewal,
      ...(reclaim === undefined ? {} : { reclaim }),
      ...(signalPoll === undefined ? {} : { signalPoll }),
    };
    emitPassComplete(result);
    return result;
  }

  /**
   * `Engine.runMaintenance()`'s entry point. `Engine.create()` documents
   * concurrent `runMaintenance()` calls as safe, but a second overlapping
   * call sharing this task's `target`/`reclaimTarget`/`signalPollTarget` can
   * otherwise observe the same stale local state a first call has not
   * finished updating yet — e.g. both calls seeing the same redrive
   * candidate's pre-takeover epoch and both invoking `onReclaimed` for it
   * concurrently. Dedupe to one in-flight combined pass at a time: an
   * overlapping caller gets the SAME promise as the pass already running,
   * rather than starting a second one, so "safe to call concurrently" holds
   * without ever double-driving a candidate. This is a plain reentrancy
   * guard, unrelated to interval mode's per-sub-pass cadence slots — a manual
   * caller still gets one coherent pass reflecting current state, it is just
   * never allowed to overlap another manual pass.
   */
  async function runOnce(): Promise<WorkflowClaimRenewalPassResult> {
    if (inFlightManualPass !== null) return inFlightManualPass;
    const pass = runCombinedPass().finally(() => {
      inFlightManualPass = null;
    });
    inFlightManualPass = pass;
    return pass;
  }

  /**
   * Interval mode's standalone renewal sub-pass: renewal only, `reclaim` and
   * `signalPoll` left `undefined` on the reported result. Runs under its own
   * `inFlightRenewal` slot, independent of {@link runReclaimAndPollTickPass}.
   */
  async function runRenewalTickPass(): Promise<WorkflowClaimRenewalPassResult> {
    const startedAt = getNow();
    const workflowIds = [...target.listHeldWorkflowIds()];
    const renewal = await runRenewalSubPass(target, workflowIds);
    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = { startedAt, finishedAt, ...renewal };
    emitPassComplete(result);
    return result;
  }

  /**
   * Interval mode's standalone reclaim-scan sub-pass: `outcomes` is always
   * empty (no renewal ran in this sub-pass). Runs under its own
   * `inFlightReclaim` slot — deliberately decoupled from
   * {@link runRenewalTickPass} AND from {@link runSignalPollTickPass} so this
   * sub-pass's unbounded, potentially-hanging store-wide work never delays
   * the next renewal tick or blocks cross-engine signal delivery. Only
   * invoked by `tick()` when `reclaimTarget` is configured.
   */
  async function runReclaimTickPass(): Promise<WorkflowClaimRenewalPassResult> {
    const startedAt = getNow();
    const reclaim = await runReclaimPass(reclaimTarget!);
    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = {
      startedAt,
      finishedAt,
      outcomes: [],
      renewedCount: 0,
      failedCount: 0,
      reclaim,
    };
    emitPassComplete(result);
    return result;
  }

  /**
   * Interval mode's standalone signal-poll sub-pass: `outcomes` is always
   * empty. Runs under its own `inFlightSignalPoll` slot, independent of both
   * {@link runRenewalTickPass} and {@link runReclaimTickPass} — see this
   * module's "Renewal cadence is independent..." doc section (WFT-79 Finding
   * 2) for why reclaim's unbounded scan must never gate signal delivery's
   * advertised one-renewal-interval bound. Only invoked by `tick()` when
   * `signalPollTarget` is configured.
   */
  async function runSignalPollTickPass(): Promise<WorkflowClaimRenewalPassResult> {
    const startedAt = getNow();
    const signalPoll = await runSignalPollSubPass(signalPollTarget!, getNow);
    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = {
      startedAt,
      finishedAt,
      outcomes: [],
      renewedCount: 0,
      failedCount: 0,
      signalPoll,
    };
    emitPassComplete(result);
    return result;
  }

  /**
   * Interval-tick entry point. Starts up to three independent sub-passes per
   * tick, each single-flight guarded on its OWN slot:
   *
   * - Renewal ({@link runRenewalTickPass}), guarded by `inFlightRenewal`. A
   *   tick is skipped only when the PREVIOUS RENEWAL sub-pass is still
   *   running — never because reclaim or signal-poll is still running.
   * - Reclaim ({@link runReclaimTickPass}), guarded by `inFlightReclaim`, and
   *   only started when `reclaimTarget` was configured.
   * - Signal poll ({@link runSignalPollTickPass}), guarded by
   *   `inFlightSignalPoll`, and only started when `signalPollTarget` was
   *   configured. Independent of reclaim's slot so a slow or hung reclaim
   *   scan can never stall cross-engine signal delivery.
   *
   * Never lets a rejection (e.g. `listHeldWorkflowIds` or
   * `listReclaimCandidateWorkflowIds` throwing) escape as an unhandled
   * rejection — each tracked in-flight promise is swallowed before its slot
   * is cleared.
   */
  function tick(): void {
    if (inFlightRenewal === null) {
      const pass = runRenewalTickPass();
      inFlightRenewal = pass;
      void pass
        .catch(() => {
          // Swallow: runRenewalTickPass already captures every per-workflow
          // failure as an outcome. A rejection here can only come from
          // listHeldWorkflowIds or getNow throwing, which this driver has no
          // useful reaction to beyond not leaking an unhandled rejection and
          // letting the next tick retry.
        })
        .finally(() => {
          inFlightRenewal = null;
        });
    }

    if (inFlightReclaim === null && reclaimTarget !== undefined) {
      const pass = runReclaimTickPass();
      inFlightReclaim = pass;
      void pass
        .catch(() => {
          // Swallow for the same reason as the renewal branch above:
          // runReclaimTickPass already captures discovery/attempt failures as
          // result fields, not rejections.
        })
        .finally(() => {
          inFlightReclaim = null;
        });
    }

    if (inFlightSignalPoll === null && signalPollTarget !== undefined) {
      const pass = runSignalPollTickPass();
      inFlightSignalPoll = pass;
      void pass
        .catch(() => {
          // Swallow for the same reason as the renewal branch above:
          // runSignalPollTickPass already captures poll failures as a result
          // field, not a rejection.
        })
        .finally(() => {
          inFlightSignalPoll = null;
        });
    }
  }

  function start(): void {
    if (intervalHandle !== null) return;
    intervalHandle = scheduler.setInterval(tick, intervalMs);
  }

  function stop(): void {
    if (intervalHandle === null) return;
    scheduler.clearInterval(intervalHandle);
    intervalHandle = null;
  }

  return { runOnce, start, stop };
}
