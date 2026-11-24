/**
 * What this engine holds in memory for a workflow's execution, read from the things that own it.
 *
 * An inline start is queued and launched by `inline-launch-queue.ts`, which records its progress
 * here as one record per start ({@link PendingLaunch}), the only state kept for a queued or
 * launching start; what used to be two membership indexes on `EngineInternals` is derived from the
 * record's existence and phase. A reclaim that meets a run whose launch is
 * queued or in flight under the claim it holds neither counts it as driven nor drives it a second
 * time, nor waits for it: it leaves the run to the flush (`defersToQueuedInlineWorkflowStart`).
 *
 * A run is *live* when the strategy that executes it holds it: for the inline strategy a context,
 * a turn still being handled, or the parked marker of a run waiting for a signal; for a worker
 * strategy, whose worker is acquired asynchronously, the in-memory checkpoint the engine holds for
 * the run from adoption until terminal cleanup, suspension, or disposal releases it. These are the
 * same terms `recoverAll()`'s preflight reads as local ownership (`isInlineWorkflowLocallyOwned`,
 * `hasLocalCheckpointOwnership`), without the queued launch, which is deferred to rather than live.
 *
 * This module imports nothing but the internals type, so the resume path can read it without a
 * cycle through the lifecycle barrel.
 */
import type { EngineInternals } from './internals.ts';

/**
 * What one start recorded about itself while it is queued or launching, and the only state the
 * engine keeps for a start in either phase. `queued` is an inline start waiting for the flush;
 * `launching` is a flush that started, or a delayed or prepared start between its commit and its
 * launch. The record carries the claim epoch the start was enqueued or committed under (`null`
 * under no per-workflow claim). One object per start: every transition takes the record its start
 * made and acts only while that record is still the id's current one, so a start never moves or
 * settles a record a later start of the same id made (COR-1625).
 */
export type PendingLaunch = {
  readonly workflowId: string;
  readonly claimEpoch: number | null;
  readonly phase: 'queued' | 'launching';
};

/** The record as this module holds it: only a transition here moves its phase. */
type PendingLaunchRecord = { -readonly [Key in keyof PendingLaunch]: PendingLaunch[Key] };

/** The current record of each queued or launching start, by workflow id. Held beside the engine. */
const pendingLaunches = new WeakMap<EngineInternals, Map<string, PendingLaunchRecord>>();

function pendingLaunchesOf(internals: EngineInternals): Map<string, PendingLaunchRecord> {
  let launches = pendingLaunches.get(internals);
  if (launches === undefined) {
    launches = new Map();
    pendingLaunches.set(internals, launches);
  }
  return launches;
}

function currentPendingLaunch(
  internals: EngineInternals,
  workflowId: string,
): PendingLaunchRecord | undefined {
  return pendingLaunches.get(internals)?.get(workflowId);
}

/** Whether `launch` is still the current record under its id: the one test every transition makes. */
function isCurrent(internals: EngineInternals, launch: PendingLaunch): boolean {
  return currentPendingLaunch(internals, launch.workflowId) === launch;
}

function recordPendingLaunch(
  internals: EngineInternals,
  workflowId: string,
  phase: PendingLaunch['phase'],
): PendingLaunch {
  const launch: PendingLaunchRecord = {
    workflowId,
    claimEpoch: internals.workflowClaimRegistry?.currentEpoch(workflowId) ?? null,
    phase,
  };
  pendingLaunchesOf(internals).set(workflowId, launch);
  return launch;
}

/** Settle `launch`, if it is still the id's current record. */
function settleOwnPendingLaunch(internals: EngineInternals, launch: PendingLaunch): void {
  if (isCurrent(internals, launch)) pendingLaunches.get(internals)?.delete(launch.workflowId);
}

/**
 * An inline start of the workflow is queued under the claim held now; its launch has not run.
 * Returns the record, which the queue entry keeps for its later transitions. A delayed or prepared
 * launch that enqueues records anew here, and that new record replaces its launching one: the
 * hand-over.
 */
export function recordInlineWorkflowStartQueued(
  internals: EngineInternals,
  workflowId: string,
): PendingLaunch {
  return recordPendingLaunch(internals, workflowId, 'queued');
}

