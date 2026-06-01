import type {
  ActivityInterception,
  ChildWorkflowInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowStartInterception,
} from '../core/interceptor';
import type { MetricsCollector as MetricsCollectorClass } from './metrics';
import type { OpenTelemetryApi, OpenTelemetrySpan, OpenTelemetryTracer } from './no-op-telemetry';

/**
 * Union of all interception context types the attributeExtractor receives.
 *
 * @example
 * ```ts
 * import { createObservabilityInterceptors, type InterceptionContext } from '@lostgradient/weft';
 *
 * const { interceptor } = createObservabilityInterceptors({
 *   attributeExtractor: (ctx: InterceptionContext) => {
 *     if ('workflowId' in ctx) return { workflowId: ctx.workflowId };
 *     return {};
 *   },
 * });
 * void interceptor;
 * ```
 */
export type InterceptionContext =
  | WorkflowStartInterception
  | ActivityInterception
  | SleepInterception
  | SignalInterception
  | ChildWorkflowInterception
  | SignalReceivedInterception;

/**
 * Configuration for {@link createObservabilityInterceptors}, which produces
 * a unified interceptor that propagates W3C trace context and emits
 * OpenTelemetry spans.
 *
 * All fields are optional. Omit `openTelemetryApi` in production — it is auto-detected
 * from `@opentelemetry/api` when installed, and all operations fall back to
 * no-ops when it is absent. Pass your `Engine` instance as `eventTarget` so
 * root workflow spans are closed correctly on terminal lifecycle events.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, createObservabilityInterceptors, type ObservabilityOptions } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const options: ObservabilityOptions = {
 *   tracerName: 'my-service',
 *   recordPayloads: false,
 *   eventTarget: engine,
 * };
 * const { interceptor } = createObservabilityInterceptors(options);
 * void interceptor;
 * ```
 */
export type ObservabilityOptions = {
  /** Name passed to `trace.getTracer()`. Default: `'weft'`. */
  tracerName?: string;
  /** Version passed to `trace.getTracer()`. */
  tracerVersion?: string;
  /** Whether to record activity/workflow inputs as span attributes. Default: false. */
  recordPayloads?: boolean;
  /** Maximum serialized payload size in bytes before truncation. Default: 1024. */
  maxPayloadSize?: number;
  /**
   * Extract custom span attributes from each interception context.
   * Receives the actual interception object—not a synthetic wrapper.
   */
  attributeExtractor?: (
    interception: InterceptionContext,
  ) => Record<string, string | number | boolean>;
  /** Metrics collector for recording counters, histograms, and gauges. */
  metrics?: MetricsCollectorClass;
  /**
   * Override the OpenTelemetry API instance used by the interceptors.
   * Primarily for testing—production code should omit this so `getOpenTelemetryApi()`
   * auto-detects whether `@opentelemetry/api` is installed.
   */
  openTelemetryApi?: OpenTelemetryApi;
  /**
   * Event target that the engine dispatches lifecycle events on.
   *
   * When provided, root workflow spans are closed on terminal lifecycle events,
   * and agent child spans are created from agent turn/tool events.
   */
  eventTarget?: EventTarget;
};

export type WorkflowSpanEntry = { span: OpenTelemetrySpan; createdAt: number };

export type ObservabilityState = {
  readonly api: OpenTelemetryApi;
  readonly trace: OpenTelemetryApi['trace'];
  readonly SpanStatusCode: OpenTelemetryApi['SpanStatusCode'];
  readonly tracer: OpenTelemetryTracer;
  readonly recordPayloads: boolean;
  readonly maxPayloadSize: number;
  readonly attributeExtractor: ObservabilityOptions['attributeExtractor'] | undefined;
  readonly eventTarget: EventTarget | undefined;
  readonly metrics: MetricsCollectorClass;
  readonly workflowSpans: Map<string, WorkflowSpanEntry>;
};
