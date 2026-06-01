/**
 * Observability interceptors for Weft workflows and activities.
 *
 * Creates an {@link Interceptor} implementation that propagates W3C trace
 * context, emits OpenTelemetry spans, and records metrics. When
 * `@opentelemetry/api` is not installed, all span operations are no-ops with
 * zero overhead.
 *
 * @module observability
 */

import type { Interceptor } from '../core/interceptor';
import { buildActivityInterceptor } from './activity-interceptor';
import { MetricsCollector as MetricsCollectorClass } from './metrics';
import { getOpenTelemetryApi } from './no-op-telemetry';
import { DEFAULT_MAX_PAYLOAD_SIZE } from './span-helpers';
import type { ObservabilityOptions, ObservabilityState } from './types';
import { buildWorkflowInterceptor } from './workflow-interceptor';
import { createWorkflowLifecycle } from './workflow-lifecycle';

export {
  createMetricsCollectorExporter,
  createOpenTelemetryMetrics,
  METRICS,
  MetricsCollector,
  serializeMetricsSnapshotForPrometheus,
} from './metrics';
export type {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  MetricDefinition,
  MetricsSnapshot,
  MetricType,
  OpenTelemetryMetrics,
  PrometheusExporter,
} from './metrics';
export { getOpenTelemetryApi } from './no-op-telemetry';
export type {
  OpenTelemetryApi,
  OpenTelemetryMeter,
  OpenTelemetrySpan,
  OpenTelemetryTracer,
} from './no-op-telemetry';
export {
  extractTraceParent,
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  injectTraceParent,
  parseTraceParent,
} from './propagation';
export type { TraceContext } from './propagation';
export type { InterceptionContext, ObservabilityOptions } from './types';

function createObservabilityState(options?: ObservabilityOptions): ObservabilityState {
  const {
    attributeExtractor,
    eventTarget,
    maxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE,
    metrics = new MetricsCollectorClass(),
    openTelemetryApi = getOpenTelemetryApi(),
    recordPayloads = false,
    tracerName = 'weft',
    tracerVersion,
  } = options ?? {};
  const api = openTelemetryApi;
  const { trace, SpanStatusCode } = api;
  const tracer = trace.getTracer(tracerName, tracerVersion);

  return {
    api,
    trace,
    SpanStatusCode,
    tracer,
    recordPayloads,
    maxPayloadSize,
    attributeExtractor,
    eventTarget,
    metrics,
    workflowSpans: new Map(),
  };
}

/**
 * Create a unified interceptor for workflow and activity observability.
 *
 * Uses `@opentelemetry/api` directly for span creation. When the package is
 * not installed, falls back to no-op implementations with zero overhead.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, createObservabilityInterceptors } from '@lostgradient/weft';
 *
 * const { interceptor, metrics } = createObservabilityInterceptors({
 *   tracerName: 'my-app',
 *   recordPayloads: false,
 * });
 * await using engine = new Engine({
 *   storage: new MemoryStorage(),
 * });
 * engine.addInterceptor(interceptor);
 * void metrics;
 * ```
 */
export function createObservabilityInterceptors(options?: ObservabilityOptions): {
  interceptor: Interceptor;
  metrics: MetricsCollectorClass;
  /**
   * End the workflow root span. Usually wired automatically via `eventTarget`,
   * but exposed for callers that need to end spans manually.
   */
  endWorkflowSpan: (workflowId: string, status: 'ok' | 'error', errorMessage?: string) => void;
  /**
   * Evict workflow spans that have been open longer than `maxAgeMs` (default: 1 hour).
   * Call periodically to prevent unbounded growth from orphaned or long-running workflows.
   */
  evictStaleSpans: (maxAgeMs?: number) => number;
  /**
   * Unsubscribe any workflow lifecycle listeners registered on the `eventTarget`
   * and end any still-open workflow spans.
   */
  dispose: () => void;
} {
  const state = createObservabilityState(options);
  const workflow = buildWorkflowInterceptor(state);
  const activity = buildActivityInterceptor(state);
  const interceptor: Interceptor = { ...workflow, ...activity };
  const lifecycle = createWorkflowLifecycle(state);

  return { interceptor, metrics: state.metrics, ...lifecycle };
}
