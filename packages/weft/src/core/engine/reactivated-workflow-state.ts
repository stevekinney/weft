import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';

/** The state of a failed run once it is running again: the failure and its terminal marks removed. */
export function buildReactivatedWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
): WorkflowState {
  const reactivatedState: WorkflowState = {
    ...state,
    status: 'running',
    updatedAt: internals.options.getNow(),
  };
  delete reactivatedState.error;
  delete reactivatedState.errorStack;
  delete reactivatedState.failureCategory;
  delete reactivatedState.errorCode;
  delete reactivatedState.failedStep;
  delete reactivatedState.result;
  delete reactivatedState.terminationReason;
  delete reactivatedState.terminalCleanupToken;
  delete reactivatedState.terminalCommittedBy;
  return reactivatedState;
}
