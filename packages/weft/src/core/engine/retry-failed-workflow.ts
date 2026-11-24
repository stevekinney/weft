import { KEYS } from '../../storage/keys.ts';
import type { RetryFailedWorkflowResult } from '../types.ts';
import { reactivateFailedWorkflowFromCheckpoint } from './bulk-operations-retry.ts';
import type { EngineInternals } from './internals.ts';
import { ReactivationCleanupError } from './reactivation-cleanup-error.ts';
import { loadWorkflowState } from './storage-io.ts';

/** Whether the engine still holds a checkpoint of `workflowId`. */
async function hasCheckpoint(internals: EngineInternals, workflowId: string): Promise<boolean> {
  const bytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  return bytes !== null;
}

/** Why a run cannot be reactivated as it is now, or `undefined` when it is a failed run with a checkpoint. */
async function refusalOf(
  internals: EngineInternals,
  workflowId: string,
): Promise<RetryFailedWorkflowResult | undefined> {
  const state = await loadWorkflowState(internals, workflowId);
  if (state === null) return { workflowId, status: 'not-found' };
  if (state.status !== 'failed') {
    return { workflowId, status: 'not-failed', currentStatus: state.status };
  }
  if (!(await hasCheckpoint(internals, workflowId))) return { workflowId, status: 'no-checkpoint' };
  return undefined;
}

/**
 * `engine.retryFailed(workflowId)`: one failed run reactivated in place from its checkpoint, on
 * the revision it is pinned to, or the reason it was not. Unlike `retryFailedAll` it never falls
 * back to starting the run again from its input: a run with no checkpoint answers `no-checkpoint`
 * and is left failed, because a fresh start would run again every operation the run had already
 * completed. The status and the checkpoint are read again under the per-workflow write lock before
 * the reactivation commits, so a run another caller retried first answers `not-failed`, never a
 * second reactivation. The caller resumes the run once this answers `retried`.
 */
export async function reactivateOneFailedWorkflow(
  internals: EngineInternals,
  workflowId: string,
): Promise<RetryFailedWorkflowResult> {
  const refused = await refusalOf(internals, workflowId);
  if (refused !== undefined) return refused;
  const state = await loadWorkflowState(internals, workflowId);
  if (state === null) return { workflowId, status: 'not-found' };
  try {
    await reactivateFailedWorkflowFromCheckpoint(internals, state);
  } catch (error) {
    // The reactivation committed; only its cleanup failed. The run is running again and must be
    // resumed, so this answers `retried` and leaves the timer for the next sweep.
    if (error instanceof ReactivationCleanupError) return { workflowId, status: 'retried' };
    // The re-read under the lock found the run changed since the read above.
    const changed = await refusalOf(internals, workflowId);
    if (changed !== undefined) return changed;
    throw error;
  }
  return { workflowId, status: 'retried' };
}
