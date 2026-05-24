import { describe, expect, it } from 'bun:test';

import {
  NO_OP_SPAN_METHODS,
  getOpenTelemetryApi,
  isSupportedOpenTelemetryApi,
  resetCachedOpenTelemetryApiForTesting,
  resolveInstalledOpenTelemetryApi,
  type OpenTelemetryApi,
} from './no-op-telemetry';

/**
 * Builds a fresh object matching the supported OpenTelemetry API shape Weft
 * inspects, without importing the real `@opentelemetry/api` package. Returns a
 * new object on each call so identity (`toBe`) assertions stay meaningful.
 *
 * Pass `overrides` to void or replace selected top-level fields — the only
 * intended use is the missing-field reject cases, where a near-complete
 * candidate omits exactly one required field (e.g. `{ trace: {} as never }`).
 */
function makeSupportedOpenTelemetryApi(overrides?: Partial<OpenTelemetryApi>): OpenTelemetryApi {
  const api: OpenTelemetryApi = {
    trace: {
      getTracer() {
        return {
          startSpan() {
            return {
              setAttribute() {},
              setStatus() {},
              recordException() {},
              end() {},
              spanContext() {
                return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };
              },
            };
          },
        };
      },
      setSpan(context: unknown) {
        return context;
      },
    },
    metrics: {
      getMeter() {
        return {
          createHistogram() {
            return { record() {} };
          },
          createCounter() {
            return { add() {} };
          },
          createUpDownCounter() {
            return { add() {} };
          },
        };
      },
    },
    context: {
      ROOT_CONTEXT: {},
      with<T>(_ctx: unknown, fn: () => T): T {
        return fn();
      },
    },
    SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
  };
  return overrides ? { ...api, ...overrides } : api;
}

