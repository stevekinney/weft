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

// ---------------------------------------------------------------------------
// Task state type
// ---------------------------------------------------------------------------

/** The three exclusive states a dispatched task can occupy. */
export type TaskState = 'queued' | 'inflight' | 'resolved';

// ---------------------------------------------------------------------------
// Record types stored at each key
// ---------------------------------------------------------------------------

/** Persisted record for a task in the queued state. */
export interface QueuedRecord {
  operationId: string;
  activityName: string;
  input: unknown;
  queue: string;
  attempt: number;
  visibilityTimeout: number;
  retryPolicy?: RetryPolicy | undefined;
  queuedAt: number;
}

/** Persisted record for a task in the inflight state. */
export interface InflightRecord {
  operationId: string;
  workerId: string;
  deadline: number;
  activityName: string;
  queue: string;
  input: unknown;
  attempt: number;
  visibilityTimeout: number;
  retryPolicy?: RetryPolicy | undefined;
}

/** Persisted record for a task in the resolved state. */
export interface ResolvedRecord {
  operationId: string;
  status: 'completed' | 'failed';
  resolvedAt: number;
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
// State transitions (atomic batch operations)
// ---------------------------------------------------------------------------

/** Write the initial queued record for a newly dispatched task. */
export async function markQueued(storage: Storage, record: QueuedRecord): Promise<void> {
  await storage.put(KEYS.operationQueued(record.operationId), encode(record));
}

/** Atomically transition a task from queued → inflight. */
export async function transitionQueuedToInflight(
  storage: Storage,
  operationId: string,
  inflightRecord: InflightRecord,
): Promise<void> {
  await storage.batch([
    { type: 'delete', key: KEYS.operationQueued(operationId) },
    { type: 'put', key: KEYS.operationInflight(operationId), value: encode(inflightRecord) },
  ]);
}

/** Write the initial inflight record (for tasks dispatched directly to a WS worker). */
export async function markInflight(storage: Storage, record: InflightRecord): Promise<void> {
  await storage.put(KEYS.operationInflight(record.operationId), encode(record));
}

/** Atomically transition a task from inflight → resolved. */
export async function transitionInflightToResolved(
  storage: Storage,
  operationId: string,
  status: 'completed' | 'failed',
): Promise<void> {
  const resolvedRecord: ResolvedRecord = {
    operationId,
    status,
    resolvedAt: Date.now(),
  };

  await storage.batch([
    { type: 'delete', key: KEYS.operationInflight(operationId) },
    { type: 'put', key: KEYS.operationResolved(operationId), value: encode(resolvedRecord) },
  ]);
}

/** Atomically transition a task from inflight → queued (requeue on disconnect/timeout). */
export async function transitionInflightToQueued(
  storage: Storage,
  operationId: string,
  queuedRecord: QueuedRecord,
): Promise<void> {
  await storage.batch([
    { type: 'delete', key: KEYS.operationInflight(operationId) },
    { type: 'put', key: KEYS.operationQueued(operationId), value: encode(queuedRecord) },
  ]);
}

/** Read the inflight record for a task. */
export async function readInflightRecord(
  storage: Storage,
  operationId: string,
): Promise<InflightRecord | null> {
  const raw = await storage.get(KEYS.operationInflight(operationId));
  if (raw === null) return null;
  return decode(raw) as InflightRecord;
}

/** Read the queued record for a task. */
export async function readQueuedRecord(
  storage: Storage,
  operationId: string,
): Promise<QueuedRecord | null> {
  const raw = await storage.get(KEYS.operationQueued(operationId));
  if (raw === null) return null;
  return decode(raw) as QueuedRecord;
}
