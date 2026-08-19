/**
 * Retired pre-cutover record shapes, type guards, and lifecycle calculators
 * for the `op:queued:`/`op:inflight:`/`op:resolved:`/`op:dead-letter:` key
 * scheme the durable task ledger (WFT-22, `task-ledger.ts`) replaced.
 *
 * The state-reading and state-writing functions this module once exported
 * (`getTaskState`, `getExclusiveTaskState`, `readQueuedRecord`,
 * `readInflightRecord`, `readDeadLetteredTaskRecord`, `isTaskDeadLettered`,
 * `writeDeadLetteredTaskRecord`, `markInflight`) are gone — nothing writes
 * those keys anymore. What remains is still load-bearing: the type guards
 * and `TaskState` vocabulary back `get-task-diagnostics.ts` (not yet
 * migrated onto the ledger — WFT-24), the lifecycle calculators back
 * `task-metrics.ts`, and `clearDeadLetteredTaskRecord` lets that same
 * diagnostics operation clear a legacy dead letter that still exists even
 * though nothing creates new ones.
 *
 * @module task-state
 */

import type { RetryPolicy } from '../core/types.ts';
import type { Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';

// ---------------------------------------------------------------------------
// Task state type
// ---------------------------------------------------------------------------

/** The three exclusive states a dispatched task can occupy. */
export type TaskState = 'queued' | 'inflight' | 'resolved';

/** Why a task was requeued before another dispatch attempt. */
export type TaskRequeueReason = 'visibility-timeout' | 'worker-disconnect';

/** Final reason captured when a task reaches the resolved state. */
export type TaskResolutionReason = 'completed' | 'failed' | 'cancelled' | 'max-attempts-exceeded';

/** Why a task-result transition was moved to the operator dead-letter guard. */
export type TaskDeadLetterReason = 'result-resolution-storage-exhausted';

/** Lifecycle evidence persisted with task records for diagnostics. */
export interface TaskLifecycleFields {
  /** First time this operation entered a task queue. */
  firstQueuedAt?: number | undefined;
  /** Most recent time this operation entered a task queue. */
  lastQueuedAt?: number | undefined;
  /** Most recent time this operation was dispatched to a worker. */
  lastDispatchedAt?: number | undefined;
  /** Time this operation started executing on a worker when knowable. */
  startedAt?: number | undefined;
  /** Time this operation reached a terminal task state. */
  completedAt?: number | undefined;
  /** Most recent worker heartbeat observed for this operation. */
  lastHeartbeatAt?: number | undefined;
  /** Number of retry attempts after the original attempt. */
  retryCount?: number | undefined;
  /** Number of times visibility/disconnect handling moved this task back to queued. */
  requeueCount?: number | undefined;
  /** Most recent reason this task moved back to queued. */
  lastRequeueReason?: TaskRequeueReason | undefined;
}

/**
 * The subset of {@link TaskLifecycleFields} the queue-latency, execution-latency,
 * and heartbeat-staleness calculations actually read. Deliberately narrower
 * than `TaskLifecycleFields` so these calculations also accept the durable
 * remote task ledger's records (`RemoteTaskLeased`, `RemoteTaskQueued` —
 * WFT-22), which carry the same timing fields but a free-text
 * `lastRequeueReason` rather than the fixed {@link TaskRequeueReason} enum.
 */
export type TaskTimingFields = Readonly<{
  lastQueuedAt?: number | undefined;
  lastDispatchedAt?: number | undefined;
  startedAt?: number | undefined;
  lastHeartbeatAt?: number | undefined;
}>;

// ---------------------------------------------------------------------------
// Record types stored at each key
// ---------------------------------------------------------------------------

/** Persisted record for a task in the queued state. */
export interface QueuedRecord extends TaskLifecycleFields {
  operationId: string;
  activityName: string;
  input: unknown;
  queue: string;
  attempt: number;
  visibilityTimeout: number;
  retryPolicy?: RetryPolicy | undefined;
  queuedAt: number;
  /** Workflow that dispatched this activity. Present when the dispatch included a workflowId. */
  workflowId?: string | undefined;
  /** Durable token for the workflow run that dispatched this activity, when known. */
  workflowExecutionToken?: string | undefined;
}

/** Persisted record for a task in the inflight state. */
export interface InflightRecord extends TaskLifecycleFields {
  operationId: string;
  workerId: string;
  deadline: number;
  activityName: string;
  queue: string;
  input: unknown;
  attempt: number;
  visibilityTimeout: number;
  retryPolicy?: RetryPolicy | undefined;
  /** Workflow that dispatched this activity. Present when the dispatch included a workflowId. */
  workflowId?: string | undefined;
  /** Durable token for the workflow run that dispatched this activity, when known. */
  workflowExecutionToken?: string | undefined;
  /** Unique, unguessable token identifying this dispatch attempt. */
  attemptToken: string;
}

/** Persisted record for a task in the resolved state. */
export interface ResolvedRecord {
  operationId: string;
  status: 'completed' | 'failed';
  resolvedAt: number;
  value?: unknown;
  error?: string | undefined;
  activityName?: string | undefined;
  queue?: string | undefined;
  workerId?: string | undefined;
  attempt?: number | undefined;
  visibilityTimeout?: number | undefined;
  /** Workflow that dispatched this activity. Present when the dispatch included a workflowId. */
  workflowId?: string | undefined;
  firstQueuedAt?: number | undefined;
  lastQueuedAt?: number | undefined;
  lastDispatchedAt?: number | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  lastHeartbeatAt?: number | undefined;
  retryCount?: number | undefined;
  requeueCount?: number | undefined;
  lastRequeueReason?: TaskRequeueReason | undefined;
  resolutionReason?: TaskResolutionReason | undefined;
  queueLatencyMs?: number | undefined;
  executionLatencyMs?: number | undefined;
}

/** Durable operator guard for a task result whose resolved write exhausted retries. */
export interface DeadLetteredTaskRecord {
  operationId: string;
  reason: TaskDeadLetterReason;
  deadLetteredAt: number;
  errorMessage: string;
  retryAttempts: number;
  status: 'completed' | 'failed';
  activityName?: string | undefined;
  queue?: string | undefined;
  workerId?: string | undefined;
  attempt?: number | undefined;
  visibilityTimeout?: number | undefined;
  workflowId?: string | undefined;
  retryCount?: number | undefined;
  requeueCount?: number | undefined;
  lastRequeueReason?: TaskRequeueReason | undefined;
}

// ---------------------------------------------------------------------------
// Record guards and lifecycle helpers
// ---------------------------------------------------------------------------

/** Type guard for decoded storage records in the queued state. */
export function isQueuedRecord(value: unknown): value is QueuedRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['operationId'] === 'string' &&
    typeof record['activityName'] === 'string' &&
    typeof record['queue'] === 'string' &&
    typeof record['attempt'] === 'number' &&
    typeof record['visibilityTimeout'] === 'number' &&
    typeof record['queuedAt'] === 'number'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Type guard for decoded storage records in the inflight state. */
export function isInflightRecord(value: unknown): value is InflightRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['operationId'] === 'string' &&
    typeof record['activityName'] === 'string' &&
    typeof record['queue'] === 'string' &&
    typeof record['attempt'] === 'number' &&
    typeof record['visibilityTimeout'] === 'number' &&
    typeof record['workerId'] === 'string' &&
    typeof record['deadline'] === 'number' &&
    isNonEmptyString(record['attemptToken'])
  );
}

