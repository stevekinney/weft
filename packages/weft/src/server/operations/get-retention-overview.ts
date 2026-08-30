import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { RetentionOverview } from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getRetentionOverviewInput = z.object({});
const getRetentionOverviewOutput = z.unknown();

export type GetRetentionOverviewInput = z.infer<typeof getRetentionOverviewInput>;
export type GetRetentionOverviewOutput = RetentionOverview;

export const getRetentionOverviewOperation = defineOperation<
  GetRetentionOverviewInput,
  GetRetentionOverviewOutput
>({
  name: 'weft.retention.get',
  mcpExposable: false,
  summary: 'Get retention policy overview',
  destructive: false,
  tags: ['System'],
  inputSchema: getRetentionOverviewInput,
  outputSchema: getRetentionOverviewOutput as z.ZodType<GetRetentionOverviewOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetRetentionOverviewOutput> => {
    const e = engine as Engine;
    return e.getRetentionOverview();
  },
});

export const getRetentionOverviewRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/retention',
  pathParamNames: [],
  operationName: 'weft.retention.get',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
};