describe('getOpenTelemetryApi', () => {
  it('returns an object with trace, metrics, context, and SpanStatusCode', () => {
    const api = getOpenTelemetryApi();
    expect(api.trace).toBeDefined();
    expect(api.metrics).toBeDefined();
    expect(api.context).toBeDefined();
    expect(api.SpanStatusCode).toBeDefined();
  });

  it('returns SpanStatusCode with OK, ERROR, and UNSET values', () => {
    const { SpanStatusCode } = getOpenTelemetryApi();
    expect(SpanStatusCode.OK).toBe(1);
    expect(SpanStatusCode.ERROR).toBe(2);
    expect(SpanStatusCode.UNSET).toBe(0);
  });

  it('exports reusable no-op span methods that do not throw', () => {
    expect(() => NO_OP_SPAN_METHODS.setAttribute('key', 'value')).not.toThrow();
    expect(() => NO_OP_SPAN_METHODS.setStatus({ code: 1 })).not.toThrow();
    expect(() => NO_OP_SPAN_METHODS.recordException(new Error('test'))).not.toThrow();
    expect(() => NO_OP_SPAN_METHODS.end()).not.toThrow();
  });

  describe('no-op tracer', () => {
    it('creates a tracer via trace.getTracer()', () => {
      const { trace } = getOpenTelemetryApi();
      const tracer = trace.getTracer('test');
      expect(tracer).toBeDefined();
      expect(typeof tracer.startSpan).toBe('function');
    });

    it('creates spans that do not throw', () => {
      const { trace } = getOpenTelemetryApi();
      const tracer = trace.getTracer('test', '1.0.0');
      const span = tracer.startSpan('test-span');

      expect(() => span.setAttribute('key', 'value')).not.toThrow();
      expect(() => span.setStatus({ code: 1 })).not.toThrow();
      expect(() => span.recordException(new Error('test'))).not.toThrow();
      expect(() => span.end()).not.toThrow();
    });

    it('returns a span context with valid structure', () => {
      const { trace } = getOpenTelemetryApi();
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = span.spanContext();

      expect(ctx).toBeDefined();
      expect(typeof ctx.traceId).toBe('string');
      expect(typeof ctx.spanId).toBe('string');
      expect(typeof ctx.traceFlags).toBe('number');
    });

    it('returns a static no-op span context with sentinel values', () => {
      const { trace } = getOpenTelemetryApi();
      const tracer = trace.getTracer('test');
      const span1 = tracer.startSpan('span-1');
      const span2 = tracer.startSpan('span-2');
      const ctx1 = span1.spanContext();

      expect(ctx1.traceId).toHaveLength(32);
      expect(ctx1.traceId).toBe('0'.repeat(32));
      expect(ctx1.spanId).toHaveLength(16);
      expect(ctx1.spanId).toBe('0'.repeat(16));
      expect(ctx1.traceFlags).toBe(0); // Not sampled
      // All no-op spans share the same instance
      expect(span1).toBe(span2);
    });
  });

  describe('no-op meter', () => {
    it('creates a meter via metrics.getMeter()', () => {
      const { metrics } = getOpenTelemetryApi();
      const meter = metrics.getMeter('test');
      expect(meter).toBeDefined();
    });

    it('creates histogram, counter, and upDownCounter without throwing', () => {
      const { metrics } = getOpenTelemetryApi();
      const meter = metrics.getMeter('test');

      const histogram = meter.createHistogram('test.hist', { unit: 'ms' });
      expect(histogram).toBeDefined();
      expect(() => histogram.record(42)).not.toThrow();
      expect(() => histogram.record(100, { key: 'value' })).not.toThrow();

      const counter = meter.createCounter('test.counter');
      expect(counter).toBeDefined();
      expect(() => counter.add(1)).not.toThrow();
      expect(() => counter.add(5, { key: 'value' })).not.toThrow();

      const upDown = meter.createUpDownCounter('test.updown');
      expect(upDown).toBeDefined();
      expect(() => upDown.add(1)).not.toThrow();
      expect(() => upDown.add(-1)).not.toThrow();
    });
  });

  describe('context utilities', () => {
    it('trace.setSpan returns a context value', () => {
      const { trace, context } = getOpenTelemetryApi();
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(context.ROOT_CONTEXT, span);
      expect(ctx).toBeDefined();
    });

    it('context.with calls the callback and returns its result', () => {
      const { context } = getOpenTelemetryApi();
      const result = context.with(context.ROOT_CONTEXT, () => 'hello');
      expect(result).toBe('hello');
    });
  });

  it('returns the same API on repeated calls (cached)', () => {
    const api1 = getOpenTelemetryApi();
    const api2 = getOpenTelemetryApi();
    expect(api1).toBe(api2);
  });

  it('isSupportedOpenTelemetryApi accepts the subset of the OpenTelemetry API Weft requires', () => {
    expect(isSupportedOpenTelemetryApi(makeSupportedOpenTelemetryApi())).toBe(true);
  });

  it('isSupportedOpenTelemetryApi rejects incomplete module shapes', () => {
    expect(isSupportedOpenTelemetryApi(undefined)).toBe(false);
    expect(isSupportedOpenTelemetryApi({ trace: {} } as never)).toBe(false);

    // Missing SpanStatusCode (guard checks value.SpanStatusCode != null)
    const withoutStatusCode = makeSupportedOpenTelemetryApi({ SpanStatusCode: undefined as never });
    expect(isSupportedOpenTelemetryApi(withoutStatusCode)).toBe(false);

    // Missing trace.getTracer (guard checks value.trace?.getTracer != null)
    const withoutTrace = makeSupportedOpenTelemetryApi({ trace: {} as never });
    expect(isSupportedOpenTelemetryApi(withoutTrace)).toBe(false);
  });

  it('resolveInstalledOpenTelemetryApi returns the installed module when the loader exposes the required shape', () => {
    const api = makeSupportedOpenTelemetryApi();
    const loadedApi = resolveInstalledOpenTelemetryApi(() => api);

    expect(loadedApi).toBe(api);
    expect(loadedApi!.SpanStatusCode.OK).toBe(1);
  });

  it('resolveInstalledOpenTelemetryApi falls back to undefined when the loader throws', () => {
    expect(
      resolveInstalledOpenTelemetryApi(() => {
        throw new Error('module not found');
      }),
    ).toBeUndefined();
  });

  it('resolveInstalledOpenTelemetryApi uses the global require loader when it is available', () => {
    const globalObject = globalThis as Record<PropertyKey, unknown>;
    const originalRequire = globalObject['require'];
    const requestedModules: string[] = [];
    const installedApi = makeSupportedOpenTelemetryApi();

    globalObject['require'] = (moduleName: string) => {
      requestedModules.push(moduleName);
      return installedApi;
    };

    try {
      expect(resolveInstalledOpenTelemetryApi()).toBe(installedApi);
      expect(requestedModules).toEqual(['@opentelemetry/api']);
    } finally {
      globalObject['require'] = originalRequire;
    }
  });

  it('resolveInstalledOpenTelemetryApi safely falls back when require is unavailable', () => {
    const globalObject = globalThis as Record<PropertyKey, unknown>;
    const originalRequire = globalObject['require'];
    globalObject['require'] = undefined;

    try {
      expect(resolveInstalledOpenTelemetryApi()).toBeUndefined();
      resetCachedOpenTelemetryApiForTesting();
      expect(getOpenTelemetryApi().SpanStatusCode.OK).toBe(1);
    } finally {
      globalObject['require'] = originalRequire;
      resetCachedOpenTelemetryApiForTesting();
    }
  });

  it('getOpenTelemetryApi caches the installed module when a loader is provided', () => {
    resetCachedOpenTelemetryApiForTesting();

    const installedApi = makeSupportedOpenTelemetryApi();

    const api = getOpenTelemetryApi(() => installedApi);

    expect(api).toBe(installedApi);
    expect(getOpenTelemetryApi()).toBe(installedApi);
  });
});
