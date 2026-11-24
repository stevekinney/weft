/**
 * The runs a bulk operation scanned, and the check a confirmed commit makes before it acts on one.
 * A stable id reused with `onTerminalConflict: 'start-new'` keeps its id and can end in the same
 * status, so the confirmation token names each run by its execution token as well, and a commit
 * acts on an id only while the run stored under it is the run the scan saw.
 *
 * @module core/engine/bulk-scanned-runs
 */
import type { ListFilter, WorkflowState, WorkflowStatus } from '../types.ts';
import { BulkDeleteRequiresTerminalWorkflowsError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { streamWorkflowStateBatches } from './listing.ts';
import { loadWorkflowState } from './storage-io.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

export type BulkWorkflowSnapshot = {
  id: string;
  type: string;
  status: WorkflowStatus;
  updatedAt: number;
  /** The run the snapshot describes; absent on a run stored before the token existed. */
  workflowExecutionToken?: string;
};

/** The run each scanned id held: its execution token, `undefined` for a run with none. */
export type ScannedRuns = ReadonlyMap<string, string | undefined>;

export function workflowStateToBulkSnapshot(state: WorkflowState): BulkWorkflowSnapshot {
  return {
    id: state.id,
    type: state.type,
    status: state.status,
    updatedAt: state.updatedAt,
    ...(state.workflowExecutionToken === undefined
      ? {}
      : { workflowExecutionToken: state.workflowExecutionToken }),
  };
}

export async function snapshotMatchingWorkflowSnapshots(
  internals: EngineInternals,
  filter?: ListFilter,
): Promise<BulkWorkflowSnapshot[]> {
  const snapshots: BulkWorkflowSnapshot[] = [];

  // Snapshot ids before mutating workflow state entries so storage scans
  // cannot skip or re-visit workflows when backends reorder after writes.
  for await (const batch of streamWorkflowStateBatches(internals, filter))
    for (const state of batch) snapshots.push(workflowStateToBulkSnapshot(state));

  return snapshots;
}

export async function collectTerminalWorkflowSnapshots(
  internals: EngineInternals,
  filter: ListFilter,
): Promise<BulkWorkflowSnapshot[]> {
  const snapshots: BulkWorkflowSnapshot[] = [];
  for await (const batch of streamWorkflowStateBatches(internals, filter)) {
    for (const state of batch) {
      if (!isTerminalWorkflowStatus(state.status)) {
        throw new BulkDeleteRequiresTerminalWorkflowsError();
      }
      snapshots.push(workflowStateToBulkSnapshot(state));
    }
  }
  return snapshots;
}

/**
 * Whether the run now stored under `workflowId` is not the one the scan saw: a `start-new`
 * replacement that landed after it. A commit skips such an id, whatever status the replacement is
 * in. An id the scan did not see is never moved.
 */
export function bulkRunMoved(
  runs: ScannedRuns,
  workflowId: string,
  state: Pick<WorkflowState, 'workflowExecutionToken'>,
): boolean {
  return runs.has(workflowId) && runs.get(workflowId) !== state.workflowExecutionToken;
}

/** Throws for a run {@link bulkRunMoved} says another replaced, so its id is reported, not acted on. */
export function assertBulkRunNotReplaced(
  runs: ScannedRuns,
  workflowId: string,
  state: Pick<WorkflowState, 'workflowExecutionToken'>,
): void {
  if (bulkRunMoved(runs, workflowId, state)) {
    throw new Error('Workflow was replaced after the preview');
  }
}

/** {@link bulkRunMoved} for the run stored under `workflowId` now; `false` when none is stored. */
export async function bulkRunReplaced(
  internals: EngineInternals,
  runs: ScannedRuns,
  workflowId: string,
): Promise<boolean> {
  const state = await loadWorkflowState(internals, workflowId);
  return state !== null && bulkRunMoved(runs, workflowId, state);
}

/**
 * The terminal states of `workflowIds`, read fresh: a run replaced since the scan is left out
 * (never previewed, so never deleted), and one that is no longer terminal refuses the delete.
 */
export async function loadTerminalWorkflowStatesForBatch(
  internals: EngineInternals,
  workflowIds: readonly string[],
  runs: ScannedRuns,
): Promise<WorkflowState[]> {
  const workflowStates: WorkflowState[] = [];
  for (const workflowId of workflowIds) {
    const refreshedState = await loadWorkflowState(internals, workflowId);
    if (refreshedState === null || bulkRunMoved(runs, workflowId, refreshedState)) continue;
    if (!isTerminalWorkflowStatus(refreshedState.status)) {
      throw new BulkDeleteRequiresTerminalWorkflowsError();
    }
    workflowStates.push(refreshedState);
  }
  return workflowStates;
}
