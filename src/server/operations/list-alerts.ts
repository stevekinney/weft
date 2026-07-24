/**
 * `weft.alerts.list` operation + REST binding.
 *
 * Reports the alert rules that are currently firing. The response deliberately
 * omits rule actions and webhook destinations: this is an operator diagnostic
 * surface, not a configuration export.
 */

import { z } from 'zod';

import type { AlertMetric } from '../../alerting/types.ts';
import type { Engine } from '../../core/engine.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const alertMetricSchema = z.enum([
  'workflow.failure_rate',
  'activity.p99_duration',
  'storage.size',
]) as z.ZodType<AlertMetric>;

const listAlertsInput = z.object({});
const activeAlertSchema = z.object({
  metric: alertMetricSchema,
  threshold: z.number(),
  currentValue: z.number(),
  window: z.string().nullable(),
  firedAt: z.number().nullable(),
});
const listAlertsOutput = z.object({
  items: z.array(activeAlertSchema),
});

export type ListAlertsInput = z.infer<typeof listAlertsInput>;
export type ActiveAlert = z.infer<typeof activeAlertSchema>;
export type ListAlertsOutput = { items: ActiveAlert[] };

export const listAlertsOperation = defineOperation<ListAlertsInput, ListAlertsOutput>({
  name: 'weft.alerts.list',
  mcpExposable: false,
  summary: 'List currently firing alerts',
  description:
    'List the alert rules that are currently firing, including their metric, threshold, current ' +
    'value, configured window, and firing timestamp. Read-only and limited to active in-memory ' +
    'alert state; resolved alerts are not returned.',
  destructive: false,
  tags: ['Observability'],
  inputSchema: listAlertsInput,
  outputSchema: listAlertsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<ListAlertsOutput> => {
    const activeAlerts = (engine as Engine).getActiveAlerts();
    return {
      items: activeAlerts.map((state) => ({
        metric: state.rule.metric,
        threshold: state.rule.threshold,
        currentValue: state.currentValue,
        window: state.rule.window ?? null,
        firedAt: state.lastFiredAt ?? null,
      })),
    };
  },
});

export const listAlertsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/alerts',
  pathParamNames: [],
  operationName: 'weft.alerts.list',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListAlertsOutput) =>
    new Response(JSON.stringify(output), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  shapeFault: shapeOperationFaultAsJson,
};
