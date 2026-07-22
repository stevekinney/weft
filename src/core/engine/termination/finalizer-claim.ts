/**
 * Durable-claim mechanics for the workflow finalizer drive (issue #446 Phase 2).
 * This module owns the `teardownOwed` marker's lifecycle — the stale-claim reclaim
 * horizon, the retry backoff schedule, the dead-letter record shape, and every fenced
 * write that mutates the marker (claim CAS, settle CAS, re-arm, clear, dead-letter). The
 * orchestration that decides WHEN to call these lives in `./finalizer.ts`; keeping the
 * byte-level claim transitions here keeps each module under the size budget and isolates
 * the part where CAS correctness matters most.
 *
 * Concurrency contract (see `./finalizer.ts` for the full model): a holder fenced-CAS's
 * `owed → running` (stamping `claimedAt`) before running the finalizer, then settle-CAS's
 * the EXACT `running` bytes it wrote when clearing, rescheduling, or dead-lettering — so a
 * concurrent reclaimer can never clobber a fresher claim. Liveness is decided purely by
 * the clock via {@link teardownStaleThresholdMs}.
 *
 * @module core/engine/termination/finalizer-claim
 */

import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { buildTimerBatchOperations, parseDuration } from '../../scheduler.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import { createTeardownTimerId, type TeardownClaim } from '../state-utilities.ts';
import type { RunnableFinalizer } from './finalizer-activity.ts';

/** Maximum finalizer attempts before the teardown is dead-lettered (the leak horizon). */
export const MAX_TEARDOWN_ATTEMPTS = 8;

/**
 * Time-bounded exponential-with-cap backoff schedule for finalizer retries, in
 * milliseconds, indexed by 1-based attempt that just FAILED. Roughly 1m, 5m, 15m,
 * 1h, then hourly to the dead-letter horizon. This intentionally overrides the
 * repository's "cap retries at 5" convention (which targets polling loops): a
 * finalizer destroys a paid external resource, so giving up too early is an
 * unbounded billable leak. The override is called out in the PR description.
 */
const TEARDOWN_BACKOFF_SCHEDULE_MS = [
  60_000, // after attempt 1 → +1m
  300_000, // after attempt 2 → +5m
  900_000, // after attempt 3 → +15m
  3_600_000, // after attempt 4 → +1h
] as const;

/**
 * Default per-attempt budget assumed for a finalizer that declares no `timeout`, used
 * ONLY to derive the stale-claim reclaim horizon (never imposed as an execution cap —
 * a no-timeout finalizer still runs unbounded). Generous so a finalizer that completes
 * in seconds, the normal case, is never falsely reclaimed mid-run by a racing tick.
 */
const DEFAULT_FINALIZER_STALE_BUDGET_MS = 5 * 60_000; // 5m

/**
 * Margin added to a finalizer's per-attempt budget before a `running` claim is
 * considered stale (abandoned by a crashed/deposed holder) and reclaimable. With a
 * declared `timeout`, the running attempt is aborted by its own per-attempt cap well
 * before this elapses, so a healthy in-progress finalizer is never reclaimed.
 */
const TEARDOWN_STALE_MARGIN_MS = 30_000; // 30s

/** Short re-arm delay for the self-heal timer written on a non-settling drive exit. */
export const TEARDOWN_SELF_HEAL_DELAY_MS = 30_000; // 30s

/** Backoff for the timer rescheduled after a failed finalizer attempt (1-based attempt). */
export function teardownBackoffMs(failedAttempt: number): number {
  const index = failedAttempt - 1;
  return (
    TEARDOWN_BACKOFF_SCHEDULE_MS[index] ??
    TEARDOWN_BACKOFF_SCHEDULE_MS[TEARDOWN_BACKOFF_SCHEDULE_MS.length - 1]!
  );
}

/**
 * The reclaim horizon for a `running` claim: a holder that has not settled within this
 * window of `claimedAt` is presumed crashed/deposed and its claim is reclaimable. Equal
 * to the finalizer's per-attempt budget (its declared `timeout`, or
 * {@link DEFAULT_FINALIZER_STALE_BUDGET_MS}) plus {@link TEARDOWN_STALE_MARGIN_MS}.
 */
