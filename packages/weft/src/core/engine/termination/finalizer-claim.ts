/**
 * Durable-claim mechanics for the workflow finalizer drive (issue #446 Phase 2).
 * This module owns the `teardownOwed` marker's lifecycle — the stale-claim reclaim
 * horizon, the retry backoff schedule, the dead-letter record shape, and every fenced
 * write that mutates the marker (claim CAS, settle CAS, re-arm, clear, dead-letter). The
 * orchestration that decides WHEN to call these lives in `./finalizer.ts`; keeping the
 * byte-level claim transitions here keeps each module under the size budget and isolates
 * the part where CAS correctness matters most.
 *
 * Concurrency contract (see `./finalizer.ts` for the full model): a holder CAS's
 * `owed → running` (stamping `claimedAt`) before running the finalizer, then settle-CAS's
 * the EXACT `running` bytes it wrote when clearing, rescheduling, or dead-lettering — so a
 * concurrent reclaimer can never clobber a fresher claim. Liveness is decided purely by
 * the clock via {@link teardownStaleThresholdMs}.
 *
 * Every write here is engine-scoped (`workflowId: null` to the fenced commit): the marker's
 * byte-for-byte CAS is the sole arbiter between engines, in every ownership mode. A
 * definition-level finalizer runs only after a `cancelled`/`timed-out` terminal, by which
 * time the workflow's own `wf-owner-epoch` claim has been released or rotated away, so
 * fencing the marker on it would fail closed forever (COR-1415). The post-terminal purge and
 * checkpoint-prune writers and the external-terminal commit are engine-scoped the same way;
 * under `ownership: 'lease'` the global lease epoch condition still applies, and under
 * `'none'` there is no epoch at all.
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
  /**
   * The dead-lettering run's own pinned {@link import('../../types/state.ts').WorkflowState.revision}
   * (WFT-21) — additive, optional field: absent on a record written before
   * this field existed, or for a legacy run with no persisted `revision`,
   * in which case it never counts against any specific revision in
   * {@link import('../retained-recovery-record-count.ts').countTeardownDeadLettersForRevision}'s
   * scan, mirroring `WorkflowState.revision`'s own legacy-record precedent.
   * No persisted-data schema-version bump — decode already tolerates its
   * absence (`finalizer-status.ts`'s field-presence checks, not an
   * exhaustive-key check).
   */
  revision?: string;
}

/**
 * Fixed second key segment `deadLetterTeardown()` uses for
 * {@link KEYS.teardownDeadLetterHistory} when the dead-lettering run has no
 * `workflowExecutionToken` (a legacy, pre-token run) — WFT-21, Codex review
 * round 3, P2. A second legacy run reusing the same workflow id and ALSO
 * dead-lettering would collide on this same sentinel segment, silently
 * losing the earlier legacy record's reference — a bounded edge case
 * affecting only runs that predate `WorkflowState.workflowExecutionToken`,
 * mirroring this file's own `revision === undefined` legacy fallback.
 *
 * Exported (not module-private) so
 * {@link import('../retained-recovery-record-count.ts').countTeardownDeadLettersForRevision}
 * can compute the exact history key a token-less single-slot
 * `KEYS.teardownDeadLetter` record would have produced, to detect whether a
 * legacy single-slot record already has a history sibling (WFT-21, Codex
 * review, item 7).
 */
export const LEGACY_DEAD_LETTER_HISTORY_TOKEN = 'legacy';

/**
 * The `firedAt` for a teardown timer write made OUTSIDE a fired teardown-timer callback (a
 * test fixture or a direct primitive call): no timer has fired, so nothing constrains the key.
 */
export const OUTSIDE_FIRED_TIMER = Number.NEGATIVE_INFINITY;

/**
 * The fire time a timer written from inside a fired teardown-timer callback must use. The
 * scheduler deletes the fired key once the callback returns, and a timer key embeds its
 * `fireAt` and token, so a write that lands on the fired key (same token, same `fireAt`) is
 * erased with it and strands the marker. A `desiredFireAt` strictly after `firedAt` is kept
 * as is; anything else moves one self-heal interval past the fired key, a pure function of
 * (desired, fired key) so engines still agree on the key.
 */
export function fireAtAfterFired(desiredFireAt: number, firedAt: number): number {
  return desiredFireAt > firedAt ? desiredFireAt : firedAt + TEARDOWN_SELF_HEAL_DELAY_MS;
}

/**
 * Build the operations that arm a `wf-teardown:` timer. This is the ONLY place a teardown
 * timer is built for a write, and `firedAt` is required, so a callback-originated write cannot
 * omit the fired key: the timer lands at `desiredFireAt`, or strictly after `firedAt` when
 * `desiredFireAt` would not be (see {@link fireAtAfterFired}). Pass {@link OUTSIDE_FIRED_TIMER}
 * only outside a fired-timer callback.
 */
