/**
 * The engine-side finalizer drive (`runWorkflowFinalizer`) for issue #446 Phase 2.
 * Dispatched by the scheduler when a `wf-teardown:` timer fires, it drives a
 * workflow's definition-level `finalizer` to durable completion after a
 * `cancelled`/`timed-out` terminal — claiming the durable teardown marker, running
 * the finalizer activity (via {@link runFinalizerActivity}), and then clearing, backing
 * off, or dead-lettering based on the outcome. The byte-level claim mechanics (CAS,
 * settle, re-arm, dead-letter, stale horizon, backoff) live in `./finalizer-claim.ts`;
 * this module is the orchestration that decides which to call.
 *
 * Concurrency model — the marker's byte-for-byte CAS is the sole arbiter between engines,
 * in every ownership mode. The durable `teardownOwed` marker carries a
 * `{ status, attempts, token, claimedAt }` claim ({@link TeardownClaim}). A holder CAS's
 * `owed → running` (stamping `claimedAt`) before running, and settle-CAS's the exact
 * `running` bytes it wrote when clearing or rescheduling — so a concurrent reclaimer can never
 * clobber a fresher claim. Every marker and timer write is engine-scoped (`workflowId: null`),
 * never fenced on `wf-owner-epoch`: the workflow's claim is already released or rotated away
 * by the terminal that owes the teardown, and no teardown hold ever enters the workflow claim
 * registry (so the reclaim scan cannot take one over). Liveness is decided purely by the
 * clock: a `running` claim is reclaimable once `claimedAt` is older than
 * {@link teardownStaleThresholdMs}, and the claim CAS arms a watchdog timer at exactly that
 * deadline in the same batch. A finalizer running past the stale threshold may be re-driven
 * concurrently, which is why finalizers must be idempotent.
 *
 * Timer ownership: the first timer rides the terminal commit. A drive that wins the claim CAS
 * owns the next timer (the watchdog, or the backoff timer a retry settle writes under a NEW
 * token); a drive that loses a claim or settle CAS stays silent. Only the exits with no
 * winner — a missing registration, a failed corrupt-marker clear, an unexpected error — re-arm
 * a self-heal timer, at a slot every engine shares so concurrent re-arms collapse to one key.
 * A drive that yields to a `running` claim it judges fresh re-arms the watchdog at the claim's
 * `claimedAt` plus its own stale horizon: the fired timer may have been the only liveness the
 * crashed holder had (this engine's horizon or clock can read earlier than the claimer's), and
 * the key is a pure function of the claim, so every engine writes the same one.
 * A timer whose token no longer matches the marker (a leftover watchdog, a stray self-heal) is
 * inert: it resolves to nothing owed.
 *
 * @module core/engine/termination/finalizer
 */

import { KEYS } from '../../../storage/interface.ts';
import { decode } from '../../codec.ts';
import { WorkflowTeardownEvent } from '../../events.ts';
import type { WorkflowState } from '../../types.ts';
import { buildTeardownSuccessOperations } from '../finalizer-status.ts';
import type { EngineInternals } from '../internals.ts';
import { isTeardownClaim, parseTeardownTimerId, type TeardownClaim } from '../state-utilities.ts';
import { runFinalizerActivity, type RunnableFinalizer } from './finalizer-activity.ts';
import {
  claimTeardownMarker,
  clearTeardownMarker,
  deadLetterTeardown,
  encodeOwedClaim,
  liveClaimWatchdogFireAt,
  MAX_TEARDOWN_ATTEMPTS,
  newTeardownToken,
  observedMarkerHold,
  OUTSIDE_FIRED_TIMER,
  rearmLiveClaimWatchdog,
  rearmTeardownTimer,
  reassertOwedAfterShutdown,
  runningClaimIsStale,
  settleOnRunningClaim,
  TEARDOWN_SELF_HEAL_DELAY_MS,
  teardownBackoffMs,
  teardownStaleThresholdMs,
  teardownTimerOperations,
  type TeardownHold,
} from './finalizer-claim.ts';
import { resolveFinalizerRegistration } from './finalizer-registration.ts';