export function teardownStaleThresholdMs(finalizer: RunnableFinalizer): number {
  const perAttemptBudget =
    finalizer.timeout === undefined
      ? DEFAULT_FINALIZER_STALE_BUDGET_MS
      : parseDuration(finalizer.timeout);
  return perAttemptBudget + TEARDOWN_STALE_MARGIN_MS;
}

/** Whether a `running` claim is reclaimable: its holder has not settled within the stale window. */
export function runningClaimIsStale(
  internals: EngineInternals,
  claim: TeardownClaim,
  finalizer: RunnableFinalizer,
): boolean {
  if (claim.status !== 'running') return true; // an `owed` claim is always claimable.
  if (claim.claimedAt === undefined) return true; // malformed `running` (no stamp) — reclaim.
  return internals.options.getNow() - claim.claimedAt >= teardownStaleThresholdMs(finalizer);
}

/**
 * Durable audit record written to {@link KEYS.teardownDeadLetter} when a workflow's
 * finalizer permanently fails — the retry horizon was reached, or the recorded resource
 * state vanished so the finalizer can never run. It is the supported durable operator
 * record for a leaked external resource; {@link Engine.getFinalizerStatus} and the matching
 * transport operation expose it without relying on best-effort teardown events. The record
 * is excluded from the workflow purge delete-set so it survives after the workflow record
 * is gone.
 */
export interface TeardownDeadLetterRecord {
  /** The workflow type whose finalizer leaked. */
  type: string;
  /** The last finalizer error message (or the reason teardown was abandoned). */
  lastError: string;
  /** The attempt count reached before dead-lettering. */
  attempts: number;
  /** Engine clock when the record was written. */
  deadLetteredAt: number;
  /** Concrete run identity, present on records written from current workflow state. */
  workflowExecutionToken?: string;
  /** The decoded `ctx.setFinalizerState` payload, when it was still recoverable. */
  finalizerInput?: unknown;
}

/** Build the operations that arm a fresh `wf-teardown:` timer at `fireAt` (same token). */
export function teardownTimerOperations(
  token: string,
  workflowId: string,
  fireAt: number,
): BatchOperation[] {
  return buildTimerBatchOperations({
    id: createTeardownTimerId(token),
    workflowId,
    fireAt,
    kind: 'teardown',
  });
}

/** Encode an `owed` claim (attempts as given, no `claimedAt` while owed). */
export function encodeOwedClaim(attempts: number, token: string): Uint8Array {
  const owedClaim: TeardownClaim = { status: 'owed', attempts, token };
  return encode(owedClaim);
}

/** Encode the `running` claim a holder writes to atomically claim the marker. */
export function encodeRunningClaim(attempts: number, token: string, claimedAt: number): Uint8Array {
  const runningClaim: TeardownClaim = { status: 'running', attempts, token, claimedAt };
  return encode(runningClaim);
}

/**
 * Re-arm a future `wf-teardown:` timer for a non-settling drive exit (lost CAS, a
 * presumed-live `running` claim, a shutdown abort, or a leave-the-marker case), so the
 * claim is not stranded after the scheduler deletes the fired timer. The marker bytes
 * are left untouched — only the timer is (re)written. Fenced, best-effort: a deposed
 * engine that loses the fence simply yields to the new owner, whose own timer drives it.
 */
export async function rearmTeardownTimer(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  delayMs: number,
): Promise<void> {
  const fireAt = internals.options.getNow() + delayMs;
  try {
    await commitFencedEngineWrite(
      internals,
      teardownTimerOperations(token, workflowId, fireAt),
      [],
      () => new Error('teardown self-heal re-arm lost the lease fence'),
    );
  } catch {
    // Deposed or lost-race: the current owner re-drives via its own timer.
  }
}

/**
 * Clear the teardown marker for a workflow that turned out not to owe a finalizer run
 * after all — a stale timer or a vanished/ineligible workflow. Conditioned on the marker
 * still being byte-for-byte `expectedBytes` (the bytes this drive read), so a concurrent
 * drive that already re-claimed or re-armed the marker — e.g. a same-id rerun whose fresh
 * cancellation wrote a NEW claim — is never clobbered. A lost CAS (someone changed it
 * first) is a benign no-op. Swallows a lost-fence error: a deposed engine simply leaves
 * the marker for the new owner. No timer is re-armed: clearing the marker IS the settle.
 */
