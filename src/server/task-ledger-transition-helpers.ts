/**
 * Shared result types and field pickers for the durable remote task ledger's
 * pure conditional-transition functions (WFT-25) — split out of
 * `task-ledger-transitions.ts` / `task-ledger-transitions-cancellation.ts`
 * purely to keep both under this repository's file-size ceiling; there is no
 * behavioral reason to import this module directly instead of one of those.
 *
 * @module server/task-ledger-transition-helpers
 */

import type { WorkerExecutionIdentity } from '../worker/manifest/types.ts';
import type { RemoteTaskAttemptFields, RemoteTaskBase } from './task-ledger-types.ts';

export type TaskLedgerTransitionResult<T> =
  | Readonly<{ ok: true; nextRecord: T }>
  | Readonly<{ ok: false; reason: string }>;

export type TaskLedgerPreconditionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

// Internal field pickers — explicit, not `...current`, so a next record never
// silently inherits state-specific fields (e.g. `availableAt`) that do not
// belong on the target state.

export function pickBase(record: RemoteTaskBase): RemoteTaskBase {
  return {
    recordVersion: record.recordVersion,
    operationId: record.operationId,
    ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
    workflowType: record.workflowType,
    ...(record.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: record.workflowExecutionToken }
      : {}),
    activityName: record.activityName,
    queue: record.queue,
    input: record.input,
    headers: record.headers,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.fairShareKey !== undefined ? { fairShareKey: record.fairShareKey } : {}),
    ...(record.stickyWorkflowId !== undefined ? { stickyWorkflowId: record.stickyWorkflowId } : {}),
    visibilityTimeoutMilliseconds: record.visibilityTimeoutMilliseconds,
    ...(record.retryPolicy !== undefined ? { retryPolicy: record.retryPolicy } : {}),
    ...(record.scheduleToCloseDeadline !== undefined
      ? { scheduleToCloseDeadline: record.scheduleToCloseDeadline }
      : {}),
    ...(record.executionRequirement !== undefined
      ? { executionRequirement: record.executionRequirement }
      : {}),
    createdAt: record.createdAt,
    generation: record.generation,
  };
}

export function pickAttemptFields(record: RemoteTaskAttemptFields): RemoteTaskAttemptFields {
  return {
    retryCount: record.retryCount,
    requeueCount: record.requeueCount,
    ...(record.lastRequeueReason !== undefined
      ? { lastRequeueReason: record.lastRequeueReason }
      : {}),
  };
}

export type LeaseHolderFields = Readonly<{
  attemptToken: string;
  workerSessionId: string;
  executionIdentity?: WorkerExecutionIdentity;
  attempt: number;
  leaseDeadline: number;
  firstQueuedAt: number;
  lastQueuedAt: number;
  startedAt: number;
  lastHeartbeatAt: number;
}>;

export function pickLeaseHolderFields(record: LeaseHolderFields): LeaseHolderFields {
  return {
    attemptToken: record.attemptToken,
    workerSessionId: record.workerSessionId,
    ...(record.executionIdentity !== undefined
      ? { executionIdentity: record.executionIdentity }
      : {}),
    attempt: record.attempt,
    leaseDeadline: record.leaseDeadline,
    firstQueuedAt: record.firstQueuedAt,
    lastQueuedAt: record.lastQueuedAt,
    startedAt: record.startedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
  };
}
