import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { RetentionOverview } from '../../core/types.ts';

const getRetentionOverviewInput = z.object({});
const getRetentionOverviewOutput = z.unknown();

export type GetRetentionOverviewInput = z.infer<typeof getRetentionOverviewInput>;
export type GetRetentionOverviewOutput = RetentionOverview;

export const getRetentionOverviewOperation = defineOperation({
  name: 'weft.retention.get',
  mcpExposable: false,
  summary: 'Get retention policy overview',
  description:
    "Report the engine's retention configuration: the default retention policy, per- " +
    'workflow-type policies, the sweep interval and batch size, and when the next ' +
    'sweep is due. Read-only.',
  destructive: false,
  tags: ['System'],
  inputSchema: getRetentionOverviewInput,
  outputSchema: getRetentionOverviewOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ host: engine }): Promise<GetRetentionOverviewOutput> => {
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
