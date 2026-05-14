/**
 * Metric definitions for Weft observability.
 *
 * These constants describe the metrics emitted by Weft interceptors. They
 * follow OpenTelemetry semantic conventions where applicable, and can be
 * consumed by any metrics backend that accepts name/description/unit tuples.
 *
 * @module metrics
 */

import { METRICS } from './metrics-catalog.ts';
import type { MetricsSnapshot } from './metrics-snapshot.ts';
import type { OpenTelemetryMeter } from './no-op-telemetry';
import { getOpenTelemetryApi } from './no-op-telemetry';

export { METRICS } from './metrics-catalog.ts';
export type {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  MetricDefinition,
  MetricsSnapshot,
  MetricType,
} from './metrics-snapshot.ts';

// ---------------------------------------------------------------------------
// Circular buffer for bounded histogram storage
// ---------------------------------------------------------------------------

/**
 * Maximum number of samples retained per histogram name. Once exceeded, the
 * oldest sample is silently overwritten. This caps per-histogram memory at
 * ~80KB (10 000 × 8 bytes) regardless of load.
 */
const MAX_HISTOGRAM_SAMPLES = 10_000;

/**
 * Fixed-capacity circular buffer backed by a `Float64Array`. Overwrites the
 * oldest entry when full, keeping memory bounded under sustained load.
 */
class CircularBuffer {
  #buffer: Float64Array;
  #head = 0;
  #size = 0;

  constructor(capacity: number) {
    this.#buffer = new Float64Array(capacity);
  }

