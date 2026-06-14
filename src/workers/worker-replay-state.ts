/**
 * The worker-side replay state: the per-run record of cached step outcomes the worker
 * runner rebuilds from a checkpoint, plus the helpers that create it and fold a resumed
 * operation outcome back into it. Extracted from `workflow-runner.ts` so that module
 * stays under the line cap; the runner imports these back and owns the generator-driving
 * flow that consumes them.
 *
 * @module workers/worker-replay-state
 */

import { createCheckpoint, deserializeCheckpoint } from '../core/checkpoint.ts';
import type { Checkpoint, OperationOutcome, WorkerReplayOperationFailure } from '../core/types.ts';
import type { WorkerReplayOperationSignature } from '../core/worker-protocol.ts';

/** Per-run worker replay state, rebuilt from a checkpoint on every run/recovery. */
export interface WorkerReplayState {
  checkpoint: Checkpoint;
  accumulatedResults: Map<number, unknown>;
  signatures: Map<number, WorkerReplayOperationSignature>;
  failedOutcomes: Map<number, WorkerReplayOperationFailure>;
  nextStepIndex: number;
  pendingStepIndex: number | null;
  maxProtocolMessageBytes: number | undefined;
  // The current turn's id, refreshed on run and each resume. A forwarded `ctx.log`
  // (#529) stamps it so the host can match the log to the active turn. Lives here (not
  // a separate map) so it is cleaned with the rest of the run state on terminal.
  turnId: number | undefined;
}

/** Build a fresh replay state from a `run` message, seeding cached outcomes from the checkpoint. */
export function createReplayState(message: {
  workflowId: string;
  checkpoint?: ArrayBuffer;
  maxProtocolMessageBytes?: number;
  turnId?: number;
}): WorkerReplayState {
  const checkpoint =
    message.checkpoint && message.checkpoint.byteLength > 0
      ? deserializeCheckpoint(new Uint8Array(message.checkpoint))
      : createCheckpoint(message.workflowId, 'worker');
  return {
    checkpoint,
    accumulatedResults: new Map(checkpoint.accumulatedResults),
    signatures: new Map(checkpoint.workerReplaySignatures ?? []),
    failedOutcomes: new Map(checkpoint.workerReplayFailures ?? []),
    nextStepIndex: 0,
    pendingStepIndex: null,
    maxProtocolMessageBytes: message.maxProtocolMessageBytes,
    turnId: message.turnId,
  };
}

/**
 * Fold a resumed operation outcome into the replay state at the pending step: cache a
 * success in `accumulatedResults`, a failure in `failedOutcomes` (mutually exclusive),
 * and advance `nextStepIndex` past it. A no-op when there is no pending step or outcome.
 */
export function recordOperationOutcome(
  replayState: WorkerReplayState,
  outcome: OperationOutcome | undefined,
): void {
  const pendingStepIndex = replayState.pendingStepIndex;
  if (pendingStepIndex === null || !outcome) return;

  if (outcome.status === 'failed') {
    replayState.failedOutcomes.set(pendingStepIndex, outcome);
    replayState.accumulatedResults.delete(pendingStepIndex);
  } else {
    replayState.accumulatedResults.set(pendingStepIndex, outcome.value);
    replayState.failedOutcomes.delete(pendingStepIndex);
  }
  replayState.nextStepIndex = pendingStepIndex + 1;
  replayState.pendingStepIndex = null;
}
