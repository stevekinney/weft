/**
 * `weft.system.metrics` operation + REST binding.
 *
 * Returns JSON-shaped metrics. This is distinct from the Prometheus text
 * exposition at `GET /v1/metrics` (which remains a direct handler and is
 * REST-only). This operation exposes the same underlying data as a
 * structured JSON object for consumers that need machine-readable metrics
 * rather than Prometheus text format.
 *
 * Access is scoped to `system:read` — the same privilege class as any
 * internal-observability endpoint.
 *
 * The metrics snapshot comes from server-owned state captured when the
 * operation is registered. Callers cannot supply a snapshot through REST
 * or JSON-RPC input.
 *
 * @module server/operations/get-system-metrics
 */

import { z } from 'zod';

import type { MetricsCollector, MetricsSnapshot } from '../../observability/metrics.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getSystemMetricsInput = z.object({});

const getSystemMetricsOutput = z.unknown();

export type GetSystemMetricsInput = z.infer<typeof getSystemMetricsInput>;
export type GetSystemMetricsOutput = MetricsSnapshot;

/**
 * Create the `weft.system.metrics` operation bound to a server-owned
 * metrics collector.
 */
export function createGetSystemMetricsOperation(options?: {
  metricsCollector?: MetricsCollector | undefined;
}) {
  return defineOperation<GetSystemMetricsInput, GetSystemMetricsOutput>({
    name: 'weft.system.metrics',
    mcpExposable: false,
    summary: 'Get JSON-shaped system metrics',
    destructive: false,
    tags: ['Observability'],
    inputSchema: getSystemMetricsInput,
    outputSchema: getSystemMetricsOutput as z.ZodType<GetSystemMetricsOutput>,
    access: {
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['system:read'] },
    },
    producibleFaults: [],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async (): Promise<GetSystemMetricsOutput> => {
      return options?.metricsCollector?.snapshot() ?? {};
    },
  });
}

export const getSystemMetricsOperation = createGetSystemMetricsOperation();

/**
 * Factory for the `weft.system.metrics` REST binding.
 *
 * Takes no arguments — the metrics snapshot is sourced through
 * `createGetSystemMetricsOperation`'s closure over the server-owned
 * collector, not through the binding. The binding only declares the
 * REST shape (path, method, response shaping).
 */
export function createGetSystemMetricsRestBinding(): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/metrics/json',
    pathParamNames: [],
    operationName: 'weft.system.metrics',
    inputSources: {},
    extractInput: async () => ({}),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeOperationFaultAsJson,
  };
}