export async function clearTeardownMarker(
  internals: EngineInternals,
  workflowId: string,
  expectedBytes: Uint8Array,
): Promise<boolean> {
  try {
    return await commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      [{ type: 'delete', key: KEYS.teardownOwed(workflowId) }],
      [{ key: KEYS.teardownOwed(workflowId), expectedValue: expectedBytes }],
    );
  } catch {
    // Deposed: leave the marker; the current owner re-drives it.
    return false;
  }
}

/**
 * Atomically claim the marker: CAS `owed → running` only if it is byte-for-byte the
 * `expectedBytes` we read (so concurrent reclaimers can't both win), fenced on the lease
 * epoch. Returns the `running` bytes we wrote on success (needed as the settle CAS
 * precondition), or `null` on a lost CAS.
 */
export async function claimTeardownMarker(
  internals: EngineInternals,
  workflowId: string,
  expectedBytes: Uint8Array,
  attempts: number,
  token: string,
): Promise<Uint8Array | null> {
  const runningBytes = encodeRunningClaim(attempts, token, internals.options.getNow());
  const claimed = await commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    [{ type: 'put', key: KEYS.teardownOwed(workflowId), value: runningBytes }],
    [{ key: KEYS.teardownOwed(workflowId), expectedValue: expectedBytes }],
  );
  return claimed ? runningBytes : null;
}

/**
 * Commit a settle batch conditioned on the `teardownOwed` marker still equalling the
 * exact `running` bytes this drive wrote (Codex MF2). If a reclaimer overwrote the
 * marker first, the CAS fails and this returns `false` WITHOUT committing — the caller
 * must then skip dispatching any teardown event. A deposition still hard-halts (the
 * fenced helper throws), which the drive's outer try/catch routes to a cleanup error.
 */
export async function settleOnRunningClaim(
  internals: EngineInternals,
  workflowId: string,
  runningBytes: Uint8Array,
  operations: BatchOperation[],
): Promise<boolean> {
  return commitFencedEngineWriteAllowingPreconditionFailure(internals, operations, [
    { key: KEYS.teardownOwed(workflowId), expectedValue: runningBytes },
  ]);
}

/**
 * Write the durable dead-letter record and clear the teardown + finalizer-state keys,
 * conditioned on the marker still being byte-for-byte `expectedBytes`. Used both at the
 * retry horizon (`expectedBytes` = the `running` bytes this drive wrote) and when the
 * recorded resource state vanished before any claim (`expectedBytes` = the `owed` bytes
 * this drive read). Conditioning on `expectedBytes` in BOTH cases prevents a stale drive
 * from dead-lettering after a concurrent drive already settled the marker — which would
 * falsely report a leak after a successful teardown. Returns whether the durable write
 * committed; the caller dispatches the dead-lettered event only when it did.
 */
export async function deadLetterTeardown(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  attempts: number,
  expectedBytes: Uint8Array,
  details: { lastError: string; finalizerInput: unknown },
  workflowExecutionToken?: string,
): Promise<boolean> {
  const deadLetter: TeardownDeadLetterRecord = {
    type: workflowType,
    lastError: details.lastError,
    attempts,
    deadLetteredAt: internals.options.getNow(),
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
    // Omit `finalizerInput` entirely when absent rather than persisting `undefined`,
    // so the record's shape stays clean under `exactOptionalPropertyTypes`. (typescript MF.)
    ...(details.finalizerInput === undefined ? {} : { finalizerInput: details.finalizerInput }),
  };
  return settleOnRunningClaim(internals, workflowId, expectedBytes, [
    { type: 'delete', key: KEYS.teardownOwed(workflowId) },
    { type: 'delete', key: KEYS.finalizerState(workflowId) },
    { type: 'put', key: KEYS.teardownDeadLetter(workflowId), value: encode(deadLetter) },
  ]);
}
