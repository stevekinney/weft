/**
 * `engine.cancel(workflowId, { dryRun: true })` (COR-2521): what a cancel would do, read from the
 * stored record and nothing else.
 *
 * It cannot reuse `terminateWorkflow`, which acts before it learns the run's state: it marks the
 * run terminalizing, drops a queued start and asks the execution strategy to cancel, all in
 * memory. A preview reads the record and touches none of that.
 *
 * @module core/engine/termination/cancel-preview
 */
import type { CancelWorkflowDryRunResult } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { FORCIBLY_TERMINABLE_STATUSES } from './cleanup.ts';

/**
 * The run's status and whether a cancel would take effect. Throws the same "was not found" error a
 * cancel of an unknown id throws, so a caller maps both to one fault.
 */
export async function previewCancelWorkflow(
  internals: EngineInternals,
  workflowId: string,
): Promise<CancelWorkflowDryRunResult> {
  const state = await loadWorkflowState(internals, workflowId);
  if (state === null) throw new Error(`Workflow "${workflowId}" was not found.`);
  return {
    dryRun: true,
    workflowId,
    status: state.status,
    cancellable: FORCIBLY_TERMINABLE_STATUSES.some((status) => status === state.status),
  };
}
