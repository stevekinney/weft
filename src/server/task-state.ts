/**
 * Task state tracking for the remote worker dispatch system.
 *
 * Every dispatched task exists in exactly one of three durable states:
 * - **queued**: Waiting in storage for a worker to claim it.
 * - **inflight**: Assigned to a worker with a visibility deadline.
 * - **resolved**: Completed or permanently failed.
 *
 * State transitions use `storage.batch()` to atomically delete the old
 * key and write the new key, preventing any window where a task is in
 * zero or two states simultaneously.
 *
 * @module task-state
 */

import { decode, encode } from '../core/codec.ts';
import type { RetryPolicy } from '../core/types.ts';
import type { Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { buildResolvedRecord } from './task-resolved-record.ts';

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
  /**
   * Unique, unguessable token identifying this dispatch attempt. Rotated on every
   * (re-)dispatch because each dispatch writes a fresh InflightRecord. The
   * long-poll completion handler rejects a result whose echoed token does not
   * match this value. Optional for back-compatible decoding of records written
   * before this field existed; a missing token disables the check for that record.
   */
  attemptToken?: string | undefined;
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

export interface TransitionInflightToResolvedOptions {
  resolutionReason?: TaskResolutionReason;
  resolvedAt?: number;
  record?: InflightRecord;
  value?: unknown;
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// State query
// ---------------------------------------------------------------------------

/**
 * Look up the current durable state of a task.
 *
 * Returns the state name if the task is found in any of the three
 * states, or `null` if no record exists (the task was never dispatched
 * or its resolved record has been garbage-collected).
 */
export async function getTaskState(
  storage: Storage,
  operationId: string,
): Promise<TaskState | null> {
  const [inflight, queued, resolved] = await Promise.all([
    storage.get(KEYS.operationInflight(operationId)),
    storage.get(KEYS.operationQueued(operationId)),
    storage.get(KEYS.operationResolved(operationId)),
  ]);

  if (inflight !== null) return 'inflight';
  if (queued !== null) return 'queued';
  if (resolved !== null) return 'resolved';
  return null;
}

/**
 * Return the task state and verify it occupies exactly one state.
 *
 * Throws if the task is found in multiple states simultaneously —
 * this indicates a bug in the state machine.
 */
export async function getExclusiveTaskState(
  storage: Storage,
  operationId: string,
): Promise<TaskState | null> {
  const [inflight, queued, resolved] = await Promise.all([
    storage.get(KEYS.operationInflight(operationId)),
    storage.get(KEYS.operationQueued(operationId)),
    storage.get(KEYS.operationResolved(operationId)),
  ]);

  const states: TaskState[] = [];
  if (inflight !== null) states.push('inflight');
  if (queued !== null) states.push('queued');
  if (resolved !== null) states.push('resolved');

  if (states.length > 1) {
    throw new Error(
      `Task "${operationId}" occupies multiple states simultaneously: ${states.join(', ')}`,
    );
  }

  return states[0] ?? null;
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
    typeof record['deadline'] === 'number'
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

/** Decode the queued record for an operation, returning null when absent or malformed. */
export async function readQueuedRecord(
  storage: Storage,
  operationId: string,
): Promise<QueuedRecord | null> {
  const value = await storage.get(KEYS.operationQueued(operationId));
  if (value === null) return null;
  const decoded = decode(value);
  return isQueuedRecord(decoded) ? decoded : null;
}

/** Decode the inflight record for an operation, returning null when absent or malformed. */
export async function readInflightRecord(
  storage: Storage,
  operationId: string,
): Promise<InflightRecord | null> {
  const value = await storage.get(KEYS.operationInflight(operationId));
  if (value === null) return null;
  const decoded = decode(value);
  return isInflightRecord(decoded) ? decoded : null;
}

/** Decode the task-result dead-letter record for an operation. */
export async function readDeadLetteredTaskRecord(
  storage: Storage,
  operationId: string,
): Promise<DeadLetteredTaskRecord | null> {
  const value = await storage.get(KEYS.operationDeadLetter(operationId));
  if (value === null) return null;
  const decoded = decode(value);
  return isDeadLetteredTaskRecord(decoded) ? decoded : null;
}

/** True when reconciliation should not re-dispatch the operation. */
export async function isTaskDeadLettered(storage: Storage, operationId: string): Promise<boolean> {
  return (await readDeadLetteredTaskRecord(storage, operationId)) !== null;
}

/** Persist a task-result dead-letter guard. */
export async function writeDeadLetteredTaskRecord(
  storage: Storage,
  record: DeadLetteredTaskRecord,
): Promise<void> {
  // Use the same atomic batch path as other task-state transitions; this guard
  // is what prevents reconciliation from re-dispatching a reported result.
  await storage.batch([
    {
      type: 'put',
      key: KEYS.operationDeadLetter(record.operationId),
      value: encode(record),
    },
  ]);
}

/** Clear a task-result dead-letter guard so reconciliation may handle the inflight record again. */
export async function clearDeadLetteredTaskRecord(
  storage: Storage,
  operationId: string,
): Promise<void> {
  await storage.delete(KEYS.operationDeadLetter(operationId));
}

function normalizeQueuedRecordLifecycle(
  record: QueuedRecord,
  previous?: InflightRecord | null,
): QueuedRecord {
  const normalized: QueuedRecord = {
    ...record,
    firstQueuedAt: resolveQueuedFirstQueuedAt(record, previous),
    lastQueuedAt: record.lastQueuedAt ?? record.queuedAt,
    retryCount: resolveRetryCount(record, previous),
    requeueCount: record.requeueCount ?? previous?.requeueCount ?? 0,
  };
  applyPreviousLifecycleFields(normalized, previous);
  return normalized;
}

function normalizeInflightRecordLifecycle(
  record: InflightRecord,
  previous?: QueuedRecord | null,
  now: number = Date.now(),
): InflightRecord {
  const lastDispatchedAt = record.lastDispatchedAt ?? now;
  const firstQueuedAt = resolveInflightFirstQueuedAt(record, previous, lastDispatchedAt);
  const normalized: InflightRecord = {
    ...record,
    firstQueuedAt,
    lastQueuedAt: resolveInflightLastQueuedAt(record, previous, firstQueuedAt),
    lastDispatchedAt,
    startedAt: record.startedAt ?? lastDispatchedAt,
    retryCount: resolveRetryCount(record, previous),
    requeueCount: record.requeueCount ?? previous?.requeueCount ?? 0,
  };
  applyPreviousLifecycleFields(normalized, previous);
  return normalized;
}

function resolveQueuedFirstQueuedAt(
  record: QueuedRecord,
  previous?: InflightRecord | null,
): number {
  return (
    record.firstQueuedAt ?? previous?.firstQueuedAt ?? previous?.lastQueuedAt ?? record.queuedAt
  );
}

function resolveInflightFirstQueuedAt(
  record: InflightRecord,
  previous: QueuedRecord | null | undefined,
  lastDispatchedAt: number,
): number {
  return (
    record.firstQueuedAt ??
    previous?.firstQueuedAt ??
    previous?.lastQueuedAt ??
    previous?.queuedAt ??
    lastDispatchedAt
  );
}

function resolveInflightLastQueuedAt(
  record: InflightRecord,
  previous: QueuedRecord | null | undefined,
  firstQueuedAt: number,
): number {
  return record.lastQueuedAt ?? previous?.lastQueuedAt ?? previous?.queuedAt ?? firstQueuedAt;
}

function resolveRetryCount(
  record: { attempt: number; retryCount?: number | undefined },
  previous?: TaskLifecycleFields | null,
): number {
  return record.retryCount ?? previous?.retryCount ?? Math.max(0, record.attempt - 1);
}

function applyPreviousLifecycleFields(
  record: TaskLifecycleFields,
  previous?: TaskLifecycleFields | null,
): void {
  if (previous === undefined || previous === null) return;
  record.lastDispatchedAt ??= previous.lastDispatchedAt;
  record.startedAt ??= previous.startedAt;
  record.lastRequeueReason ??= previous.lastRequeueReason;
}

export function calculateQueueLatencyMs(record: TaskLifecycleFields): number | undefined {
  if (record.lastQueuedAt === undefined || record.lastDispatchedAt === undefined) return undefined;
  return Math.max(0, record.lastDispatchedAt - record.lastQueuedAt);
}

export function calculateExecutionLatencyMs(
  record: TaskLifecycleFields,
  completedAt: number,
): number | undefined {
  const startedAt = record.startedAt ?? record.lastDispatchedAt;
  if (startedAt === undefined) return undefined;
  return Math.max(0, completedAt - startedAt);
}

export function calculateHeartbeatAgeMs(
  record: TaskLifecycleFields & { deadline?: number | undefined },
  currentTime: number,
): number | undefined {
  const heartbeatReference =
    record.lastHeartbeatAt ?? record.startedAt ?? record.lastDispatchedAt ?? record.deadline;
  if (heartbeatReference === undefined) return undefined;
  return Math.max(0, currentTime - heartbeatReference);
}

export function isHeartbeatStale(
  record: TaskLifecycleFields & { deadline?: number | undefined },
  currentTime: number,
  staleAfterMs: number,
): boolean {
  const heartbeatAgeMs = calculateHeartbeatAgeMs(record, currentTime);
  return heartbeatAgeMs !== undefined && heartbeatAgeMs >= staleAfterMs;
}

// ---------------------------------------------------------------------------
// State transitions (atomic batch operations)
// ---------------------------------------------------------------------------

/** Write the initial queued record for a newly dispatched task. */
export async function markQueued(storage: Storage, record: QueuedRecord): Promise<QueuedRecord> {
  const normalizedRecord = normalizeQueuedRecordLifecycle(record);
  await storage.put(KEYS.operationQueued(record.operationId), encode(normalizedRecord));
  return normalizedRecord;
}

type TransitionQueuedToInflightOptions = {
  readonly queuedRecord?: QueuedRecord | null;
  readonly now?: number | undefined;
};

/** Atomically transition a task from queued → inflight. */
export async function transitionQueuedToInflight(
  storage: Storage,
  operationId: string,
  inflightRecord: InflightRecord,
  options: TransitionQueuedToInflightOptions = {},
): Promise<InflightRecord> {
  const queuedRecord =
    options.queuedRecord === undefined
      ? await readQueuedRecord(storage, operationId)
      : options.queuedRecord;
  const normalizedInflightRecord = normalizeInflightRecordLifecycle(
    inflightRecord,
    queuedRecord,
    options.now,
  );

  await storage.batch([
    { type: 'delete', key: KEYS.operationQueued(operationId) },
    {
      type: 'put',
      key: KEYS.operationInflight(operationId),
      value: encode(normalizedInflightRecord),
    },
  ]);
  return normalizedInflightRecord;
}

/** Write the initial inflight record (for tasks dispatched directly to a WS worker). */
export async function markInflight(storage: Storage, record: InflightRecord): Promise<void> {
  await storage.put(
    KEYS.operationInflight(record.operationId),
    encode(normalizeInflightRecordLifecycle(record)),
  );
}

/** Atomically transition a task from inflight → resolved. */
export async function transitionInflightToResolved(
  storage: Storage,
  operationId: string,
  status: 'completed' | 'failed',
  options: TransitionInflightToResolvedOptions = {},
): Promise<void> {
  const existingRecord = options.record ?? (await readInflightRecord(storage, operationId));
  const resolvedAt = options.resolvedAt ?? Date.now();
  const normalizedRecord =
    existingRecord === null
      ? null
      : normalizeInflightRecordLifecycle(existingRecord, null, resolvedAt);
  const resolutionReason =
    options.resolutionReason ?? (status === 'completed' ? 'completed' : 'failed');

  const resolvedRecord = buildResolvedRecord({
    operationId,
    status,
    resolvedAt,
    normalizedRecord,
    resolutionReason,
    value: options.value,
    error: options.error,
    queueLatencyMs:
      normalizedRecord === null ? undefined : calculateQueueLatencyMs(normalizedRecord),
    executionLatencyMs:
      normalizedRecord === null
        ? undefined
        : calculateExecutionLatencyMs(normalizedRecord, resolvedAt),
  });

  const encodedResolvedRecord = encode(resolvedRecord);
  await storage.batch([
    { type: 'delete', key: KEYS.operationInflight(operationId) },
    { type: 'put', key: KEYS.operationResolved(operationId), value: encodedResolvedRecord },
    {
      type: 'put',
      key: KEYS.operationResolvedByTime(resolvedAt, operationId),
      value: encodedResolvedRecord,
    },
  ]);
}

/** Atomically transition a task from inflight → queued (requeue on disconnect/timeout). */
export async function transitionInflightToQueued(
  storage: Storage,
  operationId: string,
  queuedRecord: QueuedRecord,
): Promise<void> {
  const inflightRecord = await readInflightRecord(storage, operationId);
  const normalizedQueuedRecord = normalizeQueuedRecordLifecycle(queuedRecord, inflightRecord);

  await storage.batch([
    { type: 'delete', key: KEYS.operationInflight(operationId) },
    { type: 'put', key: KEYS.operationQueued(operationId), value: encode(normalizedQueuedRecord) },
  ]);
}
