/**
 * Build the durable task-ledger envelope a fresh dispatch would create if no
 * ledger record exists yet — split out of `task-dispatch.ts` purely to stay
 * under this repository's 500-line-per-file ceiling, matching the existing
 * `task-dispatch-revision.ts` precedent. There is no behavioral reason to
 * import this module directly instead of `task-dispatch.ts`, which calls it
 * from both `selectAndReserveWorker` and `enqueueTaskForLongPoll`.
 *
 * @module server/runtime/task-dispatch-envelope
 */

import { isJSONValue } from '../../core/json.ts';
import type { TaskDispatch } from '../index.ts';
import type { CreateQueuedInput } from '../task-ledger-transitions.ts';
import { isValidWorkflowRevision, REMOTE_TASK_RECORD_VERSION } from '../task-ledger.ts';

/** The optional `CreateQueuedInput` fields a `TaskDispatch` may or may not carry. */
function buildOptionalCreateQueuedFields(task: TaskDispatch): Partial<CreateQueuedInput> {
  return {
    ...(task.workflowId !== undefined ? { workflowId: task.workflowId } : {}),
    ...(task.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: task.workflowExecutionToken }
      : {}),
    ...(task.workflowRevision !== undefined ? { workflowRevision: task.workflowRevision } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.fairShareKey !== undefined ? { fairShareKey: task.fairShareKey } : {}),
    ...(task.sticky && task.workflowId !== undefined ? { stickyWorkflowId: task.workflowId } : {}),
    ...(task.retryPolicy !== undefined ? { retryPolicy: task.retryPolicy } : {}),
  };
}

/** The durable envelope every fresh dispatch would create if no ledger record exists yet. */
export function buildCreateQueuedInput(
  task: TaskDispatch,
  queue: string,
  visibilityTimeout: number,
): CreateQueuedInput {
  const input = task.input === undefined ? null : task.input;
  if (!isJSONValue(input)) {
    throw new Error(
      `TaskDispatch for operation "${task.operationId}" has a non-JSON-serializable "input" — the durable task ledger requires JSON-safe input.`,
    );
  }
  // Reject an invalid caller-supplied revision before it reaches a ledger
  // write (WFT-20). An unvalidated JS caller could otherwise pass an empty
  // or oversized `workflowRevision`; `decodeRemoteTaskRecord` would then
  // reject the record wholesale on every later read, silently disappearing
  // the task from long-poll claims after `dispatchTask()` already reported
  // success.
  if (task.workflowRevision !== undefined && !isValidWorkflowRevision(task.workflowRevision)) {
    throw new Error(
      `TaskDispatch for operation "${task.operationId}" has an invalid "workflowRevision" — it must be a non-empty, bounded identifier.`,
    );
  }
  return {
    recordVersion: REMOTE_TASK_RECORD_VERSION,
    operationId: task.operationId,
    workflowType: task.workflowType,
    activityName: task.activityName,
    queue,
    input,
    headers: task.headers ?? {},
    visibilityTimeoutMilliseconds: visibilityTimeout,
    createdAt: Date.now(),
    ...buildOptionalCreateQueuedFields(task),
  };
}
