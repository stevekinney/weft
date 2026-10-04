import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';

/**
 * The execution attempt registry: the single answer to "which generation does this engine
 * hold for this workflow id, and has it lost that generation to another engine?".
 *
 * One entry per workflow id, written when the engine launches the id and read by everything
 * that asks about the generation it drives: wakes, timers, `result()`, the terminal failure
 * fence, and the abandonment itself. An entry is an *attempt*: one launch of the id by this
 * engine (a start, resume, recovery, fork, or delayed-start fire that adopts a checkpoint,
 * see `adoptLaunchCheckpoint`). It names the generation it launched by its execution token
 * (none for a run recovered from before tokens existed) and carries the one fact the engine
 * keeps about that generation: whether its checkpoint commit lost a compare-and-swap race to
 * another engine, which makes the generation the winner's and not this engine's to drive.
 *
 * The entry, not `internals.checkpoints`, is what says a generation is held. Suspension,
 * parking, and the checkpoint commits within one launch all replace or release the
 * in-memory checkpoint, so a question answered from it changes its answer as a run moves
 * between states; the entry changes only when this engine launches the id again or lets it
 * go. Nothing may ask whether a generation was lost by looking at whether a checkpoint is
 * present.
 *
 * Lifecycle:
 *
 * - created by `beginExecutionAttempt`, from `adoptLaunchCheckpoint` only, so every launch
 *   installs a checkpoint and its attempt together;
 * - replaced by the next launch of the id. That ends the previous attempt, abandoned or not:
 *   a relaunch of the same generation is a new attempt that is not abandoned, a replacement
 *   generation carries a new token, and work still in flight from the earlier attempt no
 *   longer matches the entry it captured;
 * - flagged abandoned by `abandonExecutionAttempt` when the generation's commit loses a race
 *   and the loss was reported by a persist that began under this same attempt
 *   (`persistCheckpointAbandoningOnConflict` captures the attempt before the persist runs and
 *   refuses a late loss once the engine holds a different one). The flag lives and dies with
 *   the entry, so it can never apply to a later launch, and the check on the reporting persist
 *   is what keeps a late loss of an earlier attempt from reaching a relaunch of the same
 *   generation, which carries the same token;
 * - retired together with the checkpoint it belongs to wherever the engine stops holding a
 *   run for good: terminal cleanup (completion, failure, cancellation, timeout), purge and
 *   retention collection, the rollback of a start or fork that adopted a checkpoint and did
 *   not launch (`releaseLaunchCheckpoint`), and engine disposal
 *   (`retireAllExecutionAttempts`);
 * - kept across a suspension (`releaseSuspendedCheckpoint`) when it launched the generation
 *   being suspended, the one state in which the engine holds a generation and no checkpoint,
 *   until the run is resumed. `suspend()` can suspend a replacement another engine installed
 *   under the id, and the attempt that launched the replaced generation is then retired with
 *   its checkpoint. A launch rejected before it adopted a checkpoint retires nothing, because
 *   the entry under that id is a live run's.
 *
 * Invariants:
 *
 * - a disposed engine holds no entry and records none, so nothing a disposed engine is
 *   later told about a generation (a commit that loses after disposal, say) finds anything
 *   to abandon;
 * - an entry's `abandoned` flag is only ever set while the entry is current and the loss was
 *   reported by work that began under that very entry, and a captured entry that is no longer
 *   current describes work from an attempt this engine has left, whatever token the engine
 *   holds now;
 * - an id that has no entry holds no generation, which is different from a pre-token one:
 *   there is nothing to wake, fail, or reject, so such an id is never abandoned;
 * - a checkpoint commit that completes after its run was released re-sets the in-memory
 *   checkpoint object, exactly as it did before this registry existed. The registry never
 *   reads the checkpoint, so that cannot make a released or disposed run look held.
 *
 * Held beside the engine rather than on `EngineInternals`, like the committed checkpoint
 * bytes in `checkpoint-commit-snapshots.ts`, so an engine carries nothing here until it
 * launches a run and every wake-path check is two map lookups.
 */
export type ExecutionAttempt = {
  /** Token of the generation this attempt launched; `undefined` for a pre-token run. */
  readonly workflowExecutionToken: string | undefined;
  /** This engine lost the generation's checkpoint compare-and-swap race, so it is the winner's. */
  readonly abandoned: boolean;
};

type ExecutionAttemptRecord = {
  readonly workflowExecutionToken: string | undefined;
  abandoned: boolean;
};

const attemptsByEngine = new WeakMap<EngineInternals, Map<string, ExecutionAttemptRecord>>();

/**
 * Start a new attempt for the workflow: the engine just adopted a launch checkpoint for it,
 * of the generation identified by `workflowExecutionToken`. Ends the previous attempt, whose
 * abandonment (if any) ends with it. A disposed engine records nothing.
 */
export function beginExecutionAttempt(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): void {
  if (internals.disposed) return;
  let attempts = attemptsByEngine.get(internals);
  if (attempts === undefined) {
    attempts = new Map();
    attemptsByEngine.set(internals, attempts);
  }
  attempts.set(workflowId, { workflowExecutionToken, abandoned: false });
}

