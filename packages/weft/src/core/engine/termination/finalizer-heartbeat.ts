/**
 * Liveness heartbeat for a teardown drive (COR-1422). A finalizer that declares no `timeout`
 * runs unbounded, so the stale-running horizon cannot tell a live owner from a dead host. While
 * such a drive is live it renews its `running` marker with a fenced CAS: a fresh `renewedAt`
 * and a replacement watchdog, same token and attempt count. A marker that stops being renewed
 * is a dead host, which the stale reclaim may then take over and count.
 *
 * Renewal runs as a side timer scoped to the awaited drive, so `backgroundTasks: 'manual'`'s
 * no-background-timers guarantee (no engine-lifetime interval) is unaffected, as for the per-attempt
 * timeout timer. It never settles the marker: it only moves the hold's bytes
 * forward, so the drive's settle CAS follows the renewed bytes. A renewal that loses its CAS
 * means another drive reclaimed the marker, so renewal stops for good. It also stops on settle
 * and once the engine's shutdown signal aborts.
 *
 * @module core/engine/termination/finalizer-heartbeat
 */

import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import type { TeardownClaim } from '../state-utilities.ts';
import {
  runFinalizerActivity,
  type FinalizerAttemptResult,
  type RunnableFinalizer,
} from './finalizer-activity.ts';
import {
  encodeRunningClaim,
  teardownStaleThresholdMs,
  teardownTimerOperations,
  type TeardownHold,
} from './finalizer-claim.ts';

/** Whether a `running` claim is reclaimable: its holder has not settled within the stale window. */
export function runningClaimIsStale(
  internals: EngineInternals,
  claim: TeardownClaim,
  finalizer: RunnableFinalizer,
): boolean {
  if (claim.status !== 'running') return true; // an `owed` claim is always claimable.
  if (claim.claimedAt === undefined) return true; // malformed `running` (no stamp) — reclaim.
  return (
    internals.options.getNow() - (claim.renewedAt ?? claim.claimedAt) >=
    teardownStaleThresholdMs(finalizer)
  );
}

/**
 * The fire time of the watchdog a drive re-arms when it yields to a `running` claim it judged
 * fresh: the claim CAS armed one watchdog, and the yield consumed it (the scheduler deletes
 * the fired key), which happens whenever this engine's horizon or clock disagrees with the
 * claimer's. The target is `claimedAt` plus THIS drive's horizon, a key every engine computes
 * identically so concurrent yields collapse onto one timer; the write moves it past the fired
 * key when needed (see {@link fireAtAfterFired}).
 */
export function liveClaimWatchdogFireAt(
  claim: TeardownClaim,
  finalizer: RunnableFinalizer,
  firedAt: number,
): number {
  return (claim.renewedAt ?? claim.claimedAt ?? firedAt) + teardownStaleThresholdMs(finalizer);
}

/** Renewals per stale horizon: a live drive renews well before a peer could judge it stale. */
const RENEWALS_PER_HORIZON = 3;

/** A running heartbeat: {@link TeardownHeartbeat.stop} halts it and reports any in-flight renewal. */
export interface TeardownHeartbeat {
  /**
   * Stop renewing. Returns the in-flight renewal, if any, which the caller must await before
   * settling so the settle CAS reads the renewed bytes; `undefined` when none is pending.
   */
  stop: () => Promise<void> | undefined;
}

const NO_HEARTBEAT: TeardownHeartbeat = { stop: () => undefined };

/**
 * Start renewing `hold` for a drive that holds the `running` marker. A finalizer with a
 * declared `timeout` is aborted by its own cap before the stale horizon, so it needs none.
 * `hold` is updated in place after each committed renewal.
 */
export function startTeardownHeartbeat(
  internals: EngineInternals,
  workflowId: string,
  hold: TeardownHold,
  spentAttempts: number,
  token: string,
  finalizer: RunnableFinalizer,
  firedAt: number,
): TeardownHeartbeat {
  if (finalizer.timeout !== undefined) return NO_HEARTBEAT;
  const horizonMs = teardownStaleThresholdMs(finalizer);
  let halted = false;
  let inFlight: Promise<void> | undefined;

  const halt = (): void => {
    halted = true;
    clearInterval(interval);
  };

  const renew = async (): Promise<boolean> => {
    const renewedAt = internals.options.getNow();
    const runningBytes = encodeRunningClaim(
      spentAttempts,
      token,
      hold.claimedAt ?? renewedAt,
      renewedAt,
    );
    const watchdog = teardownTimerOperations(token, workflowId, renewedAt + horizonMs, firedAt);
    const renewed = await commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      null,
      [
        ...hold.watchdogCleanup,
        { type: 'put', key: KEYS.teardownOwed(workflowId), value: runningBytes },
        ...watchdog,
      ],
      [{ key: KEYS.teardownOwed(workflowId), expectedValue: hold.bytes }],
    );
    if (renewed) {
      hold.bytes = runningBytes;
      hold.watchdogCleanup = watchdog.map((operation): BatchOperation => ({
        type: 'delete',
        key: operation.key,
      }));
    }
    return renewed;
  };

  const interval = setInterval(
    () => {
      if (halted || inFlight !== undefined) return;
      if (internals.abortController.signal.aborted) {
        halt();
        return;
      }
      // A transient write failure leaves the marker as it was: retry on the next tick. Only a
      // lost CAS, a settle, or an abort ends renewal.
      const current: Promise<void> = renew().then(
        (renewed) => {
          if (!renewed) halt();
          return undefined;
        },
        () => undefined,
      );
      inFlight = current;
      void current.then(() => {
        if (inFlight === current) inFlight = undefined;
        return undefined;
      });
    },
    Math.floor(horizonMs / RENEWALS_PER_HORIZON),
  );

  return {
    stop: () => {
      halt();
      return inFlight;
    },
  };
}

/**
 * Run one finalizer attempt under a heartbeat, then let any in-flight renewal land so the
 * caller's settle CAS reads the renewed bytes. The wait happens only when a renewal is pending,
 * so the common path adds no `await` hop.
 */
export async function runFinalizerUnderHeartbeat(
  internals: EngineInternals,
  workflowId: string,
  hold: TeardownHold,
  claim: { spentAttempts: number; attempt: number; token: string; firedAt: number },
  finalizer: RunnableFinalizer,
  finalizerInput: unknown,
  workflowExecutionToken: string | undefined,
): Promise<FinalizerAttemptResult> {
  const heartbeat = startTeardownHeartbeat(
    internals,
    workflowId,
    hold,
    claim.spentAttempts,
    claim.token,
    finalizer,
    claim.firedAt,
  );
  let result: FinalizerAttemptResult;
  let renewalInFlight: Promise<void> | undefined;
  try {
    result = await runFinalizerActivity(
      finalizer,
      finalizerInput,
      claim.attempt,
      internals.abortController.signal,
      workflowExecutionToken,
    );
  } finally {
    renewalInFlight = heartbeat.stop();
  }
  if (renewalInFlight !== undefined) await renewalInFlight;
  return result;
}
