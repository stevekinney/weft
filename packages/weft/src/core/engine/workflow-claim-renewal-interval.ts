/**
 * Interval-mode driving for `workflow-claim-renewal-task.ts`'s claim-renewal
 * task. Split out purely to keep that module under the repository's
 * implementation-file-size ceiling as the number of independent interval-mode
 * sub-passes has grown (renewal, reclaim, signal poll, update poll) — see
 * that module's own doc for the "each sub-pass gets its own single-flight
 * slot" design this file implements. `workflow-claim-renewal-task.ts` is the
 * only expected caller; `runOnce()`/the manual combined pass stays there,
 * since it shares none of this file's interval-scheduling state.
 *
 * @module core/engine/workflow-claim-renewal-interval
 */

import type { OwnerSideSignalPollTarget } from './owner-side-signal-poll.ts';
import type { OwnerSideUpdatePollTarget } from './owner-side-update-poll.ts';
import {
  runReclaimPass,
  runRenewalSubPass,
  runSignalPollSubPass,
  runUpdatePollSubPass,
  type WorkflowClaimReclaimTarget,
  type WorkflowClaimRenewalTarget,
} from './workflow-claim-renewal-subpasses.ts';
import type {
  WorkflowClaimRenewalIntervalScheduler,
  WorkflowClaimRenewalPassResult,
} from './workflow-claim-renewal-task.ts';

/** Options for {@link createWorkflowClaimRenewalIntervalDriver}. Mirrors the relevant subset of `WorkflowClaimRenewalTaskOptions`. */
export type WorkflowClaimRenewalIntervalDriverOptions = {
  target: WorkflowClaimRenewalTarget;
  getNow: () => number;
  intervalMs: number;
  scheduler: WorkflowClaimRenewalIntervalScheduler;
  reclaimTarget?: WorkflowClaimReclaimTarget;
  signalPollTarget?: OwnerSideSignalPollTarget;
  updatePollTarget?: OwnerSideUpdatePollTarget;
  onPassComplete?: (result: WorkflowClaimRenewalPassResult) => void;
};

/** A running interval-mode driver. */
export type WorkflowClaimRenewalIntervalDriver = {
  /** Start interval-driven passes. Idempotent — a second call while already started does not create a second interval. */
  start(): void;
  /** Stop interval-driven passes. Idempotent. Only clears the interval; passes already in flight still run to completion. */
  stop(): void;
};

/**
 * Real-timer scheduler used when no `scheduler` is injected. Keeps each real
 * `Timer` in a private map, keyed by an opaque token, so the public
 * {@link WorkflowClaimRenewalIntervalScheduler} interface never needs to name
 * the concrete timer type — `clearInterval` looks the real timer back up by
 * token rather than requiring a narrowed `unknown` parameter.
 */
export function defaultWorkflowClaimRenewalScheduler(): WorkflowClaimRenewalIntervalScheduler {
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
 * Create the interval-mode driver: four independent single-flight sub-passes
 * (renewal, reclaim, signal poll, update poll), each on its OWN cadence slot
 * so a slow or hung sub-pass never delays a different one — see
 * `workflow-claim-renewal-task.ts`'s module doc for the full rationale
 * (WFT-79 Finding 2 and its extensions).
 */
export function createWorkflowClaimRenewalIntervalDriver(
  options: WorkflowClaimRenewalIntervalDriverOptions,
): WorkflowClaimRenewalIntervalDriver {
  const {
    target,
    getNow,
    intervalMs,
    scheduler,
    reclaimTarget,
    signalPollTarget,
    updatePollTarget,
    onPassComplete,
  } = options;

  let intervalHandle: unknown = null;
  // FOUR independent single-flight slots, not one shared slot, so a slow
  // sub-pass from an earlier tick can never block a different sub-pass from
  // firing on a later tick. Renewal is cheap and MUST keep firing every tick
  // regardless of the others. Reclaim is an unbounded, potentially-hanging
  // store-wide scan. Signal poll and update poll are both cheap and
  // time-sensitive (ADR 0002 advertises a one-renewal-interval delivery
  // bound for each), so neither may share reclaim's slot or each other's.
  let inFlightRenewal: Promise<WorkflowClaimRenewalPassResult> | null = null;
  let inFlightReclaim: Promise<WorkflowClaimRenewalPassResult> | null = null;
  let inFlightSignalPoll: Promise<WorkflowClaimRenewalPassResult> | null = null;
  let inFlightUpdatePoll: Promise<WorkflowClaimRenewalPassResult> | null = null;

  /**
   * Fire `onPassComplete` for one completed sub-pass, falling back to the
   * console on a throwing sink so a broken observability hook never turns
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
   * Interval mode's standalone renewal sub-pass: renewal only, every other
   * field left `undefined` on the reported result. Runs under its own
   * `inFlightRenewal` slot, independent of every other sub-pass.
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
   * `inFlightReclaim` slot — deliberately decoupled from every other sub-pass
   * so this sub-pass's unbounded, potentially-hanging store-wide work never
   * delays the next renewal tick or blocks cross-engine signal/update
   * delivery. Only invoked by `tick()` when `reclaimTarget` is configured.
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
   * empty. Runs under its own `inFlightSignalPoll` slot, independent of every
   * other sub-pass — see this file's module doc for why reclaim's unbounded
   * scan must never gate signal delivery's advertised one-renewal-interval
   * bound. Only invoked by `tick()` when `signalPollTarget` is configured.
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
   * Interval mode's standalone update-poll sub-pass (WFT-79): `outcomes` is
   * always empty. Runs under its own `inFlightUpdatePoll` slot, independent
   * of every other sub-pass for the same reason signal poll is. Only invoked
   * by `tick()` when `updatePollTarget` is configured.
   */
  async function runUpdatePollTickPass(): Promise<WorkflowClaimRenewalPassResult> {
    const startedAt = getNow();
    const updatePoll = await runUpdatePollSubPass(updatePollTarget!, getNow);
    const finishedAt = getNow();
    const result: WorkflowClaimRenewalPassResult = {
      startedAt,
      finishedAt,
      outcomes: [],
      renewedCount: 0,
      failedCount: 0,
      updatePoll,
    };
    emitPassComplete(result);
    return result;
  }

  /**
   * Interval-tick entry point. Starts up to four independent sub-passes per
   * tick, each single-flight guarded on its OWN slot:
   *
   * - Renewal ({@link runRenewalTickPass}), guarded by `inFlightRenewal`. A
   *   tick is skipped only when the PREVIOUS RENEWAL sub-pass is still
   *   running — never because reclaim, signal-poll, or update-poll is still
   *   running.
   * - Reclaim ({@link runReclaimTickPass}), guarded by `inFlightReclaim`, and
   *   only started when `reclaimTarget` was configured.
   * - Signal poll ({@link runSignalPollTickPass}), guarded by
   *   `inFlightSignalPoll`, and only started when `signalPollTarget` was
   *   configured.
   * - Update poll ({@link runUpdatePollTickPass}), guarded by
   *   `inFlightUpdatePoll`, and only started when `updatePollTarget` was
   *   configured.
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

    if (inFlightUpdatePoll === null && updatePollTarget !== undefined) {
      const pass = runUpdatePollTickPass();
      inFlightUpdatePoll = pass;
      void pass
        .catch(() => {
          // Swallow for the same reason as the renewal branch above:
          // runUpdatePollTickPass already captures poll failures as a result
          // field, not a rejection.
        })
        .finally(() => {
          inFlightUpdatePoll = null;
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

  return { start, stop };
}
