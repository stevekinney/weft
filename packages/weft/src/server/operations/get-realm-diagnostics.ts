/**
 * `weft.realms.diagnostics` operation + REST binding (COR-243).
 *
 * Bounded, host-wide diagnostics for every workflow-revision realm pool the
 * live `Engine` currently owns: per `(name, revision)` whether the catalog
 * still considers it the active pointer, and a per-realm snapshot of
 * lifecycle state, activation generation, restart count, and in-flight turn
 * count. Backs the Console's realm view.
 *
 * Static, not factory-built — like `get-catalog-diagnostics.ts`, this needs
 * no per-server state beyond the live `engine` every `invoke` already
 * receives. Returns an empty `pools` array for a host that never opted into
 * `workflowExecutionMode: 'realm'` (see `getRevisionRealmDiagnostics`'s own
 * doc) rather than an error — a Console polling this operation should see
 * "no realms" cleanly, not a fault.
 *
 * @module server/operations/get-realm-diagnostics
 */

import { z } from 'zod';

import {
  Engine,
  getRevisionRealmDiagnostics,
  type RevisionRealmPoolDiagnostics,
} from '../../core/engine.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const realmLifecycleStateSchema = z.enum([
  'warming',
  'ready',
  'active',
  'draining',
  'terminated',
  'crashed',
]);

const realmDiagnosticsEntrySchema = z
  .object({
    state: realmLifecycleStateSchema,
    realmGeneration: z.string().nullable(),
    restartCount: z.number().int().nonnegative(),
    pendingTurnCount: z.number().int().nonnegative(),
  })
  .strict();

const realmPoolDiagnosticsSchema = z
  .object({
    name: z.string(),
    revision: z.string(),
    revisionActive: z.boolean(),
    realms: z.array(realmDiagnosticsEntrySchema),
  })
  .strict();

const getRealmDiagnosticsOutput = z
  .object({
    pools: z.array(realmPoolDiagnosticsSchema),
  })
  .strict();

export type GetRealmDiagnosticsOutput = z.infer<typeof getRealmDiagnosticsOutput>;

/**
 * Project the core layer's `readonly`-array diagnostics shape into the
 * mutable-array shape `getRealmDiagnosticsOutput` (and `defineOperation`'s
 * own output-validation step) expects. Extracted as its own pure function,
 * independent of a live `Engine`, so the non-empty-pools case is directly
 * unit-testable — `getRevisionRealmDiagnostics(engine)` returning `[]` (the
 * default, unopted-in case) never exercises the per-pool transform below,
 * since `Array.prototype.map` never invokes its callback on an empty array.
 */
export function toGetRealmDiagnosticsOutput(
  pools: readonly RevisionRealmPoolDiagnostics[],
): GetRealmDiagnosticsOutput {
  return {
    pools: pools.map((pool) => ({
      ...pool,
      realms: [...pool.realms],
    })),
  };
}

/**
 * `weft.realms.diagnostics`: bounded, host-wide diagnostics for every
 * workflow-revision realm pool. Requires `system:read`. Never returns a
 * manifest, contract, or raw protocol payload — only lifecycle identity and
 * low-cardinality counters, matching `weft.catalog.diagnostics`'s and
 * `weft.workers.diagnostics`'s own observability convention.
 *
 * @example
 * ```ts
 * import { HttpClient } from '@lostgradient/weft';
 *
 * const client = new HttpClient({ baseUrl: 'https://weft.example.com' });
 * const diagnostics = await client.operations['weft.realms.diagnostics']({});
 * console.log(diagnostics.pools.length, 'realm pool(s)');
 * ```
 */
export const getRealmDiagnosticsOperation = defineOperation({
  name: 'weft.realms.diagnostics',
  mcpExposable: false,
  summary: 'Get bounded per-realm diagnostics for every workflow-revision realm pool',
  description:
    'Report every `(name, revision)` realm pool the live engine currently owns: whether the ' +
    'catalog still considers it the active pointer, and a per-realm snapshot of lifecycle ' +
    'state (warming/ready/active/draining/terminated/crashed), activation generation, restart ' +
    'count, and in-flight turn count. Returns an empty `pools` array for a host that never ' +
    "opted into `workflowExecutionMode: 'realm'`. Never returns manifest or contract content.",
  destructive: false,
  tags: ['Observability'],
  inputSchema: z.object({}).strict(),
  outputSchema: getRealmDiagnosticsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  producibleFaults: [],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetRealmDiagnosticsOutput> => {
    if (!(engine instanceof Engine)) {
      throw new TypeError('Realm diagnostics requires a concrete Engine instance.');
    }
    return toGetRealmDiagnosticsOutput(getRevisionRealmDiagnostics(engine));
  },
});

/** REST binding for `weft.realms.diagnostics`: `GET /v1/realms/diagnostics`. */
export const getRealmDiagnosticsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/realms/diagnostics',
  pathParamNames: [],
  operationName: 'weft.realms.diagnostics',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