  push(value: number): void {
    this.#buffer[this.#head] = value;
    this.#head = (this.#head + 1) % this.#buffer.length;
    if (this.#size < this.#buffer.length) this.#size++;
  }

  /** Return all stored values in insertion order (oldest first). */
  toArray(): number[] {
    if (this.#size < this.#buffer.length) {
      return Array.from(this.#buffer.subarray(0, this.#size));
    }
    // Buffer is full — oldest entry is at #head, newest at #head - 1.
    const result = Array.from<number>({ length: this.#size });
    for (let i = 0; i < this.#size; i++) {
      result[i] = this.#buffer[(this.#head + i) % this.#buffer.length]!;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Metrics collector
// ---------------------------------------------------------------------------

/**
 * Collects counters, histograms, and gauges for Weft observability.
 *
 * Single-threaded — each worker constructs its own collector; concurrent
 * `record()`/`increment()` calls from the same isolate do not require locking.
 * Call {@link snapshot} to read all collected values and {@link reset} to
 * clear them.
 *
 * @example
 * ```ts
 * import { MetricsCollector } from 'weft/observability';
 *
 * const collector = new MetricsCollector();
 * collector.increment('weft.workflow.started');
 * collector.record('weft.workflow.duration', 42);
 * console.log(collector.snapshot());
 * ```
 */
export class MetricsCollector {
  #counters: Map<string, number>;
  #histograms: Map<string, CircularBuffer>;
  #gauges: Map<string, number>;

  constructor() {
    this.#counters = new Map();
    this.#histograms = new Map();
    this.#gauges = new Map();
  }

  /** Increment a counter by `value` (default 1). */
  increment(name: string, value: number = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + value);
  }

  /** Record a histogram observation. Values are kept in a circular buffer capped at {@link MAX_HISTOGRAM_SAMPLES}. */
  record(name: string, value: number): void {
    let buffer = this.#histograms.get(name);
    if (!buffer) {
      buffer = new CircularBuffer(MAX_HISTOGRAM_SAMPLES);
      this.#histograms.set(name, buffer);
    }
    buffer.push(value);
  }

  /** Set an absolute gauge value. */
  gauge(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  /** Return a point-in-time snapshot of all collected metrics. */
  snapshot(): MetricsSnapshot {
    const result: MetricsSnapshot = {};

    for (const [name, count] of this.#counters) {
      result[name] = { type: 'counter', value: count };
    }

    for (const [name, buffer] of this.#histograms) {
      const values = buffer.toArray();
      const sorted = sortNumbersAscending(values);
      result[name] = {
        type: 'histogram',
        count: values.length,
        sum: sumNumbers(values),
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
      };
    }

    for (const [name, value] of this.#gauges) {
      result[name] = { type: 'gauge', value };
    }

    return result;
  }

  /** Clear all collected metrics. */
  reset(): void {
    this.#counters.clear();
    this.#histograms.clear();
    this.#gauges.clear();
  }
}

// ---------------------------------------------------------------------------
// OpenTelemetry metrics bridge
// ---------------------------------------------------------------------------

/**
 * OpenTelemetry instrument set for Weft metrics.
 *
 * @example
 * ```ts
 * import { createOpenTelemetryMetrics, type OpenTelemetryMetrics } from 'weft/observability';
 *
 * const openTelemetryMetrics: OpenTelemetryMetrics = createOpenTelemetryMetrics('my-service');
 * openTelemetryMetrics.workflowDuration.record(120);
 * openTelemetryMetrics.activityAttempts.add(1);
 * ```
 */
export type OpenTelemetryMetrics = {
  workflowDuration: {
    record(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
  activityDuration: {
    record(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
  activityAttempts: {
    add(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
  activeWorkflows: {
    add(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
};

/**
 * Create OpenTelemetry instruments for the standard Weft metrics.
 *
 * Accepts an `OpenTelemetryMeter` instance, a string meter name, or nothing. When
 * called without arguments it uses `getOpenTelemetryApi().metrics.getMeter('weft')`,
 * which returns a no-op meter when `@opentelemetry/api` is not installed.
 *
 * @example
 * ```ts
 * import { createOpenTelemetryMetrics } from 'weft/observability';
 *
 * // Uses the auto-detected OpenTelemetry API or no-op fallback
 * const instruments = createOpenTelemetryMetrics('my-service');
 * instruments.workflowDuration.record(250, { workflow_type: 'greet' });
 * instruments.activityAttempts.add(1, { activity: 'sendEmail' });
 * ```
 */
export function createOpenTelemetryMetrics(
  meterOrName?: OpenTelemetryMeter | string,
): OpenTelemetryMetrics {
  let meter: OpenTelemetryMeter;
  if (typeof meterOrName === 'string') {
    meter = getOpenTelemetryApi().metrics.getMeter(meterOrName);
  } else if (meterOrName) {
    meter = meterOrName;
  } else {
    meter = getOpenTelemetryApi().metrics.getMeter('weft');
  }

  return {
    workflowDuration: meter.createHistogram('weft.workflow.duration', { unit: 'ms' }),
    activityDuration: meter.createHistogram('weft.activity.duration', { unit: 'ms' }),
    activityAttempts: meter.createCounter('weft.activity.attempts'),
    activeWorkflows: meter.createUpDownCounter('weft.workflow.active'),
  };
}

function sortNumbersAscending(values: number[]): number[] {
  const sorted = [...values];
  sorted.sort((left, right) => left - right);
  return sorted;
}

function sumNumbers(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Prometheus exporter
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for producing Prometheus text-format output at
 * `/v1/metrics`. Weft ships with a default implementation that serializes a
 * {@link MetricsCollector} snapshot, but consumers who already use OpenTelemetry can
 * adapt `@opentelemetry/exporter-prometheus` (or any other source) to this
 * interface and pass it via `HandlerOptions.prometheusExporter`.
 *
 * Keeping this as an interface rather than hard-wiring the OpenTelemetry SDK avoids
 * pulling `@opentelemetry/sdk-metrics` into the runtime footprint while still
 * giving projects that *do* want full OpenTelemetry a clean plug point.
 *
 * > [!WARNING] `/v1/metrics` is unauthenticated by default
 * > The Weft server treats `/v1/metrics` as a public path (see
 * > `DEFAULT_PUBLIC_PATHS` in `src/server/authentication.ts`) so that
 * > Prometheus scrapers can read it without credentials. The default
 * > {@link createMetricsCollectorExporter} only emits aggregate counters and
 * > histograms with no labels, which is safe to expose. **A custom
 * > `PrometheusExporter` that emits labels — especially labels containing
 * > tenant identifiers, user identifiers, request paths with IDs, or any
 * > other PII — will leak that data to anyone who can reach the endpoint.**
 * >
 * > If your exporter emits sensitive labels, override the default by setting
 * > `auth.publicPaths` on the server options to a list that does *not*
 * > include `/v1/metrics`, then scrape it with an authenticated client.
 */
export interface PrometheusExporter {
  /**
   * Produce Prometheus text-format output for the current state of the metrics
   * source. Must be safe to call repeatedly — each invocation should reflect
   * the latest values.
   */
  serialize(): string | Promise<string>;
}

/**
 * Serialize a {@link MetricsSnapshot} as Prometheus text format using the
 * definitions registered in {@link METRICS}. Metrics that aren't in the
 * snapshot still emit their `# HELP` / `# TYPE` lines with zero values so
 * Prometheus scrapers see a stable schema.
 *
 * @example
 * ```ts
 * import { MetricsCollector, serializeMetricsSnapshotForPrometheus } from 'weft/observability';
 *
 * const collector = new MetricsCollector();
 * collector.increment('weft.workflow.started');
 * const body = serializeMetricsSnapshotForPrometheus(collector.snapshot());
 * console.log(body.includes('weft_workflow_started_total'));
 * ```
 */
// oxlint-disable-next-line complexity -- ID:observability-metrics-serialize-metrics-snapshot-for-prometheus-complexity
export function serializeMetricsSnapshotForPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const metric of Object.values(METRICS)) {
    const safeName = metric.name.replace(/\./g, '_');
    const collected = snapshot[metric.name];

    lines.push(`# HELP ${safeName} ${metric.description}`);

    if (metric.type === 'histogram') {
      lines.push(`# TYPE ${safeName} histogram`);
      const count = collected?.type === 'histogram' ? collected.count : 0;
      const sum = collected?.type === 'histogram' ? collected.sum : 0;
      lines.push(`${safeName}_count ${count}`);
      lines.push(`${safeName}_sum ${sum}`);
    } else if (metric.type === 'counter') {
      lines.push(`# TYPE ${safeName} counter`);
      const value = collected?.type === 'counter' ? collected.value : 0;
      lines.push(`${safeName}_total ${value}`);
    } else {
      lines.push(`# TYPE ${safeName} gauge`);
      const value = collected?.type === 'gauge' ? collected.value : 0;
      lines.push(`${safeName} ${value}`);
    }
  }

  // Derived DPMO gauge: (defects / operations) * 1_000_000
  const dpmoDefectsEntry = snapshot[METRICS.dpmoDefects.name];
  const dpmoOperationsEntry = snapshot[METRICS.dpmoOperations.name];
  const dpmoDefects = dpmoDefectsEntry?.type === 'counter' ? dpmoDefectsEntry.value : 0;
  const dpmoOperations = dpmoOperationsEntry?.type === 'counter' ? dpmoOperationsEntry.value : 0;
  const dpmoValue = dpmoOperations === 0 ? 0 : (dpmoDefects * 1_000_000) / dpmoOperations;
  const dpmoGaugeName = 'weft_dpmo';
  lines.push(
    `# HELP ${dpmoGaugeName} Defects per million operations (failed workflows / started workflows * 1e6)`,
  );
  lines.push(`# TYPE ${dpmoGaugeName} gauge`);
  lines.push(`${dpmoGaugeName} ${dpmoValue}`);

  return lines.join('\n') + '\n';
}

/**
 * Default {@link PrometheusExporter} that sources its values from a
 * {@link MetricsCollector}. Equivalent to the previous inline serializer in
 * the server's `/v1/metrics` handler — extracted here so it can be reused and
 * so a custom implementation can be substituted without touching the server.
 *
 * @example
 * ```ts
 * import { createMetricsCollectorExporter } from 'weft/observability';
 *
 * const exporter = createMetricsCollectorExporter(undefined);
 * // Pass to serve() to expose /v1/metrics
 * // serve({ engine, prometheusExporter: exporter });
 * console.log(typeof exporter.serialize); // 'function'
 * ```
 */
export function createMetricsCollectorExporter(
  collector: MetricsCollector | undefined,
): PrometheusExporter {
  return {
    serialize(): string {
      const snapshot = collector?.snapshot() ?? {};
      return serializeMetricsSnapshotForPrometheus(snapshot);
    },
  };
}
