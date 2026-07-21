/**
 * `weft.system.lease` operation + REST binding.
 *
 * Returns the serving engine process's last-known ownership-lease state. This
 * is deliberately separate from anonymous `GET /v1/health`: load balancers need
 * a stable liveness probe, while holder identifiers and fencing state are scoped
 * operator diagnostics that require `system:read`.
 *
 * @module server/operations/get-system-lease
 */

import { z } from 'zod';

import { type Engine, type EngineLeaseHealth } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getSystemLeaseInput = z.object({});

const getSystemLeaseOutput = z
  .object({
    mode: z.enum(['none', 'lease']),
    status: z.enum(['disabled', 'healthy', 'no-lease', 'contested']),
    holdsLease: z.boolean(),
    holderId: z.string().min(1).optional(),
    heldSince: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    lastRenewedAt: z.number().int().nonnegative().optional(),
    fencingEpoch: z.number().int().positive().safe().optional(),
    lossReason: z.enum(['deposed', 'renewal-unconfirmable']).optional(),
  })
  .strict();

export type GetSystemLeaseInput = z.infer<typeof getSystemLeaseInput>;
export type GetSystemLeaseOutput = EngineLeaseHealth;

export const getSystemLeaseOperation = defineOperation<GetSystemLeaseInput, GetSystemLeaseOutput>({
  name: 'weft.system.lease',
  mcpExposable: false,
  summary: 'Get ownership-lease health for this engine process',
  description:
    'Reports whether lease ownership is disabled, not yet held, healthy, or contested. ' +
    'Contested results preserve the confirmed deposed or renewal-unconfirmable reason.',
  destructive: false,
  tags: ['System'],
  inputSchema: getSystemLeaseInput,
  outputSchema: getSystemLeaseOutput as z.ZodType<GetSystemLeaseOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:read'] },
  },
  producibleFaults: [],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetSystemLeaseOutput> => {
    return (engine as Engine).getLeaseHealth();
  },
});

export const getSystemLeaseRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/system/lease',
  pathParamNames: [],
  operationName: 'weft.system.lease',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetSystemLeaseOutput) =>
    new Response(JSON.stringify(output), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  shapeFault: shapeRestFault,
};
