/**
 * `weft.system.metrics` operation + REST binding — unit tests.
 *
 * Covers:
 * - Default-export operation (no metricsCollector) returns empty snapshot.
 * - Factory variant with a real MetricsCollector returns its snapshot.
 * - EngineFailure fault shaper returns 500 with "Internal server error".
 * - Unauthorized and Forbidden faults produce 401 and 403 respectively.
 *
 * REST tests inject an authContext principal with the required `system:read`
 * scope so the access-check layer is satisfied before the `invoke()` body
 * runs. Fault-shaper tests override `invoke` to throw a specific fault.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { METRICS, MetricsCollector } from '../../observability/metrics.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  createGetSystemMetricsOperation,
  createGetSystemMetricsRestBinding,
  getSystemMetricsOperation,
} from './get-system-metrics.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

/** An `AuthContext` that grants `system:read` for use in direct `handleRequest` calls. */
function metricsAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

const defaultBinding = createGetSystemMetricsRestBinding();

describe('weft.system.metrics — default export (no collector)', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns an empty snapshot when no metricsCollector is set', async () => {
    engine = createEngine();
    const registry = createOperationRegistry([getSystemMetricsOperation]);

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [defaultBinding],
        ...metricsAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({});
  });

  it('maps EngineFailure faults to 500 with "Internal server error"', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getSystemMetricsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [defaultBinding],
        ...metricsAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('weft.system.metrics — factory variant (with collector)', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the snapshot from the injected MetricsCollector', async () => {
    engine = createEngine();

    const collector = new MetricsCollector();
    collector.increment('weft_test_counter', 7);

    const operation = createGetSystemMetricsOperation({ metricsCollector: collector });
    const registry = createOperationRegistry([operation]);
    const binding = createGetSystemMetricsRestBinding();

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: [binding], ...metricsAuthContext() },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as Record<string, { type?: string; value?: number }>;
    expect(body['weft_test_counter']).toEqual({ type: 'counter', value: 7 });
  });

  it('returns task diagnostics metrics from the injected MetricsCollector', async () => {
    engine = createEngine();

    const collector = new MetricsCollector();
    collector.gauge(METRICS.taskBacklog.name, 3);
    collector.record(METRICS.taskQueueLatency.name, 125);
    collector.record(METRICS.taskExecutionLatency.name, 250);
    collector.increment(METRICS.taskRetries.name, 2);
    collector.increment(METRICS.taskRequeues.name, 1);
    collector.gauge(METRICS.taskStaleHeartbeats.name, 4);
    collector.gauge(METRICS.workerCapacitySaturation.name, 1);

    const operation = createGetSystemMetricsOperation({ metricsCollector: collector });
    const registry = createOperationRegistry([operation]);
    const binding = createGetSystemMetricsRestBinding();

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: [binding], ...metricsAuthContext() },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, { type?: string; value?: number }>;
    expect(body[METRICS.taskBacklog.name]).toEqual({ type: 'gauge', value: 3 });
    expect(body[METRICS.taskRetries.name]).toEqual({ type: 'counter', value: 2 });
    expect(body[METRICS.taskRequeues.name]).toEqual({ type: 'counter', value: 1 });
    expect(body[METRICS.taskStaleHeartbeats.name]).toEqual({ type: 'gauge', value: 4 });
    expect(body[METRICS.workerCapacitySaturation.name]).toEqual({ type: 'gauge', value: 1 });
    expect(body[METRICS.taskQueueLatency.name]?.type).toBe('histogram');
    expect(body[METRICS.taskExecutionLatency.name]?.type).toBe('histogram');
  });

  it('returns an empty snapshot when no metricsCollector is injected via the factory', async () => {
    engine = createEngine();

    const operation = createGetSystemMetricsOperation({});
    const registry = createOperationRegistry([operation]);
    const binding = createGetSystemMetricsRestBinding();

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: [binding], ...metricsAuthContext() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it('shapes Unauthorized fault as 401 via the REST fault shaper', async () => {
    engine = createEngine();

    const unauthorizedOperation = {
      ...createGetSystemMetricsOperation(),
      invoke: async () => {
        const fault: OperationFault = {
          code: 'Unauthorized',
          message: 'no credentials',
          data: { reason: 'no credentials' },
        };
        throw fault;
      },
    };

    // Inject a principal so the access-check layer passes, but the invoke throws
    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([unauthorizedOperation]),
        restBindings: [defaultBinding],
        ...metricsAuthContext(),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'no credentials' });
  });

  it('shapes Forbidden fault as 403 via the REST fault shaper', async () => {
    engine = createEngine();

    const forbiddenOperation = {
      ...createGetSystemMetricsOperation(),
      invoke: async () => {
        const fault: OperationFault = {
          code: 'Forbidden',
          message: 'insufficient scope',
          data: { reason: 'insufficient scope' },
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([forbiddenOperation]),
        restBindings: [defaultBinding],
        ...metricsAuthContext(),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient scope' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createEngine();

    const faultingOperation = {
      ...createGetSystemMetricsOperation(),
      producibleFaults: ['Unprocessable'] as const,
      invoke: async () => {
        throw {
          code: 'Unprocessable',
          message: 'cannot process',
          data: { reason: 'cannot process' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/metrics/json', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([faultingOperation]),
        restBindings: [defaultBinding],
        ...metricsAuthContext(),
      },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'cannot process' });
  });

  it('returns Unauthorized when called with no credentials via executeOperation', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.metrics',
      {},
      {
        principal: { method: 'unauthenticated' },
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('returns Forbidden when called with insufficient scope via executeOperation', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.metrics',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('succeeds with system:read scope via executeOperation', async () => {
    engine = createEngine();

    const collector = new MetricsCollector();
    collector.increment('weft_stdio_counter', 3);

    const operation = createGetSystemMetricsOperation({ metricsCollector: collector });
    const registry = createOperationRegistry([operation]);

    const result = await executeOperation(
      'weft.system.metrics',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'system:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const snapshot = result.value as Record<string, { type?: string; value?: number }>;
    expect(snapshot['weft_stdio_counter']).toEqual({ type: 'counter', value: 3 });
  });
});