export function teardownTimerOperations(
  token: string,
  workflowId: string,
  desiredFireAt: number,
  firedAt: number,
): BatchOperation[] {
  return buildTimerBatchOperations({
    id: createTeardownTimerId(token),
    workflowId,
    fireAt: fireAtAfterFired(desiredFireAt, firedAt),
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
 * The next self-heal slot at least a full `delayMs` after `now`: the first multiple of
 * `delayMs` at or past `now + delayMs`. Quantizing the fire time makes a re-arm IDEMPOTENT
 * across engines. A timer key embeds `fireAt`, so engines that each re-arm at
 * `getNow() + delay` write distinct keys for one logical self-heal and multiply the timers
 * every interval; engines that quantize land on the same key. Starting from `now + delayMs`
 * (not `now`) keeps the delay contract: a re-arm made 1ms before a slot boundary waits the
 * next full slot rather than firing a millisecond later.
 */
function nextSelfHealSlot(now: number, delayMs: number): number {
  return Math.ceil((now + delayMs) / delayMs) * delayMs;
}

/**
 * Write a `wf-teardown:` timer for `token` at exactly `fireAt`, engine-scoped (`null`), never
 * fenced on the workflow's claim: this write only arms a timer — a scheduling hint that cannot
 * change the marker or any workflow state. A stale or zombie timer is harmless: the drive
 * re-validates the marker's token and bytes on every fire. Best-effort: a deposed engine that
 * loses the fence simply yields to the new owner, whose own timer drives it.
 */
async function writeTeardownTimer(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  desiredFireAt: number,
  firedAt: number,
): Promise<void> {
  try {
    await commitFencedEngineWrite(
      internals,
      null,
      teardownTimerOperations(token, workflowId, desiredFireAt, firedAt),
      [],
      () => new Error('teardown timer re-arm lost the lease fence'),
    );
  } catch {
    // Deposed or lost-race: the current owner re-drives via its own timer.
  }
}

/**
 * Re-arm a future `wf-teardown:` timer for a non-settling drive exit that has NO winner to
 * own the next timer (a missing registration, a failed corrupt-marker clear, or an
 * unexpected error), so the marker is not stranded after the scheduler deletes the fired
 * timer. A lost claim or settle CAS is deliberately NOT such an exit: the CAS winner armed
 * its own timer in the same batch, so a loser stays silent. The marker bytes are left
 * untouched — only the timer is (re)written, at a slot shared by every engine (see
 * {@link nextSelfHealSlot}). `firedAt` is the fired timer's own `fireAt`: the slot is always
 * strictly after it (measured from the later of the clock and `firedAt`), so the post-callback delete
 * of the fired key can never erase the re-arm. Pass {@link OUTSIDE_FIRED_TIMER} only outside a fired-timer callback.
 */
export async function rearmTeardownTimer(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  delayMs: number,
  firedAt: number,
): Promise<void> {
  await writeTeardownTimer(
    internals,
    workflowId,
    token,
    nextSelfHealSlot(Math.max(internals.options.getNow(), firedAt), delayMs),
    firedAt,
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
  return (claim.claimedAt ?? firedAt) + teardownStaleThresholdMs(finalizer);
}

/** Re-arm the watchdog for a live `running` claim this drive yielded to (see above). */
export async function rearmLiveClaimWatchdog(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  watchdogFireAt: number,
  firedAt: number,
): Promise<void> {
  await writeTeardownTimer(internals, workflowId, token, watchdogFireAt, firedAt);
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
      null,
      [{ type: 'delete', key: KEYS.teardownOwed(workflowId) }],
      [{ key: KEYS.teardownOwed(workflowId), expectedValue: expectedBytes }],
    );
  } catch {
    // Deposed: leave the marker; the current owner re-drives it.
    return false;
  }
}

/**
 * A claim on the marker: the exact bytes a settle must still find (`bytes`) and the
 * operations that remove the watchdog timer the claim armed (`watchdogCleanup`; empty for a
 * marker this drive did not claim). A settle appends the cleanup so a finished attempt leaves
 * no timer behind.
 */
export interface TeardownHold {
  bytes: Uint8Array;
  watchdogCleanup: BatchOperation[];
}

/** The hold for a marker this drive read but did not claim (`owed` bytes, no watchdog). */
export function observedMarkerHold(bytes: Uint8Array): TeardownHold {
  return { bytes, watchdogCleanup: [] };
}

/** A fresh claim token: ties a marker to the one timer allowed to drive it. */
export function newTeardownToken(): string {
  return crypto.randomUUID();
}

/**
 * Atomically claim the marker: CAS `owed → running` (or reclaim a stale `running`) only if
 * it is byte-for-byte the `expectedBytes` we read, so concurrent claimers cannot both win.
 * The SAME batch arms a watchdog timer at `claimedAt` plus the stale-running horizon: a
 * winner that dies mid-finalizer is then reclaimed by the watchdog, and a loser never needs
 * a timer of its own; `firedAt` is the fired timer's `fireAt` (see {@link teardownTimerOperations}).
 * Returns the {@link TeardownHold} on success (the settle CAS
 * precondition and the watchdog cleanup), or `null` on a lost CAS.
 */
export async function claimTeardownMarker(
  internals: EngineInternals,
  workflowId: string,
  expectedBytes: Uint8Array,
  attempts: number,
  token: string,
  finalizer: RunnableFinalizer,
  firedAt: number,
): Promise<TeardownHold | null> {
  const claimedAt = internals.options.getNow();
  const runningBytes = encodeRunningClaim(attempts, token, claimedAt);
  // The claim reuses the fired timer's token: a watchdog on the fired key would be erased by
  // the scheduler's post-callback delete.
  const watchdogOperations = teardownTimerOperations(
    token,
    workflowId,
    claimedAt + teardownStaleThresholdMs(finalizer),
    firedAt,
  );
  const claimed = await commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    null,
    [
      { type: 'put', key: KEYS.teardownOwed(workflowId), value: runningBytes },
      ...watchdogOperations,
    ],
    [{ key: KEYS.teardownOwed(workflowId), expectedValue: expectedBytes }],
  );
  if (!claimed) return null;
  return {
    bytes: runningBytes,
    watchdogCleanup: watchdogOperations.map((operation) => ({
      type: 'delete',
      key: operation.key,
    })),
  };
}

/**
 * Commit a settle batch conditioned on the `teardownOwed` marker still equalling the
 * exact bytes of `hold` (Codex MF2), together with removal of the watchdog the claim armed.
 * If a reclaimer overwrote the marker first, the CAS fails and this returns `false` WITHOUT
 * committing — the caller must then skip dispatching any teardown event, and stays silent:
 * the reclaimer armed its own watchdog and owns the next step.
 */
export async function settleOnRunningClaim(
  internals: EngineInternals,
  workflowId: string,
  hold: TeardownHold,
  operations: BatchOperation[],
): Promise<boolean> {
  return commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    null,
    [...operations, ...hold.watchdogCleanup],
    [{ key: KEYS.teardownOwed(workflowId), expectedValue: hold.bytes }],
  );
}

