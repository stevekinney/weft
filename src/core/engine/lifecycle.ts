// Re-export barrel for the engine lifecycle surface. Implementation lives in
// the sibling `lifecycle/` modules:
//   - shared.ts: callback type, registration entry type, shared header helpers
//   - persist.ts: version handling and resume-state preparation
//   - start.ts:   start, startWorkflow, and all start-time helpers
//   - transition.ts: fork, resume, recoverAll, and resume-from-storage

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
} from './lifecycle/shared.ts';

export {
  createWorkflowVersionTuple,
  derivePreparedExecutionState,
  prepareResumeState,
  throwVersionMismatch,
  workflowStateWithVersionTuple,
  workflowVersionTupleFromState,
} from './lifecycle/persist.ts';

export {
  createInitialCheckpoint,
  createInitialWorkflowState,
  parseStartOptionDuration,
  resolveScheduledStartAt,
  start,
  startWorkflow,
} from './lifecycle/start.ts';

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

export { fork, launchWorkflowFromCheckpoint, recoverAll, resume } from './lifecycle/transition.ts';

export { resumeWorkflowFromStorage } from './lifecycle/resume.ts';
