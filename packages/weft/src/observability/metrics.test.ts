import { describe, expect, it } from 'bun:test';

import type { MetricDefinition, PrometheusExporter } from './metrics';
import {
  METRICS,
  MetricsCollector,
  createMetricsCollectorExporter,
  createOpenTelemetryMetrics,
  serializeMetricsSnapshotForPrometheus,
} from './metrics';
import type { OpenTelemetryMeter } from './no-op-telemetry';

describe('metrics', () => {
  const entries = Object.entries(METRICS) as [string, MetricDefinition][];

  it('all metrics have required fields', () => {
    for (const [key, metric] of entries) {
      expect(metric.name).toBeString();
      expect(metric.description).toBeString();
      expect(metric.unit).toBeString();
      expect(metric.type).toBeString();
      // Verify the fields are non-empty
      expect(metric.name.length).toBeGreaterThan(0);
      expect(metric.description.length).toBeGreaterThan(0);
      expect(metric.unit.length).toBeGreaterThan(0);
      expect(metric.type.length).toBeGreaterThan(0);
      // key should be a non-empty string
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('metric names start with "weft."', () => {
    for (const [, metric] of entries) {
      expect(metric.name.startsWith('weft.')).toBe(true);
    }
  });

  it('each metric has a valid type', () => {
    const validTypes = new Set(['counter', 'gauge', 'histogram']);
    for (const [, metric] of entries) {
      expect(validTypes.has(metric.type)).toBe(true);
    }
  });
});

describe('MetricsCollector', () => {
  describe('counters', () => {
    it('increments a counter by 1 by default', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.workflow.started');
      collector.increment('weft.workflow.started');

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.started'];
      expect(metric).toBeDefined();
      expect(metric!.type).toBe('counter');
      expect(metric!.type === 'counter' && metric!.value).toBe(2);
    });

    it('increments a counter by a specified value', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.activity.attempts', 5);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.activity.attempts'];
      expect(metric).toBeDefined();
      expect(metric!.type === 'counter' && metric!.value).toBe(5);
    });

    it('tracks multiple counters independently', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.workflow.started');
      collector.increment('weft.workflow.completed');
      collector.increment('weft.workflow.started');

      const snapshot = collector.snapshot();
      expect(
        snapshot['weft.workflow.started']!.type === 'counter' &&
          snapshot['weft.workflow.started']!.value,
      ).toBe(2);
      expect(
        snapshot['weft.workflow.completed']!.type === 'counter' &&
          snapshot['weft.workflow.completed']!.value,
      ).toBe(1);
    });
  });

  describe('histograms', () => {
    it('records histogram values and computes percentiles', () => {
      const collector = new MetricsCollector();
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const value of values) {
        collector.record('weft.workflow.duration', value);
      }

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.duration'];
      expect(metric).toBeDefined();
      expect(metric!.type).toBe('histogram');

      if (metric!.type === 'histogram') {
        expect(metric!.count).toBe(10);
        expect(metric!.sum).toBe(550);
        expect(metric!.min).toBe(10);
        expect(metric!.max).toBe(100);
        expect(metric!.p50).toBe(60); // sorted[5]
        expect(metric!.p99).toBe(100); // sorted[9]
      }
    });

    it('handles a single histogram observation', () => {
      const collector = new MetricsCollector();
      collector.record('weft.activity.duration', 42);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.activity.duration'];
      expect(metric).toBeDefined();

      if (metric!.type === 'histogram') {
        expect(metric!.count).toBe(1);
        expect(metric!.sum).toBe(42);
        expect(metric!.min).toBe(42);
        expect(metric!.max).toBe(42);
        expect(metric!.p50).toBe(42);
        expect(metric!.p99).toBe(42);
      }
    });

    it('keeps only the newest histogram samples once the circular buffer is full', () => {
      const collector = new MetricsCollector();

      for (let value = 1; value <= 10_005; value += 1) {
        collector.record('weft.workflow.duration', value);
      }

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.duration'];

      expect(metric).toBeDefined();
      expect(metric!.type).toBe('histogram');

      if (!metric || metric.type !== 'histogram') {
        throw new Error('expected histogram metric');
      }

      expect(metric.count).toBe(10_000);
      expect(metric.min).toBe(6);
      expect(metric.max).toBe(10_005);
      expect(metric.sum).toBe(50_055_000);
    });
  });

  describe('gauges', () => {
    it('tracks a gauge value', () => {
      const collector = new MetricsCollector();
      collector.gauge('weft.workflow.active', 5);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.active'];
      expect(metric).toBeDefined();
      expect(metric!.type).toBe('gauge');
      expect(metric!.type === 'gauge' && metric!.value).toBe(5);
    });

    it('overwrites gauge with the latest value', () => {
      const collector = new MetricsCollector();
      collector.gauge('weft.workflow.active', 5);
      collector.gauge('weft.workflow.active', 3);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.active'];
      expect(metric!.type === 'gauge' && metric!.value).toBe(3);
    });
  });

  describe('snapshot', () => {
    it('returns all collected metrics across types', () => {
      const collector = new MetricsCollector();
      collector.increment('counter-a');
      collector.record('histogram-a', 10);
      collector.gauge('gauge-a', 7);

      const snapshot = collector.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(3);
      expect(snapshot['counter-a']!.type).toBe('counter');
      expect(snapshot['histogram-a']!.type).toBe('histogram');
      expect(snapshot['gauge-a']!.type).toBe('gauge');
    });

    it('returns an empty object when nothing has been collected', () => {
      const collector = new MetricsCollector();
      const snapshot = collector.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('clears all counters, histograms, and gauges', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.workflow.started');
      collector.record('weft.workflow.duration', 100);
      collector.gauge('weft.workflow.active', 2);

      collector.reset();

      const snapshot = collector.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// createOpenTelemetryMetrics
// ---------------------------------------------------------------------------

/** Build a recording meter that captures all instrument creation and calls. */
function createRecordingMeter(): {
  meter: OpenTelemetryMeter;
  created: Array<{ type: string; name: string; options?: { unit?: string } }>;
  recordings: Array<{
    instrument: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }>;
} {
  const created: Array<{ type: string; name: string; options?: { unit?: string } }> = [];
  const recordings: Array<{
    instrument: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];

  const meter: OpenTelemetryMeter = {
    createHistogram(name: string, options?: { unit?: string }) {
      created.push({ type: 'histogram', name, ...(options ? { options } : {}) });
      return {
        record(value: number, attributes?: Record<string, string | number | boolean>) {
          recordings.push({ instrument: name, value, ...(attributes ? { attributes } : {}) });
        },
      };
    },
    createCounter(name: string, options?: { unit?: string }) {
      created.push({ type: 'counter', name, ...(options ? { options } : {}) });
      return {
        add(value: number, attributes?: Record<string, string | number | boolean>) {
          recordings.push({ instrument: name, value, ...(attributes ? { attributes } : {}) });
        },
      };
    },
    createUpDownCounter(name: string, options?: { unit?: string }) {
      created.push({ type: 'upDownCounter', name, ...(options ? { options } : {}) });
      return {
        add(value: number, attributes?: Record<string, string | number | boolean>) {
          recordings.push({ instrument: name, value, ...(attributes ? { attributes } : {}) });
        },
      };
    },
  };

  return { meter, created, recordings };
}

describe('createOpenTelemetryMetrics', () => {
  it('creates the expected OpenTelemetry instruments when given a meter', () => {
    const { meter, created } = createRecordingMeter();
    const openTelemetryMetrics = createOpenTelemetryMetrics(meter);

    expect(openTelemetryMetrics).toBeDefined();
    expect(openTelemetryMetrics.workflowDuration).toBeDefined();
    expect(openTelemetryMetrics.activityDuration).toBeDefined();
    expect(openTelemetryMetrics.activityAttempts).toBeDefined();
    expect(openTelemetryMetrics.activeWorkflows).toBeDefined();

    const names = created.map((c) => c.name);
    expect(names).toContain('weft.workflow.duration');
    expect(names).toContain('weft.activity.duration');
    expect(names).toContain('weft.activity.attempts');
    expect(names).toContain('weft.workflow.active');
  });

  it('creates histograms with correct units', () => {
    const { meter, created } = createRecordingMeter();
    createOpenTelemetryMetrics(meter);

    const workflowDuration = created.find((c) => c.name === 'weft.workflow.duration');
    expect(workflowDuration).toBeDefined();
    expect(workflowDuration!.options?.unit).toBe('ms');

    const activityDuration = created.find((c) => c.name === 'weft.activity.duration');
    expect(activityDuration).toBeDefined();
    expect(activityDuration!.options?.unit).toBe('ms');
  });

  it('instruments are callable', () => {
    const { meter, recordings } = createRecordingMeter();
    const openTelemetryMetrics = createOpenTelemetryMetrics(meter);

    openTelemetryMetrics.workflowDuration.record(150);
    openTelemetryMetrics.activityDuration.record(42);
    openTelemetryMetrics.activityAttempts.add(1);
    openTelemetryMetrics.activeWorkflows.add(1);
    openTelemetryMetrics.activeWorkflows.add(-1);

    expect(recordings).toHaveLength(5);
    expect(recordings[0]!.instrument).toBe('weft.workflow.duration');
    expect(recordings[0]!.value).toBe(150);
  });

  it('uses the no-op meter when called without arguments', () => {
    // Should not throw even without @opentelemetry/api installed
    const openTelemetryMetrics = createOpenTelemetryMetrics();
    expect(openTelemetryMetrics).toBeDefined();
    expect(() => openTelemetryMetrics.workflowDuration.record(100)).not.toThrow();
    expect(() => openTelemetryMetrics.activityAttempts.add(1)).not.toThrow();
  });

  it('accepts a string meter name', () => {
    // Should use getOpenTelemetryApi().metrics.getMeter(name) under the hood
    const openTelemetryMetrics = createOpenTelemetryMetrics('my-service');
    expect(openTelemetryMetrics).toBeDefined();
    expect(() => openTelemetryMetrics.workflowDuration.record(100)).not.toThrow();
  });
});

describe('Prometheus exporter', () => {
  it('serializes a MetricsCollector snapshot into Prometheus text format', () => {
    const collector = new MetricsCollector();
    collector.increment('weft.workflow.started', 3);
    collector.record('weft.workflow.duration', 120);
    collector.record('weft.workflow.duration', 180);
    collector.gauge('weft.workflow.active', 2);

    const exporter = createMetricsCollectorExporter(collector);
    const text = exporter.serialize() as string;

    // Dots must be normalized to underscores per Prometheus naming rules.
    expect(text).toContain('# TYPE weft_workflow_started counter');
    expect(text).toContain('weft_workflow_started_total 3');
    expect(text).toContain('# TYPE weft_workflow_duration histogram');
    expect(text).toContain('weft_workflow_duration_count 2');
    expect(text).toContain('weft_workflow_duration_sum 300');
    expect(text).toContain('# TYPE weft_workflow_active gauge');
    expect(text).toContain('weft_workflow_active 2');
  });

  it('emits zero values for metrics not present in the snapshot', () => {
    const exporter = createMetricsCollectorExporter(undefined);
    const text = exporter.serialize() as string;
    for (const metric of Object.values(METRICS)) {
      const safeName = metric.name.replace(/\./g, '_');
      expect(text).toContain(`# HELP ${safeName} ${metric.description}`);
    }
  });

  it('is pluggable — any PrometheusExporter implementation works', () => {
    const custom: PrometheusExporter = {
      serialize() {
        return '# HELP custom 1\n# TYPE custom gauge\ncustom 1\n';
      },
    };
    expect(custom.serialize()).toContain('custom 1');
  });

  it('emits weft_dpmo gauge as (defects / operations) * 1e6', () => {
    const collector = new MetricsCollector();
    // 3 defects out of 10 operations = 300000 DPMO
    collector.increment('weft.dpmo.defects', 3);
    collector.increment('weft.dpmo.operations', 10);

    const text = serializeMetricsSnapshotForPrometheus(collector.snapshot());

    expect(text).toContain('weft_dpmo 300000');
    expect(text).toContain('weft_dpmo_defects_total 3');
    expect(text).toContain('weft_dpmo_operations_total 10');
  });

  it('serializes weft_dpmo without introducing avoidable decimal artifacts', () => {
    const collector = new MetricsCollector();
    collector.increment('weft.dpmo.defects', 3);
    collector.increment('weft.dpmo.operations', 10);

    const text = serializeMetricsSnapshotForPrometheus(collector.snapshot());
    const dpmoLine = text.split('\n').find((line) => line.startsWith('weft_dpmo '));

    expect(dpmoLine).toBe('weft_dpmo 300000');
  });

  it('emits weft_dpmo 0 when no operations have been recorded', () => {
    const text = serializeMetricsSnapshotForPrometheus({});
    expect(text).toContain('weft_dpmo 0');
  });
});

// Byte-identity fixtures captured against the original
// serializeMetricsSnapshotForPrometheus implementation. Any refactor of the
// serializer must preserve the exact output — every line, in order, with the
// trailing newline.
const PROMETHEUS_EMPTY_GOLDEN = `# HELP weft_workflow_duration Duration of workflow execution in milliseconds
# TYPE weft_workflow_duration histogram
weft_workflow_duration_count 0
weft_workflow_duration_sum 0
# HELP weft_activity_duration Duration of activity execution in milliseconds
# TYPE weft_activity_duration histogram
weft_activity_duration_count 0
weft_activity_duration_sum 0
# HELP weft_activity_attempts Total activity execution attempts
# TYPE weft_activity_attempts counter
weft_activity_attempts_total 0
# HELP weft_workflow_active Number of currently active workflows
# TYPE weft_workflow_active gauge
weft_workflow_active 0
# HELP weft_workflow_started Total workflows started
# TYPE weft_workflow_started counter
weft_workflow_started_total 0
# HELP weft_workflow_completed Total workflows completed
# TYPE weft_workflow_completed counter
weft_workflow_completed_total 0
# HELP weft_workflow_failed Total workflows failed
# TYPE weft_workflow_failed counter
weft_workflow_failed_total 0
# HELP weft_prompt_cache_hits Total prompt prefix cache hits
# TYPE weft_prompt_cache_hits counter
weft_prompt_cache_hits_total 0
# HELP weft_prompt_cache_misses Total prompt prefix cache misses
# TYPE weft_prompt_cache_misses counter
weft_prompt_cache_misses_total 0
# HELP weft_dpmo_defects Total failed workflows (DPMO numerator)
# TYPE weft_dpmo_defects counter
weft_dpmo_defects_total 0
# HELP weft_dpmo_operations Total started workflows (DPMO denominator)
# TYPE weft_dpmo_operations counter
weft_dpmo_operations_total 0
# HELP weft_task_backlog Number of queued tasks waiting for workers
# TYPE weft_task_backlog gauge
weft_task_backlog 0
# HELP weft_task_queue_latency Time tasks spend queued before dispatch in milliseconds
# TYPE weft_task_queue_latency histogram
weft_task_queue_latency_count 0
weft_task_queue_latency_sum 0
# HELP weft_task_execution_latency Time tasks spend executing after worker start in milliseconds
# TYPE weft_task_execution_latency histogram
weft_task_execution_latency_count 0
weft_task_execution_latency_sum 0
# HELP weft_task_retries Total task retry attempts after the first dispatch attempt
# TYPE weft_task_retries counter
weft_task_retries_total 0
# HELP weft_task_requeues Total visibility-timeout or disconnect task requeues
# TYPE weft_task_requeues counter
weft_task_requeues_total 0
# HELP weft_task_stale_heartbeats Number of in-flight tasks whose heartbeat age exceeds the diagnostic threshold
# TYPE weft_task_stale_heartbeats gauge
weft_task_stale_heartbeats 0
# HELP weft_worker_capacity_saturation Ratio of in-flight worker slots to total worker concurrency
# TYPE weft_worker_capacity_saturation gauge
weft_worker_capacity_saturation 0
# HELP weft_dpmo Defects per million operations (failed workflows / started workflows * 1e6)
# TYPE weft_dpmo gauge
weft_dpmo 0
`;

function replaceLines(input: string, replacements: Record<string, string>): string {
  const lines = input.split('\n');
  const updated = lines.map((line) => {
    for (const [prefix, value] of Object.entries(replacements)) {
      // The trailing space prevents a shorter prefix (e.g. 'weft_dpmo') from
      // matching a line whose name starts with that prefix but continues
      // (e.g. 'weft_dpmo_defects_total 0').
      if (line.startsWith(prefix + ' ')) return prefix + ' ' + value;
    }
    return line;
  });
  return updated.join('\n');
}

describe('Prometheus byte-identity fixtures', () => {
  it('produces the exact golden output for an empty snapshot', () => {
    const output = serializeMetricsSnapshotForPrometheus({});
    expect(output).toBe(PROMETHEUS_EMPTY_GOLDEN);
  });

  it('produces a byte-identical mixed-metric output', () => {
    const output = serializeMetricsSnapshotForPrometheus({
      'weft.workflow.duration': {
        type: 'histogram',
        count: 5,
        sum: 150,
        p50: 30,
        p99: 40,
        min: 20,
        max: 40,
      },
      'weft.workflow.started': { type: 'counter', value: 7 },
      'weft.workflow.active': { type: 'gauge', value: 3 },
    });
    const expected = replaceLines(PROMETHEUS_EMPTY_GOLDEN, {
      weft_workflow_duration_count: '5',
      weft_workflow_duration_sum: '150',
      weft_workflow_active: '3',
      weft_workflow_started_total: '7',
    });
    expect(output).toBe(expected);
  });

  it('produces a byte-identical DPMO snapshot', () => {
    const output = serializeMetricsSnapshotForPrometheus({
      'weft.dpmo.defects': { type: 'counter', value: 2 },
      'weft.dpmo.operations': { type: 'counter', value: 100 },
    });
    const expected = replaceLines(PROMETHEUS_EMPTY_GOLDEN, {
      weft_dpmo_defects_total: '2',
      weft_dpmo_operations_total: '100',
      weft_dpmo: '20000',
    });
    expect(output).toBe(expected);
  });
});
