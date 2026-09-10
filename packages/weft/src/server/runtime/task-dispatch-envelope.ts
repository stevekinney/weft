/**
 * Build the durable task-ledger envelope a fresh dispatch would create if no
 * ledger record exists yet, and the fresh-dispatch admission checks
 * `dispatchTaskImpl` runs before that — split out of `task-dispatch.ts`
 * purely to stay under this repository's 500-line-per-file ceiling, matching
 * the existing `task-dispatch-revision.ts` precedent. There is no behavioral
 * reason to import this module directly instead of `task-dispatch.ts`, which
 * calls `buildCreateQueuedInput` from both `selectAndReserveWorker` and
 * `enqueueTaskForLongPoll`, and calls the admission helpers from
 * `dispatchTaskImpl` itself.
 *
 * @module server/runtime/task-dispatch-envelope
 */

import { isJSONValue } from '../../core/json.ts';
import type { TaskDispatch } from '../index.ts';
import type { CreateQueuedInput } from '../task-ledger-transitions.ts';
import {
  isValidOperationId,
  isValidWorkflowRevision,
  REMOTE_TASK_RECORD_VERSION,
} from '../task-ledger.ts';
import type { ServerContext } from './context.ts';

/**
 * Wait for startup task-ledger recovery (WFT-23) — covers both the public
 * `WeftServer.dispatchTask` entry point and `scheduleDelayedDispatch`'s timer
 * callback, which also calls `dispatchTaskImpl` directly. A rejected gate
 * means the recovery scan itself failed; propagate that failure loudly
 * rather than silently returning false, which callers would read as an
 * ordinary "no worker available" outcome.
 */
export async function awaitTaskLedgerRecoveryReady(
  context: ServerContext,
  task: TaskDispatch,
): Promise<void> {
  try {
    await context.taskLedgerRecovery.ready;
  } catch (error) {
    throw new Error(
      `Cannot dispatch task "${task.operationId}" — startup task-ledger recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reject an invalid caller-supplied operationId before it reaches a ledger
 * write (WFT-95). `dispatchTask()` is a public same-process API taking a
 * caller-controlled operationId; an id equal to the exact string "." or
 * ".." can never be addressed again over REST (a single trailing
 * `:operationId` path segment is collapsed away by WHATWG URL path
 * normalization before the route matcher ever sees it), so fresh-dispatch
 * admission rejects it up front instead of writing a ledger record that
 * becomes unreachable by id. Skipped for `redispatch` — reconstructing and
 * redispatching an already-decoded, previously persisted ledger record
 * (`scheduleDelayedDispatch`/`taskDispatchFromLedgerRecord`) must not
 * re-apply an admission-only check to data that was valid when written.
 */
export function assertFreshDispatchOperationIdAdmissible(
  task: TaskDispatch,
  redispatch: boolean,
): void {
  if (redispatch || isValidOperationId(task.operationId)) return;
  throw new Error(
    `TaskDispatch has an invalid "operationId" (${JSON.stringify(task.operationId)}) — it must be a non-empty, bounded identifier other than "." or "..".`,
  );
}

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
  // The caller-supplied operationId is rejected earlier, at fresh-dispatch
  // admission in `dispatchTaskImpl` (WFT-95) — not here. This envelope
  // builder also runs for redispatch of an already-decoded, previously
  // persisted task-ledger record (`scheduleDelayedDispatch` /
  // `taskDispatchFromLedgerRecord`), whose `operationId` was already valid
  // under the pre-WFT-95 decode contract and must keep redispatching even if
  // it happens to equal "." or "..".
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