/** The queued start's launch is about to start the generator: no longer queued, still launching. */
export function recordInlineWorkflowStartLaunching(
  internals: EngineInternals,
  launch: PendingLaunch,
): void {
  const current = currentPendingLaunch(internals, launch.workflowId);
  if (current === launch) current.phase = 'launching';
}

/** The launch of the queued start is over: it started the generator, skipped the run, was discarded, or threw. */
export function settleInlineWorkflowStart(internals: EngineInternals, launch: PendingLaunch): void {
  settleOwnPendingLaunch(internals, launch);
}

/** Forget every queued or launching start, as a synchronous disposal discards them all. */
export function settleEveryInlineWorkflowStart(internals: EngineInternals): void {
  pendingLaunches.get(internals)?.clear();
}

/**
 * A delayed or prepared start holds the claim it folded or committed under, and is launching: from
 * its `running` commit to its launch it awaits a re-provision and reads, and in that window it is
 * neither queued nor live. The record marks it as launching under that claim, so a reclaim defers
 * to it ({@link defersToQueuedInlineWorkflowStart}) instead of replaying beside it, while
 * `engine.get()` keeps reporting `running`, since only a `queued` record reads as pending. An inline
 * launch hands the record over to the queue (`recordInlineWorkflowStartQueued` records anew under
 * the same id); a worker launch settles it once the worker has its run; a launch that stops short
 * lets the run go ({@link letGoOfPendingLaunch}). Returns what it recorded, which only that launch
 * may hand over or let go of.
 */
export function recordLaunchPending(internals: EngineInternals, workflowId: string): PendingLaunch {
  return recordPendingLaunch(internals, workflowId, 'launching');
}

/**
 * A launch recorded its record before the commit that makes its run visible as `running`, and that
 * commit did not land: the record is settled, through its own record, and nothing else changes. The
 * claim the launch held before the commit is untouched, since the launch never took it; the commit's
 * own failure path reports the loss.
 */
export function settleUncommittedLaunch(internals: EngineInternals, launch: PendingLaunch): void {
  settleOwnPendingLaunch(internals, launch);
}

/**
 * The launching start launched. An inline launch has queued its start, which took the record over
 * under the same id, so the queue now owns it; a worker launch has handed the run to the worker,
 * which never enqueues, so its own record is settled here. A `start-new` replacement that recorded
 * its marker while this launch awaited keeps that marker.
 */
export function handOverPendingLaunch(
  internals: EngineInternals,
  launch: PendingLaunch | undefined,
): void {
  if (launch !== undefined && internals.inlineStrategy === null) {
    settleOwnPendingLaunch(internals, launch);
  }
}

/**
 * Whether `launch` is still the current record, in the launching phase: a queued start's failure is
 * the flush's to handle (`letGoOfFailedQueuedStart`), never this let-go's.
 */
function stillHoldsPendingLaunch(internals: EngineInternals, launch: PendingLaunch): boolean {
  return isCurrent(internals, launch) && launch.phase === 'launching';
}

/**
 * The launching start stopped short of its launch: it threw, or its services were unavailable.
 * Nothing drives the run, and nothing else would while this engine holds and renews the claim it
 * folded, because the reclaim scan excludes held ids and a reclaim that met the marker deferred to
 * it. So the claim the launch recorded is released, best-effort and guarded on that epoch, and then
 * the marker is settled: the run is `running` with no holder, which the next reclaim pass lists as
 * ownerless and drives, on this engine or any other. The marker outlives the release, so a reclaim
 * arriving while the release is in flight still defers rather than redriving a claim that is going
 * away. It acts only on the launch's own record: a launch that set no marker (`undefined`) lets
 * nothing go, and neither does one whose record a later start of the same id has replaced (a
 * `start-new` replacement that landed while the failure settled), whose claim and marker are that
 * start's. A run the launch failed terminally has already released its claim, and the guarded
 * release is then a no-op.
 */
