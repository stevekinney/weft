/**
 * Thin barrel over the split termination modules. Keeps existing import paths
 * (`./termination.ts`) working while the implementation lives in
 * `./termination/cleanup.ts`, `./termination/complete.ts`, and
 * `./termination/suspend.ts`.
 */

export {
  TERMINAL_WORKFLOW_STATUSES,
  cleanupTerminalWorkflowDurableState,
  cleanupTerminalWorkflowImmediately,
  cleanupTerminalWorkflowMemory,
  cleanupTerminalWorkflowSynchronously,
  cleanupWaiters,
  cleanupWorkflowStorage,
  finalizeScheduledWorkflowTerminal,
  handleCleanupError,
  runDeferredTerminalCleanup,
  type TerminationCallbacks,
} from './termination/cleanup.ts';
export {
  buildPendingTimelineOperation,
  buildTerminalCleanupTimerOperations,
  cancelWorkflow,
  completeWorkflow,
  ensureTerminalCleanupTracked,
  failWorkflow,
  finalizePendingTimelineEntry,
  terminateWorkflow,
  timeoutWorkflow,
} from './termination/complete.ts';
export { suspendWorkflow } from './termination/suspend.ts';
