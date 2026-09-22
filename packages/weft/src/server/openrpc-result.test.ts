/**
 * Tests for the OpenRPC 1.3.2 document generator.
 *
 * `generateOpenRpcDocument` intersects the `OperationRegistry` with the
 * requested JSON-RPC transports in `OpenRpcOptions.transports`:
 *   - `transports: []` → zero methods (and no synthetic rpc.discover).
 *   - `transports: ['http']` → WS-only subscribe methods are omitted.
 *   - Every listed method carries `paramStructure: 'by-name'` plus both the
 *     per-field `ContentDescriptor` surface and an `x-weft-paramsSchema`
 *     extension (the authoritative top-level object schema with
 *     `additionalProperties` computed from `unknownKeyPolicy.jsonRpc`).
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { record, records } from './protocol.test-support.ts';

import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';

function directionalSchema(): z.ZodType {
  const schema = z.custom<unknown>();
  Object.defineProperty(schema, '~standard', {
    configurable: true,
    value: {
      version: 1,
      vendor: 'openrpc-output-direction',
      jsonSchema: {
        input: () => ({ type: 'object', properties: { beforeParse: { type: 'string' } } }),
        output: () => ({ type: 'string' }),
      },
    },
  });
  return schema;
}

function makeOp(overrides: {
  readonly name: string;
  readonly inputSchema?: z.ZodObject;
  readonly outputSchema?: z.ZodType;
  readonly access?: import('./authorization.ts').AccessPolicy;
  readonly discoverable?: boolean;
  readonly mcpExposable?: boolean;
  readonly mcpTool?: { readonly workflowType: string };
  readonly summary?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly destructive?: boolean;
  readonly transports?: {
    readonly http: boolean;
    readonly jsonRpcHttp: boolean;
    readonly jsonRpcWebSocket: boolean;
    readonly jsonRpcStdio: boolean;
  };
  readonly unknownKeyPolicy?: {
    readonly http: 'reject' | 'strip' | 'passthrough';
    readonly jsonRpc: 'reject' | 'strip' | 'passthrough';
  };
  readonly parameterizedAccess?: ParameterizedAccessHint;
}): UnarySchemaOperationDefinition<z.ZodObject, z.ZodType> {
  return defineOperation({
    mcpExposable: false,
    destructive: false,
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    inputSchema: overrides.inputSchema ?? z.looseObject({}),
    outputSchema: overrides.outputSchema ?? z.object({}),
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
    invoke: async () => ({}),
  });
}

export function createRegistryDouble(
  operations: ReadonlyArray<import('./operation-catalog.ts').ErasedOperation>,
): OperationRegistry {
  return {
    get(name) {
      return operations.find((operation) => operation.name === name);
    },
    list() {
      return operations;
    },
  };
}

describe('generateOpenRpcDocument — result, tags, nested shapes', () => {
  it('uses output-direction JSON Schema for result descriptors', () => {
    const document = generateOpenRpcDocument({
      registry: createOperationRegistry([
        makeOp({
          name: 'weft.directional.result',
          inputSchema: z.object({ id: z.string() }),
          outputSchema: directionalSchema(),
        }),
      ]),
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    expect(Array.isArray(methods)).toBe(true);
    if (!Array.isArray(methods)) throw new Error('expected methods array');
    const method = methods.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        candidate['name'] === 'weft.directional.result',
    );
    expect(method).toBeDefined();
    if (method === undefined || typeof method !== 'object' || method === null) {
      throw new Error('expected directional method');
    }
    const result = record(method['result'], 'method result');
    expect(result).toMatchObject({ schema: { type: 'string' } });
  });

  it('emits a result ContentDescriptor with name, required, and schema', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string(), status: z.string() }),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods').find(
      (m) => m['name'] === 'weft.workflows.get',
    )!;
    const result = record(method['result'], 'method result');
    expect(result['name']).toBe('result');
    expect(result['required']).toBe(true);
    const schema = record(result['schema'], 'result schema');
    expect(schema['type']).toBe('object');
    expect(typeof record(schema['properties'], 'schema properties')).toBe('object');
  });

  it('sorts tags alphabetically on the emitted method', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.tagged.op',
        tags: ['zebra', 'alpha', 'mango'],
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods').find(
      (m) => m['name'] === 'weft.tagged.op',
    )!;
    const tags = records(method['tags'], 'method tags');
    expect(tags.map((tag) => record(tag, 'tag')['name'])).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('preserves nested .strict() additionalProperties=false in x-weft-paramsSchema.properties', () => {
    // The generator's contract: nested objects retain whatever
    // `additionalProperties` zod emits from their own strict / strip /
    // passthrough mode. The top-level `additionalProperties` is
    // stamped by `unknownKeyPolicy.jsonRpc`; nested behavior is the
    // schema's own responsibility.
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.nested.strict',
        inputSchema: z.object({
          sub: z.strictObject({ x: z.string() }),
        }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods').find(
      (m) => m['name'] === 'weft.nested.strict',
    )!;
    const paramsSchema = record(method['x-weft-paramsSchema'], 'params schema');
    const properties = record(paramsSchema['properties'], 'params properties');
    const sub = record(properties['sub'], 'sub schema');
    expect(sub['type']).toBe('object');
    expect(sub['additionalProperties']).toBe(false);
  });
});
