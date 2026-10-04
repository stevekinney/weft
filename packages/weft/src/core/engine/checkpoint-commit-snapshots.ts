import type { Checkpoint } from '../types.ts';
import {
  beginExecutionAttempt,
  currentExecutionAttempt,
  retireAllExecutionAttempts,
  retireExecutionAttempt,
} from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';

const committedCheckpointBytes = new WeakMap<EngineInternals, Map<string, Uint8Array>>();

export function rememberCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
  serialized: Uint8Array,
): void {
  let bytesByWorkflowId = committedCheckpointBytes.get(internals);
  if (!bytesByWorkflowId) {
    bytesByWorkflowId = new Map();
    committedCheckpointBytes.set(internals, bytesByWorkflowId);
  }
  bytesByWorkflowId.set(workflowId, new Uint8Array(serialized));
}

export function getCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): Uint8Array | undefined {
  const committedBytes = committedCheckpointBytes.get(internals)?.get(workflowId);
  return committedBytes ? new Uint8Array(committedBytes) : undefined;
}

/**
 * Forget the committed checkpoint bytes of a workflow: the compare-and-swap baseline the
 * engine holds for its next checkpoint commit. Leaves the checkpoint and the execution attempt
 * alone; {@link releaseLaunchCheckpoint} is what lets a run go.
 */
export function forgetCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): void {
  committedCheckpointBytes.get(internals)?.delete(workflowId);
}

/**
 * Install `checkpoint` as the in-memory checkpoint of a workflow this engine is
 * launching (start, resume, fork, delayed-start fire) and begin the execution attempt that
 * holds its generation (`execution-attempts.ts`). Beginning an attempt ends the previous one,
 * so an earlier loss of this generation no longer applies to it: the engine drives it again,
 * and work still in flight from the earlier attempt is recognized as stale by its attempt.
 * With `serialized`, also primes the checkpoint-bytes compare-and-swap baseline from those
 * committed bytes. A disposed engine adopts nothing: a launch that was already in flight when
 * the engine was disposed finds no checkpoint to hold and no attempt to begin, so disposal leaves
 * nothing behind that a late loss could abandon.
 *
 * This and the three release functions below are the only places that install or remove a held
 * checkpoint, so a checkpoint, its committed bytes, and its attempt come and go together
 * (`execution-attempts.test.ts` enforces it). `checkpoint-io.ts` only replaces the checkpoint
 * object of the generation that is already held, after each commit.
 */
export function adoptLaunchCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  checkpoint: Checkpoint,
  serialized?: Uint8Array,
): void {
  if (internals.disposed) return;
  internals.checkpoints.set(workflowId, checkpoint);
  beginExecutionAttempt(internals, workflowId, checkpoint.workflowExecutionToken);
  if (serialized !== undefined) rememberCommittedCheckpointBytes(internals, workflowId, serialized);
}

/**
 * Let a run go for good: drop its in-memory checkpoint, its committed bytes, and the execution
 * attempt that held its generation. Called wherever the engine stops holding the run: terminal
 * cleanup (completion, failure, cancellation, timeout), purge and retention collection, and the
 * rollback of a start or fork that adopted a checkpoint and did not launch. A launch rejected
 * before it adopted a checkpoint must not call it, because the attempt under that id is a live
 * run's.
 */
export function releaseLaunchCheckpoint(internals: EngineInternals, workflowId: string): void {
  internals.checkpoints.delete(workflowId);
  forgetCommittedCheckpointBytes(internals, workflowId);
  retireExecutionAttempt(internals, workflowId);
}

/**
 * Release the in-memory checkpoint of a workflow this engine suspends. The execution attempt
 * stays when it launched the generation being suspended, `suspendedGenerationToken` (none for a
 * pre-token run): it is then the only thing left that says which generation this engine drove,
 * so a checkpoint commit still in flight from before the suspend that loses its
 * compare-and-swap, a `result()` requested afterwards, and a timer for the suspended run are
 * all judged by it. Resuming the workflow begins a new attempt.
 *
 * `suspend()` is an external operation, so the run it suspends can be a replacement another
 * engine installed under the id while this engine still holds the attempt that launched the
 * replaced generation. That attempt describes a generation that is not the suspended run's, so
 * it is retired with its checkpoint, as a run this engine lets go of for good: kept, a late
 * loss of the replaced generation would mark it abandoned and reject a fresh `result()` for a
 * run it never drove.
 */
export function releaseSuspendedCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  suspendedGenerationToken: string | undefined,
): void {
  const attempt = currentExecutionAttempt(internals, workflowId);
  if (attempt !== undefined && attempt.workflowExecutionToken !== suspendedGenerationToken) {
    releaseLaunchCheckpoint(internals, workflowId);
    return;
  }
  internals.checkpoints.delete(workflowId);
}

/** Release every checkpoint and every execution attempt; called when the engine is disposed. */
export function releaseAllCheckpoints(internals: EngineInternals): void {
  internals.checkpoints.clear();
  retireAllExecutionAttempts(internals);
}
