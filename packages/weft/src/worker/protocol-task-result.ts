/**
 * Parser for the worker-to-server `taskResult` message.
 *
 * `taskResult` is a discriminated union over status `completed | failed |
 * cancelled`. Variant dispatch uses a `satisfies Record<TaskResultStatus, …>`
 * lookup so adding a new variant becomes a compile-time error. This cluster is
 * split out of `./protocol.ts` so the canonical parser module stays focused on
 * the top-level schema-to-guard dispatch a reviewer audits.
 *
 * @module worker/protocol-task-result
 */

import type { RemoteWorkerProtocolParseResult } from './protocol-internals.ts';
import {
  isNonEmptyString,
  isRemoteWorkerJsonValue,
  protocolFailure,
} from './protocol-internals.ts';
import type {
  CancelledTaskResultMessage,
  CompletedTaskResultMessage,
  FailedTaskResultMessage,
} from './protocol-messages.ts';

/**
 * Worker-to-server task result message. Discriminated union over `status`.
 *
 * @example
 * ```ts
 * import type { TaskResultMessage } from '@lostgradient/weft/worker-protocol';
 *
 * const message: TaskResultMessage = {
 *   type: 'taskResult', operationId: 'op-1', status: 'completed', value: { ok: true },
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type TaskResultMessage =
  CompletedTaskResultMessage | FailedTaskResultMessage | CancelledTaskResultMessage;

type TaskResultStatus = TaskResultMessage['status'];

/** Validate and extract the required echoed `attemptToken` from a taskResult record. */
function parseEchoedAttemptToken(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<{ attemptToken: string }> {
  const attemptToken = record['attemptToken'];
  if (!isNonEmptyString(attemptToken)) {
    return protocolFailure('invalid_message', 'taskResult.attemptToken must be a non-empty string');
  }
  return { ok: true, message: { attemptToken } };
}

/**
 * Validate and extract the OPTIONAL echoed `workflowRevision` from a
 * taskResult record (WFT-20). Absent is valid (a worker whose SDK predates
 * this field, or a dispatch that never carried one); present-but-non-string
 * is rejected the same way every other bounded field on this trust boundary
 * is.
 */
function parseEchoedWorkflowRevision(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<{ workflowRevision?: string }> {
  const workflowRevision = record['workflowRevision'];
  if (workflowRevision === undefined) {
    return { ok: true, message: {} };
  }
  if (!isNonEmptyString(workflowRevision)) {
    return protocolFailure(
      'invalid_message',
      'taskResult.workflowRevision must be a non-empty string when present',
    );
  }
  return { ok: true, message: { workflowRevision } };
}

function parseCompletedTaskResult(
  operationId: string,
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<CompletedTaskResultMessage> {
  const value = record['value'];
  if (!isRemoteWorkerJsonValue(value)) {
    return protocolFailure('invalid_message', 'completed taskResult.value must be valid JSON');
  }
  const token = parseEchoedAttemptToken(record);
  if (!token.ok) return token;
  const revision = parseEchoedWorkflowRevision(record);
  if (!revision.ok) return revision;
  return {
    ok: true,
    message: {
      type: 'taskResult',
      operationId,
      status: 'completed',
      value,
      ...token.message,
      ...revision.message,
    },
  };
}

function parseFailedTaskResult(
  operationId: string,
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<FailedTaskResultMessage> {
  const error = record['error'];
  if (typeof error !== 'string') {
    return protocolFailure('invalid_message', 'failed taskResult.error must be a string');
  }
  const token = parseEchoedAttemptToken(record);
  if (!token.ok) return token;
  const revision = parseEchoedWorkflowRevision(record);
  if (!revision.ok) return revision;
  return {
    ok: true,
    message: {
      type: 'taskResult',
      operationId,
      status: 'failed',
      error,
      ...token.message,
      ...revision.message,
    },
  };
}

function parseCancelledTaskResult(
  operationId: string,
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<CancelledTaskResultMessage> {
  const error = record['error'];
  if (typeof error !== 'string') {
    return protocolFailure('invalid_message', 'cancelled taskResult.error must be a string');
  }
  const cancelled = record['cancelled'];
  if (cancelled !== undefined && cancelled !== true) {
    return protocolFailure('invalid_message', 'taskResult.cancelled must be true when present');
  }
  const token = parseEchoedAttemptToken(record);
  if (!token.ok) return token;
  const revision = parseEchoedWorkflowRevision(record);
  if (!revision.ok) return revision;
  return {
    ok: true,
    message: {
      type: 'taskResult',
      operationId,
      status: 'cancelled',
      error,
      ...(cancelled === true ? { cancelled } : {}),
      ...token.message,
      ...revision.message,
    },
  };
}

const TASK_RESULT_VARIANT_PARSERS = {
  completed: parseCompletedTaskResult,
  failed: parseFailedTaskResult,
  cancelled: parseCancelledTaskResult,
} as const satisfies Record<
  TaskResultStatus,
  (
    operationId: string,
    record: Record<string, unknown>,
  ) => RemoteWorkerProtocolParseResult<TaskResultMessage>
>;

function isTaskResultStatus(value: unknown): value is TaskResultStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

/** Parse and validate a worker-to-server `taskResult` message into its typed variant. */
export function parseTaskResultMessage(
  record: Record<string, unknown>,
): RemoteWorkerProtocolParseResult<TaskResultMessage> {
  const operationId = record['operationId'];
  if (!isNonEmptyString(operationId)) {
    return protocolFailure('invalid_message', 'taskResult.operationId must be a non-empty string');
  }

  const status = record['status'];
  if (!isTaskResultStatus(status)) {
    return protocolFailure(
      'invalid_message',
      'taskResult.status must be completed, failed, or cancelled',
    );
  }

  return TASK_RESULT_VARIANT_PARSERS[status](operationId, record);
}
