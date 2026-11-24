/**
 * Every exit from a terminal message ends the run's waiter, and every exit from a failed write ends
 * only the run that issued the write.
 *
 * A `completed` or `failed` message from the strategy ends in the engine's terminal write. The write
 * can end in a committed record, a refusal, a record another writer changed, or an error nobody
 * classified, and the strategy contains whatever the handler throws, so an exit that settles nothing
 * leaves the run `running` with `result()` pending until the next boot. This module is the one place
 * that closes that class: whatever the terminal write did, the run's waiter ends here.
 *
 * Every exit here takes the run as captured before the message was dispatched (a
 * {@link TerminatedRun}), never the run current when the error arrived: a write is retried for
 * most of a second, and a cancel followed by a `start-new` replacement, or a relaunch of the same
 * generation, can install another run under the id meanwhile. Each write, release or rejection an
 * exit makes is gated on this engine still holding the captured run's own execution attempt
 * ({@link engineHoldsRun}), checked in the same synchronous turn as the action, so an exit cannot
 * end, fail or abandon a run other than the one whose write failed.
 *
 * @module core/engine/terminal-run-exit
 */
import type { WorkerOutboundMessage } from '../types.ts';
import type { RefusedStorageWrite } from './checkpoint-commit-failed-error.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { abandonWorkflowAfterCheckpointConflict } from './checkpoint-conflict-abandon.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { CheckpointEncodingError } from './checkpoint-encoding-error.ts';
import { EngineDisposedError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { failWorkflow, type TerminationCallbacks } from './termination.ts';
import {
  engineHoldsRun,
  settleRunFromStoredRecord,
  type TerminatedRun,
  waiterForRun,
} from './termination/settle-refused-terminal.ts';

/** What the terminal path needs of the engine's callbacks. */
type TerminationSource = { readonly createTerminationCallbacks: () => TerminationCallbacks };

/** The terminal write a message ends in, or `undefined` for a message that is not terminal. */
export function terminalWriteOf(
  message: WorkerOutboundMessage,
): Extract<RefusedStorageWrite, 'completion' | 'failure'> | undefined {
  if (message.type === 'completed') return 'completion';
  return message.type === 'failed' ? 'failure' : undefined;
}

/** Whether `error` says the engine itself stopped, which no terminal path may write through. */
export function isEngineStopped(error: unknown): boolean {
  return error instanceof EngineDisposedError || error instanceof EngineDeposedError;
}

/**
 * A terminal message returned without an error. `run` is the run as captured before the message
 * was handled, since the terminal commit releases what identifies it. When its waiter is still
 * registered, the write did not settle it (the record was already terminal, or another writer ended
 * the run), so settle it from the stored record. A record that is still `running` is left alone:
 * the run's own transition, or the writer that holds it, ends it.
 */
export async function settleUnsettledTerminalMessage(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationSource,
  run: TerminatedRun,
): Promise<void> {
  await settleRunFromStoredRecord(
    internals,
    workflowId,
    callbacks.createTerminationCallbacks(),
    run,
  );
}

/**
 * Whether `run`'s result waiter is still registered, which a settled run's is not. Synchronous, so
 * the completion path, whose waiter is settled and gone by now, pays no promise turn to ask.
 */
export function isTerminalWaiterPending(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): boolean {
  const waiter = waiterForRun(internals, workflowId, run);
  return waiter !== undefined && internals.resultResolvers.get(workflowId) === waiter;
}

/**
 * Whether the engine already let go of `run`'s attempt, which only happens once the run was ended
 * or launched again: its own terminal commit released it (the error came after the commit, from the
 * events or the cleanup that follow it), a cancel ended it, a `start-new` replacement took the id,
 * or the same generation was launched again after a suspend. Whatever did so settled or carries the
 * run's waiter, and whatever the engine holds for the id now is another run's, so nothing is left
 * for this exit to settle, release or write. A run captured with no attempt was never held and is
 * judged by the stored record instead.
 */
function engineLetGoOfRun(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): boolean {
  return run.attempt !== undefined && !engineHoldsRun(internals, workflowId, run);
}

/**
 * Whether failing `run` left it unfinished on this engine, so it must be settled from the stored
 * record: a waiter is still pending, or the engine still holds the run's execution attempt because
 * failing it found the record already ended by another writer and wrote nothing. When failing it
 * wrote, its own teardown released the run and announced the outcome, and neither holds, so the
 * outcome is never announced twice.
 */
function failingLeftRunUnfinished(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): boolean {
  return (
    isTerminalWaiterPending(internals, workflowId, run) ||
    engineHoldsRun(internals, workflowId, run)
  );
}

/** The error a run ends with when a write failed: the typed error itself, or one wrapping `cause`. */
function commitFailureOf(
  workflowId: string,
  write: RefusedStorageWrite,
  cause: unknown,
  run: TerminatedRun,
): CheckpointCommitFailedError {
  return cause instanceof CheckpointCommitFailedError
    ? cause
    : new CheckpointCommitFailedError(workflowId, {
        write,
        cause,
        workflowExecutionToken: run.workflowExecutionToken,
      });
}

/**
 * Stop driving the generation and reject its waiter with `failure`: nothing durable can be written,
 * so the record stays `running` and the next boot recovers the run from its last committed
 * checkpoint. The generation is abandoned only while the engine still holds `run`'s own attempt:
 * the abandonment marks whatever attempt the engine holds for the id, and a later launch under it
 * (a replacement, or the same generation launched again, which shares the run's token) is healthy
 * and not this exit's to stop. A waiter the abandonment did not reach (the engine holds no attempt
 * for the run) is rejected directly, so no exit leaves it pending.
 */
function abandonRun(
  internals: EngineInternals,
  workflowId: string,
  failure: CheckpointCommitFailedError,
  run: TerminatedRun,
): void {
  if (engineHoldsRun(internals, workflowId, run)) {
    abandonWorkflowAfterCheckpointConflict(internals, failure);
  }
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter !== undefined && waiter === waiterForRun(internals, workflowId, run)) {
    internals.resultResolvers.delete(workflowId);
    waiter.reject(failure);
  }
}