/**
 * Settle a drive whose finalizer attempt was aborted by engine disposal: put the marker back
 * to `owed` at the unchanged `attempts` under a NEW token (so no earlier timer can start the
 * retry) and arm a near-future timer for it. The CAS is the same engine-scoped
 * {@link settleOnRunningClaim} as every other settle, so it needs no per-workflow claim and
 * lands under `workflow-lease` and `none` (both tested). Under global `ownership: 'lease'`
 * disposal may release the lease first, in which case the settle cannot land: the marker stays
 * `running` and the watchdog the claim armed reclaims it once the stale horizon passes. A
 * lost CAS means a reclaimer owns the marker and its watchdog; nothing is re-armed.
 */
export async function reassertOwedAfterShutdown(
  internals: EngineInternals,
  workflowId: string,
  hold: TeardownHold,
  attempts: number,
  firedAt: number,
): Promise<void> {
  const token = newTeardownToken();
  const fireAt = internals.options.getNow() + TEARDOWN_SELF_HEAL_DELAY_MS;
  await settleOnRunningClaim(internals, workflowId, hold, [
    { type: 'put', key: KEYS.teardownOwed(workflowId), value: encodeOwedClaim(attempts, token) },
    ...teardownTimerOperations(token, workflowId, fireAt, firedAt),
  ]);
}

/**
 * Write the durable dead-letter record and clear the teardown + finalizer-state keys,
 * conditioned on the marker still being byte-for-byte `expected.bytes`. Used both at the
 * retry horizon (the `running` hold this drive claimed) and when the recorded resource state
 * vanished before any claim (the `owed` bytes this drive read, via {@link observedMarkerHold}).
 * Conditioning on the expected bytes in BOTH cases prevents a stale drive
 * from dead-lettering after a concurrent drive already settled the marker — which would
 * falsely report a leak after a successful teardown. Returns whether the durable write
 * committed; the caller dispatches the dead-lettered event only when it did.
 */
export async function deadLetterTeardown(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  attempts: number,
  expected: TeardownHold,
  details: { lastError: string; finalizerInput: unknown },
  workflowExecutionToken?: string,
  revision?: string,
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
    ...(revision === undefined ? {} : { revision }),
  };
  const deadLetterBytes = encode(deadLetter);
  return settleOnRunningClaim(internals, workflowId, expected, [
    { type: 'delete', key: KEYS.teardownOwed(workflowId) },
    { type: 'delete', key: KEYS.finalizerState(workflowId) },
    { type: 'put', key: KEYS.teardownDeadLetter(workflowId), value: deadLetterBytes },
    {
      type: 'put',
      key: KEYS.teardownDeadLetterHistory(
        workflowId,
        workflowExecutionToken ?? LEGACY_DEAD_LETTER_HISTORY_TOKEN,
      ),
      value: deadLetterBytes,
    },
  ]);
}
