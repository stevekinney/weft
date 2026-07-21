import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const storageCapabilitiesInput = z.object({});
const storageCapabilitiesOutput = z
  .object({
    persistence: z.enum(['ephemeral', 'local', 'remote']).optional(),
    readAfterWrite: z.enum(['linearizable', 'session', 'eventual']),
    scanConsistency: z.enum(['snapshot', 'best-effort']),
    atomicBatch: z.boolean(),
    conditionalBatch: z.boolean(),
    boundedRangeDelete: z.boolean(),
  })
  .strict();

export type StorageCapabilitiesInput = z.infer<typeof storageCapabilitiesInput>;
export type StorageCapabilitiesOutput = z.infer<typeof storageCapabilitiesOutput>;

export const storageCapabilitiesOperation = defineOperation<
  StorageCapabilitiesInput,
  StorageCapabilitiesOutput
>({
  name: 'weft.storage.capabilities',
  mcpExposable: false,
  summary: "Report the connected storage backend's capability profile",
  destructive: false,
  tags: ['Storage'],
  inputSchema: storageCapabilitiesInput,
  outputSchema: storageCapabilitiesOutput,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['storage:read'] },
  },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }) => (engine as Engine).storage.capabilities(),
});

export const storageCapabilitiesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/storage/-/capabilities',
  pathParamNames: [],
  operationName: 'weft.storage.capabilities',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: StorageCapabilitiesOutput) => Response.json(output),
  shapeFault: shapeRestFault,
};