export { teardownStaleThresholdMs, type TeardownDeadLetterRecord } from './finalizer-claim.ts';

/** The subset of termination callbacks the finalizer drive needs. */
export interface FinalizerDriveCallbacks {
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  dispatchEvent: (event: Event) => void;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
}

/** Terminal statuses that owe a definition-level finalizer teardown. */
const TERMINAL_STATUSES_OWED_TEARDOWN = new Set<WorkflowState['status']>([
  'cancelled',
  'timed-out',
]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Clear the marker (conditioned on `markerBytes`) and report the resolution: `'cleared'`
 * when the conditional delete committed, or `'rearm'` when it did not (a deposed-fence throw,
 * or — only under unsupported multi-engine — a concurrent rewrite), so the caller re-arms a
 * self-heal timer instead of stranding the marker after the scheduler deletes the fired one.
 * (Cursor Bugbot round 5.)
 */
async function clearOrRearm(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  markerBytes: Uint8Array,
): Promise<TeardownResolution> {
  const cleared = await clearTeardownMarker(internals, workflowId, markerBytes);
  return cleared ? { kind: 'cleared' } : { kind: 'rearm', token };
}

/**
 * The resolved inputs for a teardown attempt, once every bail-out guard has passed.
 * Produced by {@link resolveTeardownDrive}; consumed by {@link runWorkflowFinalizer}.
 */
interface ResolvedTeardownDrive {
  state: WorkflowState;
  claim: TeardownClaim;
  markerBytes: Uint8Array;
  finalizer: RunnableFinalizer;
  finalizerInput: unknown;
}

/**
 * The outcome of resolving a fired teardown timer into actionable drive inputs. `'run'`
 * carries the resolved inputs; `'cleared'` means nothing is left to do (a settle, no re-arm);
 * `'yield'` means a live sibling holds the marker and carries the watchdog deadline to re-arm;
 * `'rearm'` means no winner owns the next timer (a missing registration, a failed clear), so
 * the drive re-arms a self-heal timer for the carried token.
 */
type TeardownResolution =
  | { kind: 'run'; drive: ResolvedTeardownDrive }
  | { kind: 'cleared' }
  | { kind: 'yield'; watchdogFireAt: number }
  | { kind: 'rearm'; token: string };

/**
 * Outcome of resolving the marker bytes: a valid `claim` to drive, or a non-claim
 * {@link TeardownResolution} (`'cleared'` when a corrupt marker was deleted, `'rearm'` when
 * the conditional delete did not commit) that the caller passes straight through.
 */
type ClaimResolution = { kind: 'claim'; claim: TeardownClaim } | TeardownResolution;

/**
 * Decode the teardown marker bytes into a valid {@link TeardownClaim}, or clear a corrupt
 * marker in place. Corrupt-marker handling is EXHAUSTIVE (Cursor Bugbot round 2 + 3): after
 * a non-null read, a marker is exactly one of —
 * (a) UNDECODABLE bytes → `decode` THROWS → clear;
 * (b) decodes to a non-claim shape → `!isTeardownClaim` → clear;
 * (c) decodes claim-shaped with garbage numbers (NaN/Infinity/negative `attempts`/`claimedAt`)
 *     → `!isTeardownClaim` (tightened guard) → clear;
 * (d)/(e) a valid claim → returned to the caller.
 * Each clear is conditioned on the exact bytes read, so a concurrent re-claim isn't clobbered.
 * If the conditional delete does NOT commit (a deposed-fence throw, or — only under unsupported
 * multi-engine — a concurrent rewrite), {@link clearOrRearm} returns `'rearm'` so the caller
 * re-arms a self-heal timer instead of stranding the marker once the scheduler deletes the
 * fired timer. (Cursor Bugbot round 5: a failed corrupt-marker clear skipped re-arm.)
 */
async function readDriveableClaim(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  markerBytes: Uint8Array,
): Promise<ClaimResolution> {
  let decoded: unknown;
  try {
    decoded = decode(markerBytes);
  } catch {
    return clearOrRearm(internals, workflowId, token, markerBytes); // (a)
  }
  if (!isTeardownClaim(decoded)) {
    return clearOrRearm(internals, workflowId, token, markerBytes); // (b)/(c)
  }
  return { kind: 'claim', claim: decoded };
}

/**
 * Resolve a fired `wf-teardown:` timer into a drive outcome. The marker is cleared for a
 * corrupt marker (see {@link readDriveableClaim}), a vanished/ineligible workflow, or a
 * stale (re-armed) token; a presumed-live `running` claim yields to its holder, whose
 * watchdog owns the next fire; an unavailable definition re-arms; absent finalizer state
 * dead-letters in place.
 */
async function resolveTeardownDrive(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  firedAt: number,
  callbacks: FinalizerDriveCallbacks,
): Promise<TeardownResolution> {
  // Read the marker FIRST so every bail path can condition its clear/dead-letter on the
  // exact bytes it observed — an unconditional mutation here could clobber a concurrent
  // drive (or a same-id rerun) that already re-claimed the marker. (Codex round-2 MF1/2.)
  const markerBytes = await internals.storage.get(KEYS.teardownOwed(workflowId));
  if (markerBytes === null) {
    return { kind: 'cleared' }; // already cleared by a prior successful drive.
  }
  // Resolve the bytes to a valid claim, clearing (or re-arming on a failed clear) any
  // corrupt marker in place. A non-`claim` resolution passes straight through.
  const resolution = await readDriveableClaim(internals, workflowId, token, markerBytes);
  if (resolution.kind !== 'claim') {
    return resolution;
  }
  const claim = resolution.claim;
  if (claim.token !== token) {
    // Stale timer for a re-armed claim; the live claim (different token) owns its own
    // timer. Leave the marker — clearing here would delete a live re-armed claim.
    return { kind: 'cleared' };
  }

  const state = await callbacks.loadWorkflowState(workflowId);
  // The workflow vanished (purged/retained) or is no longer in a teardown-owed terminal
  // state — clear the marker (conditioned on the bytes we read), re-arming if the clear
  // did not commit so the marker isn't stranded. (Cursor Bugbot round 5.)
  if (state === null || !TERMINAL_STATUSES_OWED_TEARDOWN.has(state.status)) {
    return clearOrRearm(internals, workflowId, token, markerBytes);
  }

  // `resolveFinalizerRegistration` already narrows a registration's `finalizer` (stored
  // as `AnyActivityDefinition`, whose `execute` is typed `ActivityFunction<never>`) to
  // the structural `RunnableFinalizer` the drive relies on — trusted by construction,
  // only `activity()` populates this field.
  const finalizer = await resolveFinalizerRegistration(internals, state.type, state.revision);
  if (finalizer === undefined) {
    // Without this type registered the finalizer cannot run yet, but the resource is still
    // owed: leave the marker and re-arm for a node that registers it. (Junior MF1 / Codex MF1.)
    return { kind: 'rearm', token };
  }

  if (!runningClaimIsStale(internals, claim, finalizer)) {
    // A live sibling holds it; its watchdog may be the very timer that just fired (this
    // engine's horizon or clock differs), so hand back the deterministic deadline to re-arm.
    return { kind: 'yield', watchdogFireAt: liveClaimWatchdogFireAt(claim, finalizer, firedAt) };
  }

  const finalizerStateBytes = await internals.storage.get(KEYS.finalizerState(workflowId));
  if (finalizerStateBytes === null) {
    // The recorded resource state is gone, so dead-letter conditioned on the bytes we read; a
    // lost CAS means a winner already cleared the marker. (Codex round-2 MF2.)
    await deadLetterMissingState(
      internals,
      workflowId,
      state,
      claim.attempts,
      observedMarkerHold(markerBytes),
      callbacks,
    );
    return { kind: 'cleared' };
  }

  return {
    kind: 'run',
    drive: { state, claim, markerBytes, finalizer, finalizerInput: decode(finalizerStateBytes) },
  };
}

/**
 * Dead-letter missing finalizer state rather than falsely reporting successful teardown.
 * Condition on the observed marker so a concurrent successful settle cannot be overwritten;
 * emit only after the durable record commits.
 */
async function deadLetterMissingState(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  attempts: number,
  expected: TeardownHold,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const lastError = 'finalizer state missing — recorded resource cannot be torn down';
  const settled = await deadLetterTeardown(
    internals,
    workflowId,
    state.type,
    attempts,
    expected,
    {
      lastError,
      finalizerInput: undefined,
    },
    state.workflowExecutionToken,
    state.revision,
  );
  if (settled) {
    // The event's `error` is present for every 'failed'/'dead-lettered' status (the
    // documented contract). Carry the same reason the dead-letter record stores so the
    // event stream is consistent with the attempt-exhausted dead-letter path.
    callbacks.dispatchEvent(
      new WorkflowTeardownEvent(workflowId, state.type, 'dead-lettered', attempts, lastError),
    );
  }
}

/**
 * Drive one teardown attempt for a workflow whose `wf-teardown:` timer just fired.
 * Never throws: the scheduler treats a thrown timer callback as "retry on the next
 * tick", which would defeat the backoff schedule, so every failure path is handled
 * internally and the function returns normally (the scheduler then deletes the fired timer).
 * `firedAt` is the fired timer's own `fireAt`; every timer written here lands strictly after
 * it (see `teardownTimerOperations`).
 */
export async function runWorkflowFinalizer(
  internals: EngineInternals,
  workflowId: string,
  timerId: string,
  callbacks: FinalizerDriveCallbacks,
  firedAt: number = OUTSIDE_FIRED_TIMER,
): Promise<void> {
  // Parse the token OUTSIDE the try so the catch can re-arm a self-heal timer (the scheduler
  // deletes the fired timer on a non-throwing return). `parseTeardownTimerId` never throws.
  const token = parseTeardownTimerId(timerId);
  if (token === null) {
    return; // malformed timer id — nothing to drive.
  }

  try {
    const resolution = await resolveTeardownDrive(internals, workflowId, token, firedAt, callbacks);
    if (resolution.kind === 'cleared') {
      return;
    }
    if (resolution.kind === 'yield') {
      await rearmLiveClaimWatchdog(
        internals,
        workflowId,
        token,
        resolution.watchdogFireAt,
        firedAt,
      );
      return;
    }
    if (resolution.kind === 'rearm') {
      await rearmTeardownTimer(
        internals,
        workflowId,
        resolution.token,
        TEARDOWN_SELF_HEAL_DELAY_MS,
        firedAt,
      );
      return;
    }
    await driveResolvedTeardown(internals, workflowId, token, resolution.drive, callbacks, firedAt);
  } catch (error) {
    // Never propagate (a thrown callback re-fires with no backoff); re-arm first so an error
    // mid-drive does not strand the marker with no future timer. (Codex round-2 MF3.)
    await rearmTeardownTimer(internals, workflowId, token, TEARDOWN_SELF_HEAL_DELAY_MS, firedAt);
    callbacks.handleCleanupError('runWorkflowFinalizer', error, workflowId);
  }
}

/**
 * Claim the marker, run one finalizer attempt, and settle the outcome. Split from
 * {@link runWorkflowFinalizer} so the latter stays a flat resolve → dispatch shape.
 */
async function driveResolvedTeardown(
  internals: EngineInternals,
  workflowId: string,
  token: string,
  drive: ResolvedTeardownDrive,
  callbacks: FinalizerDriveCallbacks,
  firedAt: number,
): Promise<void> {
  const { state, claim, markerBytes, finalizer, finalizerInput } = drive;
  const attempt = claim.attempts + 1;

  // Claim/reclaim CAS (also arming the watchdog). A lost CAS means another engine claimed
  // it and owns the next timer — stay silent: a loser's re-arm is what multiplied timers.
  const hold = await claimTeardownMarker(
    internals,
    workflowId,
    markerBytes,
    claim.attempts,
    token,
    finalizer,
    firedAt,
  );
  if (hold === null) {
    return;
  }

  const result = await runFinalizerActivity(
    finalizer,
    finalizerInput,
    attempt,
    internals.abortController.signal,
    state.workflowExecutionToken,
  );

  if (result.ok) {
    await settleTeardownSuccess(
      internals,
      workflowId,
      state.type,
      state.workflowExecutionToken,
      attempt,
      hold,
      callbacks,
    );
    return;
  }
  if (result.abortedByShutdown) {
    // A clean engine disposal aborted the attempt, not a finalizer failure: re-assert `owed` at
    // the UNCHANGED attempt count under a new token with a near-future timer, so the resource is
    // never dead-lettered just because the engine was disposed. Under global `'lease'` disposal
    // may release the lease first; the marker then stays `running` and the watchdog reclaims it.
    await reassertOwedAfterShutdown(internals, workflowId, hold, claim.attempts, firedAt);
    return;
  }
  await settleTeardownFailure(
    internals,
    workflowId,
    state,
    attempt,
    hold,
    result.error,
    callbacks,
    firedAt,
  );
}

/**
 * Finalizer succeeded: clear both active keys and write the durable run-qualified outcome,
 * conditioned on still owning the `running` claim. Emit only after commit; a lost CAS means a
 * reclaimer owns the marker and its watchdog, so it stays silent without emitting.
 */
async function settleTeardownSuccess(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  workflowExecutionToken: string | undefined,
  attempt: number,
  hold: TeardownHold,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const operations = buildTeardownSuccessOperations(
    workflowId,
    attempt,
    internals.options.getNow(),
    workflowExecutionToken,
  );
  const settled = await settleOnRunningClaim(internals, workflowId, hold, operations);
  if (!settled) {
    return;
  }
  callbacks.dispatchEvent(
    new WorkflowTeardownEvent(workflowId, workflowType, 'completed', attempt),
  );
}

/** Finalizer attempt failed: back off and reschedule, or dead-letter at the horizon. */
async function settleTeardownFailure(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  attempt: number,
  hold: TeardownHold,
  error: unknown,
  callbacks: FinalizerDriveCallbacks,
  firedAt: number,
): Promise<void> {
  const message = errorMessage(error);
  if (attempt >= MAX_TEARDOWN_ATTEMPTS) {
    const finalizerStateBytes = await internals.storage.get(KEYS.finalizerState(workflowId));
    const settled = await deadLetterTeardown(
      internals,
      workflowId,
      state.type,
      attempt,
      hold,
      {
        lastError: message,
        finalizerInput: finalizerStateBytes === null ? undefined : decode(finalizerStateBytes),
      },
      state.workflowExecutionToken,
      state.revision,
    );
    // A lost settle CAS means a reclaimer took the running bytes; it armed its own watchdog
    // in the same batch and owns the marker, so there is nothing to re-arm.
    if (!settled) {
      return;
    }
    callbacks.dispatchEvent(
      new WorkflowTeardownEvent(workflowId, state.type, 'dead-lettered', attempt, message),
    );
    return;
  }

  // Persist the incremented attempt as `owed` under a NEW token and reschedule at the backoff
  // deadline, conditioned on still owning the `running` claim. The new token keeps the backoff
  // honest: the watchdog and any stray timer carry the old one and resolve to nothing owed.
  const retryToken = newTeardownToken();
  const fireAt = internals.options.getNow() + teardownBackoffMs(attempt);
  const settled = await settleOnRunningClaim(internals, workflowId, hold, [
    {
      type: 'put',
      key: KEYS.teardownOwed(workflowId),
      value: encodeOwedClaim(attempt, retryToken),
    },
    ...teardownTimerOperations(retryToken, workflowId, fireAt, firedAt),
  ]);
  if (!settled) {
    return;
  }
  callbacks.dispatchEvent(
    new WorkflowTeardownEvent(workflowId, state.type, 'failed', attempt, message),
  );
}