/** Type guard for decoded storage records in the resolved state. */
export function isResolvedRecord(value: unknown): value is ResolvedRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['operationId'] === 'string' &&
    (record['status'] === 'completed' || record['status'] === 'failed') &&
    typeof record['resolvedAt'] === 'number'
  );
}

/** Type guard for decoded task-result dead-letter records. */
export function isDeadLetteredTaskRecord(value: unknown): value is DeadLetteredTaskRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['operationId'] === 'string' &&
    record['reason'] === 'result-resolution-storage-exhausted' &&
    typeof record['deadLetteredAt'] === 'number' &&
    typeof record['errorMessage'] === 'string' &&
    typeof record['retryAttempts'] === 'number' &&
    (record['status'] === 'completed' || record['status'] === 'failed')
  );
}

/** Clear a task-result dead-letter guard so reconciliation may handle the inflight record again. */
export async function clearDeadLetteredTaskRecord(
  storage: Storage,
  operationId: string,
): Promise<void> {
  await storage.delete(KEYS.operationDeadLetter(operationId));
}

export function calculateQueueLatencyMs(record: TaskTimingFields): number | undefined {
  if (record.lastQueuedAt === undefined || record.lastDispatchedAt === undefined) return undefined;
  return Math.max(0, record.lastDispatchedAt - record.lastQueuedAt);
}

export function calculateExecutionLatencyMs(
  record: TaskTimingFields,
  completedAt: number,
): number | undefined {
  const startedAt = record.startedAt ?? record.lastDispatchedAt;
  if (startedAt === undefined) return undefined;
  return Math.max(0, completedAt - startedAt);
}

export function calculateHeartbeatAgeMs(
  record: TaskTimingFields & { deadline?: number | undefined },
  currentTime: number,
): number | undefined {
  const heartbeatReference =
    record.lastHeartbeatAt ?? record.startedAt ?? record.lastDispatchedAt ?? record.deadline;
  if (heartbeatReference === undefined) return undefined;
  return Math.max(0, currentTime - heartbeatReference);
}

export function isHeartbeatStale(
  record: TaskTimingFields & { deadline?: number | undefined },
  currentTime: number,
  staleAfterMs: number,
): boolean {
  const heartbeatAgeMs = calculateHeartbeatAgeMs(record, currentTime);
  return heartbeatAgeMs !== undefined && heartbeatAgeMs >= staleAfterMs;
}
