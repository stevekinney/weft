import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import type { RetentionOverview } from '../../core/types.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getRetentionOverviewInput = z.object({});
const getRetentionOverviewOutput = z.unknown();

export type GetRetentionOverviewInput = z.infer<typeof getRetentionOverviewInput>;
export type GetRetentionOverviewOutput = RetentionOverview;

export const getRetentionOverviewOperation = defineOperation({
  name: 'weft.retention.get',
  mcpExposable: false,
  summary: 'Get retention policy overview',
  destructive: false,
  tags: ['System'],
  inputSchema: getRetentionOverviewInput,
  outputSchema: getRetentionOverviewOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetRetentionOverviewOutput> => {
    assertOperationEngineMethods(engine, ['getRetentionOverview']);
    const e = engine;
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
