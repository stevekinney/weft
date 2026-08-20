/**
 * Lifecycle vocabulary and timing calculators shared by the durable task
 * ledger and its diagnostics/metrics consumers.
 *
 * The `op:queued:`/`op:inflight:`/`op:resolved:`/`op:dead-letter:` record
 * shapes and type guards this module once exported alongside these
 * calculators are gone: WFT-22 replaced the key scheme with the durable
 * task ledger (`task-ledger.ts`), and WFT-24 migrated `get-task-diagnostics.ts`
 * (the last production reader of those legacy shapes) onto the ledger.
 * What remains is still load-bearing: `TaskLifecycleFields` and
 * `TaskRequeueReason` back the ledger's own record types, and the
 * queue-latency, execution-latency, and heartbeat-staleness calculators
 * back `task-metrics.ts` and the ledger diagnostics.
 *
 * @module task-state
 */

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

/** Why a task was requeued before another dispatch attempt. */
export type TaskRequeueReason = 'visibility-timeout' | 'worker-disconnect';

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
// Timing calculators
// ---------------------------------------------------------------------------

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
