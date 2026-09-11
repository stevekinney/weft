// Re-export barrel for the engine lifecycle surface. Implementation lives in
// the sibling `lifecycle/` modules:
//   - shared.ts: callback type, registration entry type, shared header helpers
//   - persist.ts: version handling and resume-state preparation
//   - start.ts:   start, startWorkflow, and all start-time helpers
//   - transition.ts: fork, resume, recoverAll, and resume-from-storage
//   - checkpoint-launch.ts: launchWorkflowFromCheckpoint and its inline/worker helpers
//   - recovery-revision-groups.ts: recoverAll's per-(type, revision) preload barrier (WFT-17/WFT-18)

export {
  EMPTY_STORAGE_VALUE,
  createWorkflowHandle,
  loadTerminalCleanupTrackedState,
  loadWorkflowStartHeaders,
  normalizeStartWorkflowTags,
  processPendingUpdatesAfterReplay,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RecoverAllOptions,
  type RecoveredWorkflowInfo,
} from './lifecycle/shared.ts';

export {
  createWorkflowVersionTuple,
  derivePreparedExecutionState,
  prepareResumeState,
  throwVersionMismatch,
  workflowStateWithVersionTuple,
  workflowVersionTupleFromState,
} from './lifecycle/persist.ts';

export { resolveScheduledStartAt } from './lifecycle/start-schedule-timing.ts';
export { start, startWorkflow } from './lifecycle/start.ts';

export {
  applyRestartLineage,
  createInitialCheckpoint,
  createInitialWorkflowState,
  parseStartOptionDuration,
} from './lifecycle/start-state.ts';

export {
  startOrSignal,
  startWithIdempotency,
  type StartOrSignalCallbacks,
  type StartOrSignalResult,
} from './lifecycle/start-or-signal.ts';

export {
  buildInitialSearchAttributeOperations,
  buildStartBatchOperations,
  validateSearchAttributes,
} from './lifecycle/start-batch.ts';

export {
  beginWorkflowExecution,
  runWorkflowStartInterceptor,
  startWorkflowExecution,
} from './lifecycle/start-exec.ts';

export {
  buildForkBatchOperations,
  buildForkSearchAttributes,
  createForkLineage,
  createForkedWorkflowState,
} from './lifecycle/fork-helpers.ts';

export { launchWorkflowFromCheckpoint } from './lifecycle/checkpoint-launch.ts';
export { fork, recoverAll, resume } from './lifecycle/transition.ts';

export { resumeWorkflowFromStorage } from './lifecycle/resume.ts';
