/**
 * Metric catalogue for Weft observability.
 *
 * @module metrics-catalog
 */

import type { MetricDefinition } from './metrics-snapshot.ts';

/**
 * Metric names and descriptions for Weft observability.
 *
 * @example
 * ```ts
 * import { METRICS } from '@lostgradient/weft/observability';
 *
 * for (const metric of Object.values(METRICS)) {
 *   console.log(metric.name, metric.type, metric.unit);
 * }
 * // e.g. 'weft.workflow.duration' 'histogram' 'ms'
 * ```
 */
export const METRICS = {
  workflowDuration: {
    name: 'weft.workflow.duration',
    description: 'Duration of workflow execution in milliseconds',
    unit: 'ms',
    type: 'histogram',
  },
  activityDuration: {
    name: 'weft.activity.duration',
    description: 'Duration of activity execution in milliseconds',
    unit: 'ms',
    type: 'histogram',
  },
  activityAttempts: {
    name: 'weft.activity.attempts',
    description: 'Total activity execution attempts',
    unit: 'attempts',
    type: 'counter',
  },
  workflowActive: {
    name: 'weft.workflow.active',
    description: 'Number of currently active workflows',
    unit: 'workflows',
    type: 'gauge',
  },
  workflowStarted: {
    name: 'weft.workflow.started',
    description: 'Total workflows started',
    unit: 'workflows',
    type: 'counter',
  },
  workflowCompleted: {
    name: 'weft.workflow.completed',
    description: 'Total workflows completed',
    unit: 'workflows',
    type: 'counter',
  },
  workflowFailed: {
    name: 'weft.workflow.failed',
    description: 'Total workflows failed',
    unit: 'workflows',
    type: 'counter',
  },
  promptCacheHits: {
    name: 'weft.prompt_cache.hits',
    description: 'Total prompt prefix cache hits',
    unit: 'hits',
    type: 'counter',
  },
  promptCacheMisses: {
    name: 'weft.prompt_cache.misses',
    description: 'Total prompt prefix cache misses',
    unit: 'misses',
    type: 'counter',
  },
  dpmoDefects: {
    name: 'weft.dpmo.defects',
    description: 'Total failed workflows (DPMO numerator)',
    unit: 'workflows',
    type: 'counter',
  },
  dpmoOperations: {
    name: 'weft.dpmo.operations',
    description: 'Total started workflows (DPMO denominator)',
    unit: 'workflows',
    type: 'counter',
  },
  taskBacklog: {
    name: 'weft.task.backlog',
    description: 'Number of queued tasks waiting for workers',
    unit: 'tasks',
    type: 'gauge',
  },
  taskQueueLatency: {
    name: 'weft.task.queue_latency',
    description: 'Time tasks spend queued before dispatch in milliseconds',
    unit: 'ms',
    type: 'histogram',
  },
  taskExecutionLatency: {
    name: 'weft.task.execution_latency',
    description: 'Time tasks spend executing after worker start in milliseconds',
    unit: 'ms',
    type: 'histogram',
  },
  taskRetries: {
    name: 'weft.task.retries',
    description: 'Total task retry attempts after the first dispatch attempt',
    unit: 'retries',
    type: 'counter',
  },
  taskRequeues: {
    name: 'weft.task.requeues',
    description: 'Total visibility-timeout or disconnect task requeues',
    unit: 'requeues',
    type: 'counter',
  },
  taskStaleHeartbeats: {
    name: 'weft.task.stale_heartbeats',
    description: 'Number of in-flight tasks whose heartbeat age exceeds the diagnostic threshold',
    unit: 'tasks',
    type: 'gauge',
  },
  workerCapacitySaturation: {
    name: 'weft.worker.capacity_saturation',
    description: 'Ratio of in-flight worker slots to total worker concurrency',
    unit: 'ratio',
    type: 'gauge',
  },
} as const satisfies Record<string, MetricDefinition>;