/**
 * End `run`, whose terminal write, or whose checkpoint, failed with `error`, in this order:
 *
 * 1. The engine may already have let go of the run (its own write landed, a cancel ended it, or
 *    the id was launched again): then nothing is left to do.
 * 2. The stored record may already have ended the run (its own write landed, or another writer
 *    ended it): settle the waiter from it and release what the run held.
 * 3. Otherwise fail the run as a `system` failure with `failWith`, unless the failure write is what
 *    failed. The failure write retries and re-decides on its own; once it returns, a waiter still
 *    pending is settled from the record.
 * 4. If even that cannot be written, abandon the generation locally and reject the waiter.
 *
 * `run` is the run as captured before the message that issued the write was dispatched, and every
 * step is gated on the engine still holding its attempt, in the same turn as the step: the record
 * read in step 2 is a window in which the id can be cancelled, replaced or launched again, and a
 * failure written after that would end the run that holds the id now. `failWorkflow` captures its
 * own stale-attempt guard before its first await, so a check made just before calling it leaves no
 * gap. `failWith` is the error the run fails with when it is not the typed commit failure, such as a
 * checkpoint that cannot be encoded. An engine that stopped (disposed, deposed) is never written
 * through: its error is rethrown.
 */
export async function endRunAfterFailedWrite(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationSource,
  error: unknown,
  write: RefusedStorageWrite,
  run: TerminatedRun,
  failWith?: Error,
): Promise<void> {
  if (engineLetGoOfRun(internals, workflowId, run)) return;
  const termination = callbacks.createTerminationCallbacks();
  const recorded = await settleRunFromStoredRecord(internals, workflowId, termination, run);
  if (recorded === 'settled' || recorded === 'replaced') return;
  if (engineLetGoOfRun(internals, workflowId, run)) return;
  const failure = commitFailureOf(workflowId, write, error, run);
  if (write === 'failure') return abandonRun(internals, workflowId, failure, run);
  try {
    await failWorkflow(internals, workflowId, failWith ?? failure, termination, 'system');
    if (failingLeftRunUnfinished(internals, workflowId, run)) {
      await settleRunFromStoredRecord(internals, workflowId, termination, run);
    }
  } catch (failureError) {
    if (isEngineStopped(failureError)) throw failureError;
    abandonRun(
      internals,
      workflowId,
      commitFailureOf(workflowId, 'failure', failureError, run),
      run,
    );
  }
}

/** Whether an error out of a checkpoint turn ends the run: an unencodable or uncommittable one. */
function endsRunOnCheckpointError(error: unknown): boolean {
  return error instanceof CheckpointEncodingError || error instanceof CheckpointCommitFailedError;
}

/**
 * What `handleStrategyMessage` does with an error its message handler threw:
 *
 * - A checkpoint commit that lost its compare-and-swap race means another engine over the same
 *   store already advanced this workflow and owns its durable state. `commitCheckpoint` already
 *   abandoned the run where it detected the loss, so all that is left is to write nothing: failing
 *   the workflow here would overwrite the winner.
 * - An engine that stopped is rethrown.
 * - A checkpoint turn's error that is neither unencodable nor uncommittable is rethrown too: it is
 *   the strategy's to report, and this module ends only the runs the storage could not carry.
 * - Anything else ends the run (`endRunAfterFailedWrite`). An error nobody classified out of a
 *   terminal message is still the strategy's to report, so it is rethrown after the run has ended.
 */
export async function endRunAfterStrategyError(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationSource,
  error: unknown,
  terminalWrite: Extract<RefusedStorageWrite, 'completion' | 'failure'> | undefined,
  run: TerminatedRun,
): Promise<void> {
  if (error instanceof WorkflowCheckpointConflictError) return;
  if (isEngineStopped(error)) throw error;
  if (terminalWrite === undefined && !endsRunOnCheckpointError(error)) throw error;
  await endRunAfterFailedWrite(
    internals,
    workflowId,
    callbacks,
    error,
    terminalWrite ?? 'checkpoint',
    run,
    error instanceof CheckpointEncodingError ? error : undefined,
  );
  if (!endsRunOnCheckpointError(error)) throw error;
}
