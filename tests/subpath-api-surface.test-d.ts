import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  ValidationIssue,
} from 'weft/json-schema';
import type {
  MetricDefinition,
  MetricsSnapshot,
  OpenTelemetryApi,
  OpenTelemetryMeter,
  OpenTelemetrySpan,
  OpenTelemetryTracer,
  TraceContext,
} from 'weft/observability';

// @ts-expect-error OpenTelemetry infrastructure types are subpath-only.
type RootOpenTelemetryApi = import('weft').OpenTelemetryApi;
// @ts-expect-error Standard Schema helper types are subpath-only.
type RootStandardSchemaV1 = import('weft').StandardSchemaV1;

const traceContext: TraceContext = {
  version: '00',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: 1,
};
void traceContext;

declare const span: OpenTelemetrySpan;
declare const tracer: OpenTelemetryTracer;
declare const meter: OpenTelemetryMeter;
declare const api: OpenTelemetryApi;
declare const metricDefinition: MetricDefinition;
declare const metricsSnapshot: MetricsSnapshot;

void span;
void tracer;
void meter;
void api;
void metricDefinition;
void metricsSnapshot;

declare const standardSchema: StandardSchemaV1<{ id: string }, { ok: true }>;
declare const jsonSchema: StandardJSONSchemaV1<{ id: string }, { ok: true }>;
declare const standardIssue: StandardSchemaV1Issue;
const validationIssue: ValidationIssue = { message: standardIssue.message, path: '/id' };

void standardSchema;
void jsonSchema;
void validationIssue;
void (undefined as unknown as RootOpenTelemetryApi);
void (undefined as unknown as RootStandardSchemaV1);
