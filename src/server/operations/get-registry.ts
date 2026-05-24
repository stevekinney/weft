/**
 * `weft.system.registry` operation + REST binding.
 *
 * Returns a JSON snapshot of every locally-registered workflow and activity,
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

import type { Engine } from '../../core/engine.ts';
import {
  buildRegistrySnapshot,
  RegistrySchemaConversionError,
  type RegistrySnapshot,
} from '../../core/registry-snapshot.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getRegistryInput = z.object({});

// We validate the response envelope (`registryVersion` and the presence of
// `workflows` / `activities` as objects) but treat the inner dictionaries
// as opaque values rather than running them through `z.record(...)`. The
// reason: `z.record()` rebuilds the input by iterating own keys and
// assigning to a fresh `{}`, which silently drops `__proto__`-named entries
// even though `buildRegistrySnapshot` constructs null-prototype maps that
// preserve them. Trusting the builder's TypeScript types (it returns a
// strongly-typed `RegistrySnapshot`) and pinning the envelope is enough
// for discovery; codegen consumers separately validate the response with
// their own Zod schema (Part 2 of ROADMAP §1).
const objectValue = z
  .unknown()
  .refine((value) => typeof value === 'object' && value !== null && !Array.isArray(value), {
    message: 'expected an object',
  });

const getRegistryOutput = z
  .object({
    registryVersion: z.literal(1),
    workflows: objectValue,
    activities: objectValue,
  })
  .strict();

export type GetRegistryInput = z.infer<typeof getRegistryInput>;
export type GetRegistryOutput = RegistrySnapshot;

export const getRegistryOperation = defineOperation<GetRegistryInput, GetRegistryOutput>({
  name: 'weft.system.registry',
  mcpExposable: false,
  summary: 'Get a snapshot of registered workflows and activities with their JSON Schemas',
  tags: ['System'],
  inputSchema: getRegistryInput,
  outputSchema: getRegistryOutput as z.ZodType<GetRegistryOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:read'] },
  },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetRegistryOutput> => {
    try {
      return buildRegistrySnapshot(engine as Engine);
    } catch (error) {
      // Log the typed conversion error to the server console before the
      // operation pipeline reduces it to a generic `EngineFailure`. The
      // pipeline doesn't capture `error.message`, so without this explicit
      // log the offending entity name and direction would never reach
      // operator-visible output. Re-throw so the pipeline still produces
      // the masked wire response.
      if (error instanceof RegistrySchemaConversionError) {
        console.error(`[weft.system.registry] ${error.message}`, {
          entityKind: error.entityKind,
          entityName: error.entityName,
          direction: error.direction,
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
  shapeSuccess: (output: GetRegistryOutput) =>
    new Response(JSON.stringify(output), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  // `RegistrySchemaConversionError` details are logged in `invoke`; the
  // shared REST shaper keeps the wire response masked.
  shapeFault: shapeRestFault,
};
