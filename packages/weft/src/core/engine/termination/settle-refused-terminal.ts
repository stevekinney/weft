import type { WorkflowResultWaiter } from '../engine-internal-types.ts';
import { currentExecutionAttempt } from '../execution-attempts.ts';
import type { EngineInternals } from '../internals.ts';
import { recordResultCommitter } from '../result-committer.ts';
import { deriveWorkflowResultFromState, loadWorkflowState } from '../storage-io.ts';
import {
  cleanupTerminalWorkflowImmediately,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminationCallbacks,
} from './cleanup.ts';

/**
 * The run a terminate was issued against, captured before it awaits anything: the generation this
 * engine holds for the id and the result waiter that generation registered. A replacement that
 * lands later installs its own attempt and waiter under the same id, so only this capture says
 * which ones belong to the run being terminated.
 */
export type TerminatedRun = {
  readonly workflowExecutionToken: string | undefined;
  readonly waiter: WorkflowResultWaiter | undefined;
  readonly held: boolean;
};

export function captureTerminatedRun(
  internals: EngineInternals,
  workflowId: string,
): TerminatedRun {
  const attempt = currentExecutionAttempt(internals, workflowId);
  return {
    workflowExecutionToken: attempt?.workflowExecutionToken,
    waiter: internals.resultResolvers.get(workflowId),
    held: attempt !== undefined,
  };
}

/**
 * A terminate that found nothing to write (another engine, or an earlier cancel, already ended
 * the run, or a replacement took the id) may still leave this engine holding the terminated run's
 * result waiter and in-memory state, which no commit of its own will settle. Settle exactly the
 * captured run's:
 *
 * - The record is still that run and is terminal: settle its waiter from the durable outcome and
 *   release the local state, as a terminal commit of its own would.
 * - The record belongs to another run (a replacement, on this engine or another): release nothing
 *   and never settle with the replacement's outcome. The old waiter is rejected as replaced; the
 *   replacement's checkpoint, state and waiter are untouched.
 * - The record is still that run and not terminal: leave everything for the terminate that wins.
 */
export async function settleTerminatedRunAfterRefusal(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
  run: TerminatedRun,
): Promise<void> {
  const waiter = run.waiter;
  if (waiter === undefined) return;
  const state = await loadWorkflowState(internals, workflowId);
  if (state !== null && state.workflowExecutionToken === run.workflowExecutionToken) {
    if (!TERMINAL_WORKFLOW_STATUSES.has(state.status)) return;
    settleFromState(waiter, state);
    releaseWaiterEntry(internals, workflowId, waiter);
    const holding = currentExecutionAttempt(internals, workflowId)?.workflowExecutionToken;
    if (run.held && holding === run.workflowExecutionToken) {
      cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);
    }
    return;
  }
  releaseWaiterEntry(internals, workflowId, waiter);
  waiter.reject(new Error(`Workflow "${workflowId}" was replaced by a newer run before it ended.`));
}

function settleFromState(
  waiter: WorkflowResultWaiter,
  state: NonNullable<Awaited<ReturnType<typeof loadWorkflowState>>>,
): void {
  recordResultCommitter(waiter, state.terminalCommittedBy);
  try {
    waiter.resolve(deriveWorkflowResultFromState(state));
  } catch (error) {
    waiter.reject(error);
  }
}

/** Drop the map entry only if it is still this run's waiter, never a replacement's. */
function releaseWaiterEntry(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  if (internals.resultResolvers.get(workflowId) === waiter) {
    internals.resultResolvers.delete(workflowId);
  }
}
