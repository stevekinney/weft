/**
 * `weft.system.registry` operation + REST binding.
 *
 * Returns a JSON snapshot of eager workflow definitions and registered activities,
 * with their JSON Schemas. Powers the `weft codegen` CLI: a downstream
 * project fetches this document, validates it, and emits a `.d.ts` that
 * augments `WorkflowRegistry` with the locally-registered workflow names.
 *
 * Access is scoped to `system:read` — schemas can leak internal data shapes
 * so the endpoint sits behind the same scope as the JSON metrics endpoint.
 *
 * The actual snapshot assembly lives in {@link buildRegistrySnapshot} so the
 * MCP server (Section 2 of the roadmap) can reuse the builder without going
 * through HTTP.
 *
 * @module server/operations/get-registry
 */

import { z } from 'zod';

import { Engine } from '../../core/engine.ts';
import {
  buildRegistrySnapshot,
  REGISTRY_VERSION,
  RegistryManifestLimitError,
  RegistrySchemaConversionError,
  type RegistrySnapshot,
  RegistryWorkflowCountLimitError,
} from '../../core/registry-snapshot.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getRegistryInput = z.object({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRecord);
}

// The refinement validators deliberately return their original values. Zod
// record/object parsers rebuild dictionaries and lose null-prototype keys such
// as `__proto__`, while the snapshot builder preserves those keys. Validate
// the envelope here; the typed builder owns the contents of each dictionary.
const getRegistryOutput = z
  .object({
    registryVersion: z.literal(REGISTRY_VERSION),
    generatedAt: z.string(),
    workflows: z.unknown().refine(isObjectList, 'expected an array of objects'),
    activeRevisions: z.unknown().refine(isRecord, 'expected an object'),
    activities: z.unknown().refine(isRecord, 'expected an object'),
  })
  .strict();

export type GetRegistryInput = z.infer<typeof getRegistryInput>;
export type GetRegistryOutput = RegistrySnapshot;

export const getRegistryOperation = defineOperation({
  name: 'weft.system.registry',
  mcpExposable: false,
  summary: 'Get a snapshot of eager workflows and registered activities with their JSON Schemas',
  description:
    'Describe eager workflow definitions and registered activities for schema discovery. ' +
    'Excludes registerSource() workflows even after preload; enumerate dynamic sources ' +
    'with weft.catalog.sources.list.',
  destructive: false,
  tags: ['System'],
  inputSchema: getRegistryInput,
  outputSchema: getRegistryOutput,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:read'] },
  },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetRegistryOutput> => {
    try {
      if (!(engine instanceof Engine)) {
        throw new TypeError('Registry snapshot requires a concrete Engine instance.');
      }
      return await buildRegistrySnapshot(engine);
    } catch (error) {
      // Log the typed conversion/limit error to the server console before
      // the operation pipeline reduces it to a generic `EngineFailure`. The
      // pipeline doesn't capture `error.message`, so without this explicit
      // log the offending entity name and direction (or workflow type and
      // limit reason) would never reach operator-visible output. Re-throw
      // so the pipeline still produces the masked wire response.
      if (error instanceof RegistrySchemaConversionError) {
        console.error(`[weft.system.registry] ${error.message}`, {
          entityKind: error.entityKind,
          entityName: error.entityName,
          direction: error.direction,
        });
      } else if (error instanceof RegistryManifestLimitError) {
        console.error(`[weft.system.registry] ${error.message}`, {
          workflowType: error.workflowType,
        });
      } else if (error instanceof RegistryWorkflowCountLimitError) {
        console.error(`[weft.system.registry] ${error.message}`, {
          count: error.count,
        });
      }
      throw error;
    }
  },
});

export const getRegistryRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry',
  pathParamNames: [],
  operationName: 'weft.system.registry',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  // `RegistrySchemaConversionError` details are logged in `invoke`; the
  // shared REST fault path keeps the wire response masked.
};
