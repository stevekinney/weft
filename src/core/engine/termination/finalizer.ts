/**
 * The engine-side finalizer drive (`runWorkflowFinalizer`) for issue #446 Phase 2.
 * Dispatched by the scheduler when a `wf-teardown:` timer fires, it drives a
 * workflow's definition-level `finalizer` to durable completion after a
 * `cancelled`/`timed-out` terminal — claiming the durable teardown marker, running
 * the finalizer activity (via {@link runFinalizerActivity}), and then clearing,
 * backing off, or dead-lettering based on the outcome. The byte-level claim mechanics
 * (CAS, settle, re-arm, dead-letter, the stale horizon and backoff) live in
 * `./finalizer-claim.ts`; this module is the orchestration that decides which to call.
 *
 * Concurrency model — a single durable, TIME-based claim:
 * the durable `teardownOwed` marker carries a `{ status, attempts, token, claimedAt }`
 * claim ({@link TeardownClaim}). A holder fenced-CAS's `owed → running` (stamping
 * `claimedAt`) before running, and settle-CAS's the exact `running` bytes it wrote when
 * clearing or rescheduling — so a concurrent reclaimer can never clobber a fresher
 * claim. Liveness is decided purely by the clock: a `running` claim is reclaimable once
 * `claimedAt` is older than {@link teardownStaleThresholdMs} (the finalizer's per-attempt
 * timeout plus a margin). There is NO in-memory liveness set and NO epoch in the record;
 * crash recovery is an ordinary stale-claim retry driven by the timer that survived the
 * terminal batch. The tradeoff is that a finalizer running past the stale threshold may
 * be re-driven concurrently, which is why workflow finalizers must be idempotent (a
 * contract of the #446 design).
 *
 * Self-heal invariant: every exit that does NOT settle the claim (a lost claim CAS, a
 * presumed-live `running` claim, a shutdown-aborted attempt, or a missing registration)
 * re-arms a future `wf-teardown:` timer before returning, because the scheduler deletes
 * the fired timer once this returns without throwing. A non-settling exit that forgot to
 * re-arm would strand the marker with no timer to re-drive it.
 *
 * @module core/engine/termination/finalizer
 */