/** Retire the workflow's attempt along with the checkpoint it belonged to. */
export function retireExecutionAttempt(internals: EngineInternals, workflowId: string): void {
  attemptsByEngine.get(internals)?.delete(workflowId);
}

/** Retire every attempt; called when the engine is disposed. */
export function retireAllExecutionAttempts(internals: EngineInternals): void {
  attemptsByEngine.delete(internals);
}

/**
 * The attempt this engine currently holds at the workflow, or `undefined` when it holds
 * none. Unlike the in-memory checkpoint it outlives a suspension, and it is the identity a
 * piece of in-flight work compares itself against: that work belongs to this attempt for as
 * long as the entry it captured is still the one returned here.
 */
export function currentExecutionAttempt(
  internals: EngineInternals,
  workflowId: string,
): ExecutionAttempt | undefined {
  return attemptsByEngine.get(internals)?.get(workflowId);
}

/**
 * Mark the generation this engine holds for the workflow as lost to another engine, when the
 * attempt launched exactly the generation named by `workflowExecutionToken`. Returns whether
 * it newly did: `false` when the engine holds no attempt (the run finished, was purged, or the
 * engine was disposed), the attempt launched a different generation (a replacement installed
 * while the loss was classified is healthy), or the generation was already abandoned.
 *
 * The token names a generation, not an attempt: a relaunch of the same generation carries the
 * same token (or none, for a pre-token run). A loss reported late by a persist therefore has to
 * be matched to its attempt by the caller first, as `persistCheckpointAbandoningOnConflict`
 * does, before this is asked to mark whatever attempt the engine holds now.
 */
export function abandonExecutionAttempt(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): boolean {
  const attempt = attemptsByEngine.get(internals)?.get(workflowId);
  if (
    attempt === undefined ||
    attempt.abandoned ||
    attempt.workflowExecutionToken !== workflowExecutionToken
  ) {
    return false;
  }
  attempt.abandoned = true;
  return true;
}

/**
 * Whether the generation this engine holds for the workflow, running, parked, or suspended,
 * is abandoned. Synchronous, so it is safe on every wake path. An id with no attempt holds no
 * generation, so it is never abandoned: there is nothing to wake.
 */
export function isHeldGenerationAbandoned(internals: EngineInternals, workflowId: string): boolean {
  return attemptsByEngine.get(internals)?.get(workflowId)?.abandoned === true;
}

/**
 * Whether the generation identified by `workflowExecutionToken` (`undefined` for a pre-token
 * run) is the one this engine holds for the workflow and has abandoned.
 */
export function isGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): boolean {
  const attempt = attemptsByEngine.get(internals)?.get(workflowId);
  return (
    attempt !== undefined &&
    attempt.abandoned &&
    attempt.workflowExecutionToken === workflowExecutionToken
  );
}

/** Number of attempts currently flagged abandoned (diagnostics and tests). */
export function abandonedExecutionAttemptCount(internals: EngineInternals): number {
  let abandoned = 0;
  for (const attempt of attemptsByEngine.get(internals)?.values() ?? []) {
    if (attempt.abandoned) abandoned += 1;
  }
  return abandoned;
}

/**
 * Where a terminal failure comes from, which decides what identifies the run it
 * belongs to.
 *
 * - `'execution'`: raised by the run this engine drives, so it belongs to the attempt
 *   the engine holds when the failure begins.
 * - `'launch'`: raised while the engine launches, resumes, or recovers the stored
 *   generation, before it adopts that generation's checkpoint. Whatever the engine
 *   still holds for the id is then an earlier attempt (possibly an abandoned one) that
 *   the failure says nothing about, so only the stored generation identifies it.
 */
export type FailureOrigin = 'execution' | 'launch';

/**
 * Capture which run a terminal failure belongs to and return the `skipCommitIf`
 * predicate that refuses its write once that run is no longer this engine's to fail.
 * Call it synchronously, before the failure's first await.
 *
 * The write is refused when any of these holds at the moment it would commit:
 *
 * - the stored generation is the one this engine holds and has abandoned after losing a
 *   checkpoint compare-and-swap race, so it belongs to the winning engine;
 * - for an `'execution'` failure, the attempt it began under has since been abandoned, which
 *   a replacement stored by another engine does not change;
 * - for an `'execution'` failure, the attempt it began under is no longer the engine's
 *   current one: the id was launched again here, whether as a replacement generation or as
 *   the very same generation relaunched, the run was retired (finished, purged, or its
 *   engine disposed), and a stale failure must never be written over a later run.
 *
 * A `'launch'` failure, or an execution failure that began with no attempt, is judged by
 * the stored generation alone. The abandonment is read as it stands when the predicate
 * runs, so a generation abandoned while the failure was in flight still refuses it.
 */
export function staleFailureGuard(
  internals: EngineInternals,
  workflowId: string,
  origin: FailureOrigin,
): (stored: WorkflowState) => boolean {
  const attempt =
    origin === 'execution' ? currentExecutionAttempt(internals, workflowId) : undefined;
  return (stored) =>
    isGenerationAbandoned(internals, workflowId, stored.workflowExecutionToken) ||
    (attempt !== undefined &&
      (attempt.abandoned || currentExecutionAttempt(internals, workflowId) !== attempt));
}
