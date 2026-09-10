/**
 * {@link TimeOperationCallbacks} — the callback bundle `operations-time.ts`'s
 * timer-fire handlers (delayed start, sleep, deadline, schedule) take. Split
 * out of that file, which has no headroom under the repository's 500-line
 * implementation-file ceiling for this type inline.
 *
 * @module core/engine/time-operation-callbacks
 */

import type { Checkpoint, Duration, TimerEntry, WorkflowState } from '../types.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import type { ExecutableRegistration } from './dynamic-source-execution.ts';

type RegistrationEntry = ExecutableRegistration['entry'];

export type TimeOperationCallbacks = {
  completeOperation: (workflowId: string, value: unknown) => void;
  dispatchEvent: (event: Event) => void;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  beginWorkflowExecution: (
    workflowId: string,
    workflowExecutionToken: string | undefined,
    workflowType: string,
    input: unknown,
    checkpoint: Checkpoint,
    executionDeadline: number | undefined,
    executionStateOwnerId: string,
    registration: RegistrationEntry,
  ) => void;
  workflowVersionTupleFromState: (state: WorkflowState) => WorkflowVersionTuple;
  setWorkflowStartHeaders: (workflowId: string, headers: Map<string, string> | undefined) => void;
  loadWorkflowStartHeaders: (workflowId: string) => Promise<Map<string, string> | undefined>;
  parseStartOptionDuration: (
    value: Duration,
    fieldName: 'options.executionTimeout' | 'options.startAfter',
  ) => number;
  runDeferredTerminalCleanup: (workflowId: string, timerId: string) => Promise<void>;
  runWorkflowFinalizer: (workflowId: string, timerId: string) => Promise<void>;
  handleScheduleTimer: (entry: TimerEntry) => Promise<void>;
  timeout: (workflowId: string) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId: string) => void;
  /** Resolve `type` against an EXACT pinned `WorkflowState.revision` (WFT-17, `undefined` for a legacy record) — never the catalog's active pointer. Used by a delayed-start fire, matching `resumeWorkflowFromStorage()`. */
  resolveExecutableRegistrationForRevision: (
    type: string,
    revision: string | undefined,
  ) => Promise<ExecutableRegistration>;
};