import { KEYS } from '../../../storage/interface.ts';
import { decode } from '../../codec.ts';
import { WorkflowTeardownEvent } from '../../events.ts';
import type { WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { isTeardownClaim, parseTeardownTimerId, type TeardownClaim } from '../state-utilities.ts';
import { runFinalizerActivity, type RunnableFinalizer } from './finalizer-activity.ts';
import {
  claimTeardownMarker,
  clearTeardownMarker,
  deadLetterTeardown,
  encodeOwedClaim,
  MAX_TEARDOWN_ATTEMPTS,
  rearmTeardownTimer,
  runningClaimIsStale,
  settleOnRunningClaim,
  TEARDOWN_SELF_HEAL_DELAY_MS,
  teardownBackoffMs,
  teardownStaleThresholdMs,
  teardownTimerOperations,
} from './finalizer-claim.ts';

export { teardownStaleThresholdMs, type TeardownDeadLetterRecord } from './finalizer-claim.ts';

/** The subset of termination callbacks the finalizer drive needs. */
export interface FinalizerDriveCallbacks {
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  dispatchEvent: (event: Event) => void;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
}

const TERMINAL_STATUSES_OWED_TEARDOWN = new Set<WorkflowState['status']>([
  'cancelled',
  'timed-out',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Re-arm a self-heal timer after a settle CAS lost its race (the `running` bytes we wrote
 * were reclaimed by another holder). The scheduler deletes the fired `wf-teardown:` timer
 * once the drive returns, so without this the marker could be stranded with no follow-up
 * timer — violating the self-heal invariant. Symmetric with the lost-CLAIM-CAS re-arm in
 * {@link driveResolvedTeardown}. Idempotent and bounded: a redundant timer just makes the
 * next drive re-read the marker (re-arm on a still-fresh claim, or clear if it's gone), and
 * the dead-letter horizon caps total attempts. (Cursor Bugbot round 4.)
 */
async function rearmOnLostSettle(
  internals: EngineInternals,
  workflowId: string,
  token: string,
): Promise<void> {
  await rearmTeardownTimer(internals, workflowId, token, TEARDOWN_SELF_HEAL_DELAY_MS);
}

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
 * The outcome of resolving a fired teardown timer into actionable drive inputs.
 * `'run'` carries the resolved inputs; `'cleared'` means the marker was deleted or there
 * is nothing left to do (a settle — no re-arm); `'rearm'` means the drive must re-arm its
 * timer before returning (a non-settling exit such as a missing registration or a
 * presumed-live claim) and carries the token to re-arm.
 */
type TeardownResolution =
  | { kind: 'run'; drive: ResolvedTeardownDrive }
  | { kind: 'cleared' }
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
 * stale (re-armed) token; an unavailable definition or a presumed-live `running` claim
 * re-arms; absent finalizer state dead-letters in place.
 */
async function resolveTeardownDrive(
  internals: EngineInternals,
  workflowId: string,
  token: string,
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

  const registeredFinalizer = internals.registrations.get(state.type)?.finalizer;
  if (registeredFinalizer === undefined) {
    // A node that recovers without this workflow type registered cannot run the
    // finalizer yet — but the resource is still owed. Leave the marker and re-arm so a
    // node that DOES register the type can run it. (Junior MF1 / Codex MF1.)
    return { kind: 'rearm', token };
  }
  // A registration's `finalizer` is stored as `AnyActivityDefinition`, whose `execute`
  // is typed `ActivityFunction<never>` (input contravariantly `never`). That
  // under-describes what `activity()` produced — a named, callable activity with an
  // optional `timeout` — so we narrow it to the structural `RunnableFinalizer` the
  // drive relies on. Trusted by construction: only `activity()` populates this field.
  const finalizer = registeredFinalizer as RunnableFinalizer;

  if (!runningClaimIsStale(internals, claim, finalizer)) {
    return { kind: 'rearm', token }; // a genuine live sibling drive owns it — back off and self-heal.
  }

  const finalizerStateBytes = await internals.storage.get(KEYS.finalizerState(workflowId));
  if (finalizerStateBytes === null) {
    // The recorded resource state is gone (a concurrent drive may have already settled
    // it), so dead-letter conditioned on the bytes we read — a lost CAS means a winner
    // already cleared the marker, so we stay silent. (Codex round-2 MF2.)
    await deadLetterMissingState(
      internals,
      workflowId,
      state.type,
      claim.attempts,
      markerBytes,
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
 * The recorded resource state is gone, so the finalizer can never run with its input —
 * dead-letter rather than silently clearing (which would falsely report "torn down").
 * The input is unrecoverable, so the record omits it. Conditioned on `expectedBytes` (the
 * marker bytes this drive read) so a concurrent drive that already settled the teardown
 * isn't overwritten with a false leak record; the dead-lettered event fires only when the
 * durable write commits. (Junior MF1 / Codex MF1; Codex round-2 MF2.)
 */
async function deadLetterMissingState(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  attempts: number,
  expectedBytes: Uint8Array,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const lastError = 'finalizer state missing — recorded resource cannot be torn down';
  const settled = await deadLetterTeardown(
    internals,
    workflowId,
    workflowType,
    attempts,
    expectedBytes,
    {
      lastError,
      finalizerInput: undefined,
    },
  );
  if (settled) {
    // The event's `error` is present for every 'failed'/'dead-lettered' status (the
    // documented contract). Carry the same reason the dead-letter record stores so the
    // event stream is consistent with the attempt-exhausted dead-letter path.
    callbacks.dispatchEvent(
      new WorkflowTeardownEvent(workflowId, workflowType, 'dead-lettered', attempts, lastError),
    );
  }
}

/**
 * Drive one teardown attempt for a workflow whose `wf-teardown:` timer just fired.
 * Never throws: the scheduler treats a thrown timer callback as "retry on the next
 * tick", which would defeat the backoff schedule, so every failure path is handled
 * internally and the function returns normally (letting the scheduler delete the
 * fired timer; a backoff/self-heal reschedule writes a fresh timer entry).
 */
export async function runWorkflowFinalizer(
  internals: EngineInternals,
  workflowId: string,
  timerId: string,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  // Parse the token OUTSIDE the try so the catch can re-arm a self-heal timer: an
  // unexpected error after the marker was observed but before a settle/re-arm would
  // otherwise leave the marker stranded (the scheduler deletes the fired timer on a
  // non-throwing return). `parseTeardownTimerId` is pure and never throws.
  const token = parseTeardownTimerId(timerId);
  if (token === null) {
    return; // malformed timer id — nothing to drive.
  }

  try {
    const resolution = await resolveTeardownDrive(internals, workflowId, token, callbacks);
    if (resolution.kind === 'cleared') {
      return;
    }
    if (resolution.kind === 'rearm') {
      await rearmTeardownTimer(
        internals,
        workflowId,
        resolution.token,
        TEARDOWN_SELF_HEAL_DELAY_MS,
      );
      return;
    }
    await driveResolvedTeardown(internals, workflowId, token, resolution.drive, callbacks);
  } catch (error) {
    // Never propagate — a thrown timer callback re-fires with no backoff. Re-arm a
    // self-heal timer first so an error mid-drive (after the marker was read, before a
    // settle) does not strand the marker with no future timer. (Codex round-2 MF3.)
    await rearmTeardownTimer(internals, workflowId, token, TEARDOWN_SELF_HEAL_DELAY_MS);
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
): Promise<void> {
  const { state, claim, markerBytes, finalizer, finalizerInput } = drive;
  const attempt = claim.attempts + 1;

  // Reclaim/claim CAS, fenced on the lease epoch. A lost CAS means another holder
  // claimed it — back off and self-heal so the marker is never stranded.
  const runningBytes = await claimTeardownMarker(
    internals,
    workflowId,
    markerBytes,
    claim.attempts,
    token,
  );
  if (runningBytes === null) {
    await rearmTeardownTimer(internals, workflowId, token, TEARDOWN_SELF_HEAL_DELAY_MS);
    return;
  }

  const result = await runFinalizerActivity(
    finalizer,
    finalizerInput,
    attempt,
    internals.abortController.signal,
  );

  if (result.ok) {
    await settleTeardownSuccess(
      internals,
      workflowId,
      state.type,
      token,
      attempt,
      runningBytes,
      callbacks,
    );
    return;
  }
  if (result.abortedByShutdown) {
    // A clean engine disposal aborted the attempt — NOT a finalizer failure. Re-assert
    // `owed` at the UNCHANGED attempt count (settle-CAS'd on our running bytes) and re-arm
    // a near-future timer, so the next owner retries from the same count and the resource
    // is never dead-lettered just because the engine was disposed. (Codex MF4 / junior MF2.)
    // A lost settle CAS means a reclaimer took the running bytes — re-arm so the marker is
    // never stranded after the scheduler deletes the fired timer. (Cursor Bugbot round 4.)
    const fireAt = internals.options.getNow() + TEARDOWN_SELF_HEAL_DELAY_MS;
    const settled = await settleOnRunningClaim(internals, workflowId, runningBytes, [
      {
        type: 'put',
        key: KEYS.teardownOwed(workflowId),
        value: encodeOwedClaim(claim.attempts, token),
      },
      ...teardownTimerOperations(token, workflowId, fireAt),
    ]);
    if (!settled) {
      await rearmOnLostSettle(internals, workflowId, token);
    }
    return;
  }
  await settleTeardownFailure(
    internals,
    workflowId,
    state,
    attempt,
    token,
    runningBytes,
    result.error,
    callbacks,
  );
}

/**
 * Finalizer succeeded: clear both keys, conditioned on still owning the `running` claim.
 * Emits the completed event only when the settle CAS commits (a lost CAS means a
 * reclaimer took over — stay silent and re-arm so the marker is never stranded).
 */
async function settleTeardownSuccess(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  token: string,
  attempt: number,
  runningBytes: Uint8Array,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const settled = await settleOnRunningClaim(internals, workflowId, runningBytes, [
    { type: 'delete', key: KEYS.teardownOwed(workflowId) },
    { type: 'delete', key: KEYS.finalizerState(workflowId) },
  ]);
  if (!settled) {
    await rearmOnLostSettle(internals, workflowId, token);
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
  token: string,
  runningBytes: Uint8Array,
  error: unknown,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const message = errorMessage(error);
  if (attempt >= MAX_TEARDOWN_ATTEMPTS) {
    const finalizerStateBytes = await internals.storage.get(KEYS.finalizerState(workflowId));
    const settled = await deadLetterTeardown(
      internals,
      workflowId,
      state.type,
      attempt,
      runningBytes,
      {
        lastError: message,
        finalizerInput: finalizerStateBytes === null ? undefined : decode(finalizerStateBytes),
      },
    );
    // A lost settle CAS means a reclaimer took the running bytes (it will settle/re-arm).
    // Re-arm anyway so the marker is never stranded after the fired timer is deleted —
    // symmetric with the lost-CLAIM-CAS re-arm. (Cursor Bugbot round 4.)
    if (!settled) {
      await rearmOnLostSettle(internals, workflowId, token);
      return;
    }
    callbacks.dispatchEvent(
      new WorkflowTeardownEvent(workflowId, state.type, 'dead-lettered', attempt, message),
    );
    return;
  }

  // Persist the incremented attempt back as `owed`, then reschedule the timer at the
  // backoff deadline — conditioned on still owning the `running` claim we wrote.
  const fireAt = internals.options.getNow() + teardownBackoffMs(attempt);
  const settled = await settleOnRunningClaim(internals, workflowId, runningBytes, [
    { type: 'put', key: KEYS.teardownOwed(workflowId), value: encodeOwedClaim(attempt, token) },
    ...teardownTimerOperations(token, workflowId, fireAt),
  ]);
  if (!settled) {
    await rearmOnLostSettle(internals, workflowId, token);
    return;
  }
  callbacks.dispatchEvent(
    new WorkflowTeardownEvent(workflowId, state.type, 'failed', attempt, message),
  );
}
