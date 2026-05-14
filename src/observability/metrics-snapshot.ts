/**
 * Public metric snapshot types for Weft observability.
 *
 * @module metrics-snapshot
 */

/**
 * Metric aggregation kind used by the Weft metrics catalogue.
 *
 * @example
 * ```ts
 * import type { MetricType } from 'weft/observability';
 *
 * const metricType: MetricType = 'histogram';
 * console.log(metricType);
 * ```
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Static metadata that describes a metric emitted by Weft.
 *
 * @example
 * ```ts
 * import { METRICS, type MetricDefinition } from 'weft/observability';
 *
 * const workflowDuration: MetricDefinition = METRICS.workflowDuration;
 * console.log(workflowDuration.name, workflowDuration.unit);
 * ```
 */
export interface MetricDefinition {
  name: string;
  description: string;
  unit: string;
  type: MetricType;
}

/**
 * Snapshot entry for a monotonically increasing counter.
 *
 * @example
 * ```ts
 * import type { CounterMetric } from 'weft/observability';
 *
 * const startedWorkflows: CounterMetric = { type: 'counter', value: 12 };
 * console.log(startedWorkflows.value);
 * ```
 */
export type CounterMetric = { type: 'counter'; value: number };

/**
 * Snapshot entry for a histogram with summary percentiles.
 *
 * @example
 * ```ts
 * import type { HistogramMetric } from 'weft/observability';
 *
 * const duration: HistogramMetric = {
 *   type: 'histogram',
 *   count: 3,
 *   sum: 90,
 *   p50: 30,
 *   p99: 40,
 *   min: 20,
 *   max: 40,
 * };
 * console.log(duration.p99);
 * ```
 */
export type HistogramMetric = {
  type: 'histogram';
  count: number;
  sum: number;
  p50: number;
  p99: number;
  min: number;
  max: number;
};

/**
 * Snapshot entry for an absolute gauge value.
 *
 * @example
 * ```ts
 * import type { GaugeMetric } from 'weft/observability';
 *
 * const activeWorkflows: GaugeMetric = { type: 'gauge', value: 2 };
 * console.log(activeWorkflows.value);
 * ```
 */
export type GaugeMetric = { type: 'gauge'; value: number };

/**
 * Point-in-time values collected by a metrics collector.
 *
 * @example
 * ```ts
 * import { MetricsCollector, type MetricsSnapshot } from 'weft/observability';
 *
 * const collector = new MetricsCollector();
 * collector.increment('weft.workflow.started');
 * const snapshot: MetricsSnapshot = collector.snapshot();
 * console.log(snapshot['weft.workflow.started']);
 * ```
 */
export type MetricsSnapshot = Record<string, CounterMetric | HistogramMetric | GaugeMetric>;
