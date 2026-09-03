/**
 * `weft.catalog.diagnostics` operation + REST binding (WFT-12).
 *
 * Read-only, bounded diagnostics for one `(name, revision)` workflow
 * catalog entry: whether it is installed, whether it is currently active,
 * its full reference-count breakdown, and whether it would currently be
 * removable. No REST/JSON-RPC removal surface exists this batch — removal
 * (`removeWorkflowRevision`) is a plain in-process function, not a wire
 * operation, per the coordinator's "single bounded diagnostics operation"
 * steer.
 *
 * Static, not factory-built — unlike `get-worker-diagnostics.ts`'s injected
 * `WorkerRegistry`, this operation needs no per-server state beyond the
 * live `engine` every `invoke` already receives, matching
 * `get-retention-overview.ts`'s shape.
 *
 * @module server/operations/get-catalog-diagnostics
 */

import { z } from 'zod';

import { getWorkflowRevisionDiagnostics, type Engine } from '../../core/engine.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const workflowRevisionReferenceCountsSchema = z
  .object({
    registeredDefinitions: z.number().int().nonnegative(),
    inFlightStarts: z.number().int().nonnegative(),
    nonTerminalRuns: z.number().int().nonnegative(),
    pinnedSchedules: z.number().int().nonnegative(),
    pendingDispatches: z.number().int().nonnegative(),
    activeExecutionRealms: z.number().int().nonnegative(),
    retainedRecoveryRecords: z.number().int().nonnegative(),
  })
  .strict();

const getCatalogDiagnosticsInput = z
  .object({
    name: z.string().min(1),
    revision: z.string().min(1),
  })
  .strict();

const getCatalogDiagnosticsOutput = z
  .object({
    name: z.string(),
    revision: z.string(),
    installed: z.boolean(),
    active: z.boolean(),
    activeRevision: z.string().optional(),
    references: workflowRevisionReferenceCountsSchema,
    removable: z.boolean(),
  })
  .strict();

export type GetCatalogDiagnosticsInput = z.infer<typeof getCatalogDiagnosticsInput>;
export type GetCatalogDiagnosticsOutput = z.infer<typeof getCatalogDiagnosticsOutput>;

/**
 * `weft.catalog.diagnostics`: bounded, per-`(name, revision)` diagnostics
 * for the durable workflow catalog. Requires `system:read`. Never returns
 * manifest or contract content — only identity, active-pointer state, and
 * low-cardinality reference counts, matching the repository's "metrics
 * remain low-cardinality" observability convention.
 *
 * @example
 * ```ts
 * import { HttpClient } from '@lostgradient/weft/client';
 *
 * const client = new HttpClient({ baseUrl: 'https://weft.example.com' });
 * const diagnostics = await client.operations['weft.catalog.diagnostics']({
 *   name: 'checkout',
 *   revision: 'some-revision',
 * });
 * console.log(diagnostics.installed, diagnostics.removable);
 * ```
 */
export const getCatalogDiagnosticsOperation = defineOperation<
  GetCatalogDiagnosticsInput,
  GetCatalogDiagnosticsOutput
>({
  name: 'weft.catalog.diagnostics',
  mcpExposable: false,
  summary: 'Get bounded reference-count and removability diagnostics for one workflow revision',
  description:
    'Report whether a `(name, revision)` workflow catalog entry is installed, whether it is ' +
    "currently the active revision, its full reference-count breakdown, and whether it's " +
    'currently removable. Never returns manifest or contract content.',
  destructive: false,
  tags: ['Observability'],
  inputSchema: getCatalogDiagnosticsInput,
  outputSchema: getCatalogDiagnosticsOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  producibleFaults: [],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine, input }): Promise<GetCatalogDiagnosticsOutput> => {
    const e = engine as Engine;
    return getWorkflowRevisionDiagnostics(e, input.name, input.revision);
  },
});

/** REST binding for `weft.catalog.diagnostics`: `GET /v1/catalog/:name/revisions/:revision/diagnostics`. */
export const getCatalogDiagnosticsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/catalog/:name/revisions/:revision/diagnostics',
  pathParamNames: ['name', 'revision'],
  operationName: 'weft.catalog.diagnostics',
  inputSources: {
    name: { kind: 'path', pathParam: 'name' },
    revision: { kind: 'path', pathParam: 'revision' },
  },
  extractInput: async (_request, pathParams) => ({
    name: pathParams['name'] ?? '',
    revision: pathParams['revision'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