export async function letGoOfPendingLaunch(
  internals: EngineInternals,
  launch: PendingLaunch | undefined,
): Promise<void> {
  if (launch === undefined || !stillHoldsPendingLaunch(internals, launch)) return;
  if (launch.claimEpoch !== null) {
    try {
      await internals.workflowClaimRegistry?.release(launch.workflowId, launch.claimEpoch);
    } catch {
      // Best-effort: a thrown release leaves the claim to expire, which any engine then takes over.
    }
  }
  if (stillHoldsPendingLaunch(internals, launch)) settleOwnPendingLaunch(internals, launch);
}

/**
 * Whether the start was enqueued or committed under a claim this engine no longer holds: the claim
 * was lost and taken back since, so the start's checkpoint may be behind the run's durable one. The
 * flush discards such a start, and a reclaim does not defer to it.
 */
export function isPendingLaunchStale(internals: EngineInternals, launch: PendingLaunch): boolean {
  return (
    launch.claimEpoch !== (internals.workflowClaimRegistry?.currentEpoch(launch.workflowId) ?? null)
  );
}

/**
 * Whether a reclaim should leave the workflow to an inline start of it that is queued or launching
 * under the claim held now. That start is this engine's own drive in the making: its flush drives
 * the run under this claim, so a reclaim that evicted or replayed would drive the generation a
 * second time, and one that waited for the flush would wait on the host under `'manual'` launch
 * scheduling, where only the host flushes. A reclaim that meets one returns and leaves the run to
 * the flush; a flush that throws before its generator exists lets the run go, claim included, so
 * the next pass acquires and drives it. A start enqueued under an earlier claim is stale: the flush
 * will discard it, and the reclaim drives the run itself.
 */
export function defersToQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  const launch = currentPendingLaunch(internals, workflowId);
  return launch !== undefined && !isPendingLaunchStale(internals, launch);
}

/** Whether the inline strategy holds a live execution of the workflow: a context, a turn, or a park. */
export function isInlineWorkflowExecutionLive(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  const inlineStrategy = internals.inlineStrategy;
  return (
    inlineStrategy !== null &&
    (inlineStrategy.getContext(workflowId) !== undefined ||
      inlineStrategy.waitForWorkflowTurn(workflowId) !== undefined ||
      internals.parkedInlineWorkflows.has(workflowId))
  );
}

/**
 * Whether this engine holds a live execution of the workflow: the inline strategy holds it, or, for
 * a worker strategy, the engine holds the run's in-memory checkpoint. A queued or launching inline
 * start is not one, and neither is a run whose launch adopted a checkpoint and then stopped short of
 * the generator, which the inline strategy never received.
 */
export function holdsWorkflowExecution(internals: EngineInternals, workflowId: string): boolean {
  if (internals.inlineStrategy !== null)
    return isInlineWorkflowExecutionLive(internals, workflowId);
  return internals.checkpoints.has(workflowId);
}

/** Whether an inline start of the workflow is queued and its launch has not run: its record is `queued`. */
export function hasQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return currentPendingLaunch(internals, workflowId)?.phase === 'queued';
}

/** Whether a start of the workflow is queued or launching: a record exists. */
export function hasQueuedOrLaunchingInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return currentPendingLaunch(internals, workflowId) !== undefined;
}

function workflowStatusCanRetainLocalOwnership(workflowStatus: string): boolean {
  return workflowStatus === 'running' || workflowStatus === 'pending';
}

/**
 * `recoverAll()`'s and `resume()`'s local-ownership test for an inline run: a queued or launching
 * start, or a live execution, of a run that is still running or pending.
 */
export function isInlineWorkflowLocallyOwned(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  if (!workflowStatusCanRetainLocalOwnership(workflowStatus)) {
    return false;
  }

  return (
    hasQueuedOrLaunchingInlineWorkflowStart(internals, workflowId) ||
    isInlineWorkflowExecutionLive(internals, workflowId)
  );
}

/** The same test from the in-memory checkpoint, which worker-mode runs own by. */
export function hasLocalCheckpointOwnership(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  return (
    internals.checkpoints.has(workflowId) && workflowStatusCanRetainLocalOwnership(workflowStatus)
  );
}
