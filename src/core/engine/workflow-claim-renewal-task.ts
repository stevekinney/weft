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

import {
  runOwnerSideSignalPoll,
  type OwnerSideSignalPollResult,
  type OwnerSideSignalPollTarget,
} from './owner-side-signal-poll.ts';

/**
 * The minimal structural shape this task needs from a per-workflow claim
 * holder. A `WorkflowClaimRegistry` (built separately) is expected to satisfy
 * this interface; it is defined locally, rather than imported, so this module
 * has no dependency on that registry's concrete shape or module path.
 */
export type WorkflowClaimRenewalTarget = {
  /**
   * Every workflow id this engine currently holds a live claim for, active or
   * parked. Read fresh at the start of every pass — implementations may
   * return a live or a defensive-copy array; this task never mutates it and
   * takes its own snapshot before iterating.
   */
  listHeldWorkflowIds(): readonly string[];
  /**
   * Renew this engine's claim for one workflow. Resolves when the renewal
   * committed; rejects (with any error shape) when it did not — a lost-race
   * CAS failure, a storage error, or anything else. The implementation is
   * responsible for its own per-workflow in-flight-renewal guard against a
   * concurrent `release`, and for reacting to a lost claim (aborting
   * in-flight work, emitting {@link WeftWorkflowClaimLostWarning}). This task
   * only calls it, catches whatever it throws, and continues to the next
   * workflow.
   */
  renewWorkflowClaim(workflowId: string): Promise<void>;
};

/** One workflow's outcome within a single renewal pass. */
export type WorkflowClaimRenewalOutcome =
  | { workflowId: string; status: 'renewed' }
  | { workflowId: string; status: 'failed'; error: unknown };

/**
 * The minimal structural shape the reclaim-scan portion of a pass needs.
 * Defined locally for the same decoupling reason as
 * {@link WorkflowClaimRenewalTarget} — expected to be satisfied by an adapter
 * over `listWorkflowClaimReclaimCandidates` (`workflow-claim-reclaim-scan.ts`)
 * and `WorkflowClaimRegistry.takeover`, built by `ownership-bootstrap.ts`.
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
   * anti-thrash cooldown are the implementation's responsibility — this task
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
 * The reclaim-scan portion of one pass. `'discovery-failed'` covers
 * `listReclaimCandidateWorkflowIds()` itself throwing — without a candidate
 * list there is no per-workflow loop to run, but that must not fail the rest
 * of the pass (renewals already committed by then, and a
 * `backgroundTasks: 'manual'` host awaiting `runMaintenance()` must not see a
 * rejected promise for a problem isolated to this one sub-step).
 */
export type WorkflowClaimReclaimPassResult =
  | { status: 'completed'; outcomes: WorkflowClaimReclaimOutcome[]; reclaimedCount: number }
  | { status: 'discovery-failed'; error: unknown };

/**
 * The owner-side signal-poll portion of one pass. `'failed'` covers
 * {@link runOwnerSideSignalPoll} itself rejecting (e.g. its target's
 * `hasBufferedSignal` throwing) — same non-fatal-to-the-pass treatment as
 * {@link WorkflowClaimReclaimPassResult}'s `'discovery-failed'`.
 */
export type WorkflowClaimSignalPollOutcome =
  | { status: 'completed'; result: OwnerSideSignalPollResult }
  | { status: 'failed'; error: unknown };

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
   * guard by design — same as `renewOnce()` does relative to
   * `startRenewal()`'s timer in `lease-manager.ts` — so an explicit caller
   * always gets a fresh pass rather than being silently skipped because an
   * interval-driven pass happens to be in flight.
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
 * or by awaiting `runOnce()` directly under `backgroundTasks: 'manual'`.
 */
/**
 * Run one reclaim-scan sub-pass: list candidates, attempt each once, and
 * catch both a per-candidate throw and the listing call itself throwing. See
 * {@link WorkflowClaimReclaimPassResult}'s doc for why discovery failure is a
 * result, not a rejection.
 */
async function runReclaimPass(
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

export function createWorkflowClaimRenewalTask(
  options: WorkflowClaimRenewalTaskOptions,
): WorkflowClaimRenewalTask {
  const { target, getNow, intervalMs, reclaimTarget, signalPollTarget, onPassComplete } = options;
  const scheduler: WorkflowClaimRenewalIntervalScheduler = options.scheduler ?? defaultScheduler();

  let intervalHandle: unknown = null;
  let inFlightPass: Promise<WorkflowClaimRenewalPassResult> | null = null;

  async function runOnce(): Promise<WorkflowClaimRenewalPassResult> {
    const startedAt = getNow();
    const workflowIds = [...target.listHeldWorkflowIds()];
    const outcomes: WorkflowClaimRenewalOutcome[] = [];
    for (const workflowId of workflowIds) {
      try {
        await target.renewWorkflowClaim(workflowId);
        outcomes.push({ workflowId, status: 'renewed' });
      } catch (error) {
        outcomes.push({ workflowId, status: 'failed', error });
      }
    }

    const reclaim = reclaimTarget === undefined ? undefined : await runReclaimPass(reclaimTarget);

    let signalPoll: WorkflowClaimSignalPollOutcome | undefined;
    if (signalPollTarget !== undefined) {
      try {
        signalPoll = {
          status: 'completed',
          result: await runOwnerSideSignalPoll({ target: signalPollTarget, getNow }),
        };
      } catch (error) {
        signalPoll = { status: 'failed', error };
      }
    }

    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = {
      startedAt,
      finishedAt,
      outcomes,
      renewedCount: outcomes.filter((outcome) => outcome.status === 'renewed').length,
      failedCount: outcomes.filter((outcome) => outcome.status === 'failed').length,
      ...(reclaim === undefined ? {} : { reclaim }),
      ...(signalPoll === undefined ? {} : { signalPoll }),
    };
    // A throwing observability sink must not turn a successful renewal pass into
    // a rejection: the durable work is already committed at this point, and in
    // interval mode `tick()`'s catch would swallow it with no diagnostic at all.
    // Mirrors the engine's `onLog` convention of falling back to the console.
    try {
      onPassComplete?.(result);
    } catch (error) {
      console.error('weft: workflow claim renewal onPassComplete sink threw', error);
    }
    return result;
  }

  /**
   * Interval-tick entry point: single-flight guarded so an overlapping tick
   * (a pass slower than `intervalMs`) is skipped rather than starting a
   * concurrent pass. Never lets a rejection (e.g. `listHeldWorkflowIds`
   * throwing synchronously) escape as an unhandled rejection — the tracked
   * in-flight promise is swallowed before the slot is cleared.
   */
  function tick(): void {
    if (inFlightPass !== null) return;
    const pass = runOnce();
    inFlightPass = pass;
    void pass
      .catch(() => {
        // Swallow: runOnce already captures every per-workflow failure as an
        // outcome. A rejection here can only come from listHeldWorkflowIds or
        // getNow throwing, which this driver has no useful reaction to beyond
        // not leaking an unhandled rejection and letting the next tick retry.
      })
      .finally(() => {
        inFlightPass = null;
      });
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
