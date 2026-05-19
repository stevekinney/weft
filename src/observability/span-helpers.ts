import type { OpenTelemetrySpan } from './no-op-telemetry';
import { injectTraceParent } from './propagation';
import type { InterceptionContext, ObservabilityState } from './types';

export const DEFAULT_MAX_PAYLOAD_SIZE = 1024;

export function serializePayload(input: unknown, maxSize: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }

  if (serialized.length > maxSize) {
    return serialized.slice(0, maxSize) + '...';
  }

  return serialized;
}

/** Extract error message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert an unknown thrown value to an Error for `recordException`. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Inject the traceparent header from a span's context into a headers map. */
export function injectSpanContext(span: OpenTelemetrySpan, headers: Map<string, string>): void {
  const ctx = span.spanContext();
  injectTraceParent(headers, {
    version: '00',
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags,
  });
}

export function applyCustomAttributes(
  state: ObservabilityState,
  span: OpenTelemetrySpan,
  interception: InterceptionContext,
): void {
  const attributeExtractor = state.attributeExtractor;
  if (!attributeExtractor) return;
  const custom = attributeExtractor(interception);
  for (const [key, value] of Object.entries(custom)) {
    span.setAttribute(key, value);
  }
}

export function parentContextForWorkflow(state: ObservabilityState, workflowId: string): unknown {
  const rootEntry = state.workflowSpans.get(workflowId);
  return rootEntry
    ? state.trace.setSpan(state.api.context.ROOT_CONTEXT, rootEntry.span)
    : state.api.context.ROOT_CONTEXT;
}

type SpanLifecycleState = Pick<ObservabilityState, 'SpanStatusCode'>;

function recordSpanError(state: SpanLifecycleState, span: OpenTelemetrySpan, error: unknown): void {
  span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
  span.recordException(toError(error));
}

/**
 * Run a sync body inside a span's lifecycle.
 *
 * On success, sets the span status to OK and invokes `onSuccess` (if
 * provided) before ending the span. On failure, sets the status to ERROR,
 * records the exception, and rethrows the original error by identity. The
 * span is always ended exactly once via `finally`.
 *
 * `onSuccess` runs before `span.end()` so callers can record success-only
 * side effects (metrics) in the same ordering they would inline. An
 * exception thrown from `onSuccess` is not caught: it overwrites the OK
 * status with an ERROR record and propagates to the caller.
 */
export function runWithSpan<T>(
  state: SpanLifecycleState,
  span: OpenTelemetrySpan,
  body: () => T,
  onSuccess?: (result: T) => void,
): T {
  try {
    const result = body();
    span.setStatus({ code: state.SpanStatusCode.OK });
    onSuccess?.(result);
    return result;
  } catch (error) {
    recordSpanError(state, span, error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Await an async body inside a span's lifecycle.
 *
 * Same semantics as {@link runWithSpan} but awaits `body` and accepts a
 * `T | Promise<T>` return so call sites whose `next()` is typed as
 * possibly-synchronous still type-check.
 */
export async function runAsyncWithSpan<T>(
  state: SpanLifecycleState,
  span: OpenTelemetrySpan,
  body: () => T | Promise<T>,
  onSuccess?: (result: T) => void,
): Promise<T> {
  try {
    const result = await body();
    span.setStatus({ code: state.SpanStatusCode.OK });
    onSuccess?.(result);
    return result;
  } catch (error) {
    recordSpanError(state, span, error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Yield* a generator body inside a span's lifecycle.
 *
 * Same span lifecycle as {@link runWithSpan}. The helper uses `yield* body()`,
 * which forwards `.throw()` and `.return()` from the outer caller to the inner
 * generator per the ECMAScript generator-delegation contract:
 *
 * - `.throw(error)` surfaces as an exception inside `yield*`, is caught by
 *   this helper, and is recorded on the span as an error before the span ends.
 * - `.return(value)` propagates as a normal completion: the helper's `finally`
 *   ends the span, but the body is treated as cancelled — `onSuccess` does
 *   not run and the span status is whatever was last set (typically unset).
 */
export function* runGeneratorWithSpan<TYield, TReturn, TNext>(
  state: SpanLifecycleState,
  span: OpenTelemetrySpan,
  body: () => Generator<TYield, TReturn, TNext>,
  onSuccess?: (result: TReturn) => void,
): Generator<TYield, TReturn, TNext> {
  try {
    const result = yield* body();
    span.setStatus({ code: state.SpanStatusCode.OK });
    onSuccess?.(result);
    return result;
  } catch (error) {
    recordSpanError(state, span, error);
    throw error;
  } finally {
    span.end();
  }
}
