/**
 * What the inline launch queue does with a queued launch that threw (COR-1618). Split out of
 * `inline-launch-queue.ts` for that file's size ceiling; it is reached only from the flush's catch.
 *
 * @module core/engine/inline-launch-failure
 */
import { CleanupWarningEvent } from '../events.ts';
import { releaseLaunchCheckpoint } from './checkpoint-commit-snapshots.ts';
import type { QueuedInlineWorkflowExecutionStart } from './engine-internal-types.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { releaseFreshlyAcquiredResumeClaim } from './lifecycle/standalone-claim-acquire.ts';
import { isInlineWorkflowExecutionLive } from './local-execution.ts';

/**
 * A queued launch threw. Report it, and when it threw before it started the generator, let the
 * run go: nothing drives it, and nothing else would, because the engine holds its adopted
 * checkpoint (so `recoverAll()` reads the run as local) and renews the claim its start folded (so
 * the reclaim scan excludes it). Releasing the checkpoint and the attempt undoes what the start
 * installed, as the start's own rollback does for a batch that failed to commit, and releasing the
 * claim leaves the run `running` with no holder, which the reclaim scan lists as ownerless and the
 * next pass acquires and drives, on this engine or any other. The run is not failed: it never ran,
 * its durable state is intact, and a terminal write needs the storage that just failed. A throw
 * after the generator started leaves a live run alone and is only reported. Both releases are
 * guarded on the run still being this start's generation, and the claim release is best-effort,
 * as every claim release on a failure path is.
 */
export async function letGoOfFailedQueuedStart(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  error: unknown,
): Promise<void> {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  internals.engine.dispatchEvent(
    new CleanupWarningEvent('inline-launch', normalizedError, start.workflowId),
  );
  if (isInlineWorkflowExecutionLive(internals, start.workflowId)) return;
  const attempt = currentExecutionAttempt(internals, start.workflowId);
  const holdsThisStartsRun =
    attempt !== undefined && attempt.workflowExecutionToken === start.workflowExecutionToken;
  if (!holdsThisStartsRun) return;
  const claimEpoch = internals.workflowClaimRegistry?.currentEpoch(start.workflowId) ?? null;
  releaseLaunchCheckpoint(internals, start.workflowId);
  if (claimEpoch !== null) {
    await releaseFreshlyAcquiredResumeClaim(internals, start.workflowId, claimEpoch);
  }
}
