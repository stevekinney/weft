import { METRICS, type MetricsCollector } from '../../observability/metrics.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import type { TaskQueue } from '../task-queue.ts';
import {
  calculateExecutionLatencyMs,
  calculateQueueLatencyMs,
  isHeartbeatStale,
  type TaskTimingFields,
} from '../task-state.ts';

const DEFAULT_STALE_HEARTBEAT_METRIC_AFTER_MS = 60_000;

export function recordTaskBacklogMetric(
  metricsCollector: MetricsCollector | undefined,
  taskQueue: TaskQueue,
): void {
  metricsCollector?.gauge(METRICS.taskBacklog.name, taskQueue.totalPendingCount());
}

export function recordTaskQueueLatencyMetric(
  metricsCollector: MetricsCollector | undefined,
  record: TaskTimingFields,
): void {
  const latency = calculateQueueLatencyMs(record);
  if (latency !== undefined) {
    metricsCollector?.record(METRICS.taskQueueLatency.name, latency);
  }
}

export function recordTaskExecutionLatencyMetric(
  metricsCollector: MetricsCollector | undefined,
  record: TaskTimingFields,
  completedAt: number,
): void {
  const latency = calculateExecutionLatencyMs(record, completedAt);
  if (latency !== undefined) {
    metricsCollector?.record(METRICS.taskExecutionLatency.name, latency);
  }
}

export function recordTaskRetryMetric(
  metricsCollector: MetricsCollector | undefined,
  count: number = 1,
): void {
  metricsCollector?.increment(METRICS.taskRetries.name, count);
}

export function recordTaskRequeueMetric(
  metricsCollector: MetricsCollector | undefined,
  count: number = 1,
): void {
  metricsCollector?.increment(METRICS.taskRequeues.name, count);
}

export function isTaskHeartbeatStaleForMetrics(
  record: TaskTimingFields & { deadline?: number | undefined },
  currentTime: number,
  staleAfterMs: number = DEFAULT_STALE_HEARTBEAT_METRIC_AFTER_MS,
): boolean {
  return isHeartbeatStale(record, currentTime, staleAfterMs);
}

export function recordTaskStaleHeartbeatMetric(
  metricsCollector: MetricsCollector | undefined,
  count: number,
): void {
  metricsCollector?.gauge(METRICS.taskStaleHeartbeats.name, count);
}

export function recordWorkerCapacitySaturationMetric(
  metricsCollector: MetricsCollector | undefined,
  registry: WorkerRegistry,
): void {
  const workers = registry.getAll();
  const totalCapacity = workers.reduce((sum, worker) => sum + worker.concurrency, 0);
  const totalInFlight = workers.reduce((sum, worker) => sum + worker.inFlight, 0);
  const saturation = totalCapacity === 0 ? 0 : totalInFlight / totalCapacity;
  metricsCollector?.gauge(METRICS.workerCapacitySaturation.name, saturation);
}
