import { record, records } from './protocol.test-support.ts';
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

import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';

type RegistryEntry = z.core.$ZodType;
type JsonSchemaRegistry = z.core.$ZodRegistry<{ id?: string | undefined }>;
type JsonSchemaRegistryResult = {
  schemas: Record<string, z.core.ZodStandardJSONSchemaPayload<RegistryEntry>>;
};

function installMockedJsonSchema(
  original: typeof z.toJSONSchema,
  mode: 'fallback' | 'defs',
): typeof z.toJSONSchema {
  function mocked<T extends z.core.$ZodType>(
    schema: T,
    params?: z.core.ToJSONSchemaParams,
  ): z.core.ZodStandardJSONSchemaPayload<T> {
    const mockedSchema = original(schema, params);
    delete mockedSchema['$schema'];
    Object.assign(
      mockedSchema,
      mode === 'fallback'
        ? { type: 'object', properties: [], required: ['id'], $defs: [] }
        : {
            properties: { shared: { $ref: '#/$defs/Shared' } },
            required: ['shared'],
            $defs: {
              Shared: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          },
    );
    return mockedSchema;
  }
  function overloadedMocked<T extends z.core.$ZodType>(
    schema: T,
    params?: z.core.ToJSONSchemaParams,
  ): z.core.ZodStandardJSONSchemaPayload<T>;
  function overloadedMocked(
    registry: JsonSchemaRegistry,
    params?: z.core.RegistryToJSONSchemaParams,
  ): JsonSchemaRegistryResult;
  function overloadedMocked(
    schema: JsonSchemaRegistry | z.core.$ZodType,
    params?: z.core.ToJSONSchemaParams | z.core.RegistryToJSONSchemaParams,
  ): z.core.ZodStandardJSONSchemaPayload<z.core.$ZodType> | JsonSchemaRegistryResult {
    if (schema instanceof z.core.$ZodRegistry) {
      return { schemas: {} };
    }
    return mocked(schema, params);
  }
  return overloadedMocked;
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

describe('generateOpenRpcDocument — Codex regressions', () => {
  it('throws when a registry entry violates the object-input invariant at runtime', () => {
    const malformed = {
      name: 'weft.invalid.input',
      summary: 'malformed input fixture',
      tags: [],
      access: { kind: 'public' as const },
      mcpExposable: false,
      destructive: false,
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      inputSchema: z.string(),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    };
    expect(() =>
      generateOpenRpcDocument({
        registry: Reflect.apply(createRegistryDouble, undefined, [[malformed]]),
        transports: ['http'],
      }),
    ).toThrow(/non-object inputSchema/);
  });

  it('tolerates Zod JSON Schema output without $schema and ignores non-object properties/$defs payloads', () => {
    const originalToJsonSchema = z.toJSONSchema;
    const toJsonSchemaSpy = spyOn(z, 'toJSONSchema').mockImplementation(
      installMockedJsonSchema(originalToJsonSchema, 'fallback'),
    );

    try {
      const registry = createOperationRegistry([
        makeOp({
          name: 'weft.schema.fallbacks',
          inputSchema: z.object({ id: z.string() }),
          outputSchema: z.object({}),
        }),
      ]);
      const document = generateOpenRpcDocument({
        registry,
        transports: ['http'],
      });

      const method = records(document['methods'], 'document methods').find(
        (candidate) => candidate['name'] === 'weft.schema.fallbacks',
      )!;
      expect(records(method['params'], 'method params')).toEqual([]);
      expect(record(method['x-weft-paramsSchema'], 'params schema')).toMatchObject({
        type: 'object',
        properties: [],
        required: ['id'],
      });
    } finally {
      toJsonSchemaSpy.mockRestore();
    }
  });

  it('propagates object-shaped mocked $defs payloads onto emitted content descriptors', () => {
    const originalToJsonSchema = z.toJSONSchema;
    const toJsonSchemaSpy = spyOn(z, 'toJSONSchema').mockImplementation(
      installMockedJsonSchema(originalToJsonSchema, 'defs'),
    );

    try {
      const registry = createOperationRegistry([
        makeOp({
          name: 'weft.schema.mockeddefs',
          inputSchema: z.object({ shared: z.string() }),
          outputSchema: z.object({}),
        }),
      ]);
      const document = generateOpenRpcDocument({
        registry,
        transports: ['http'],
      });

      const method = records(document['methods'], 'document methods').find(
        (candidate) => candidate['name'] === 'weft.schema.mockeddefs',
      )!;
      const params = records(method['params'], 'method params');
      expect(params).toHaveLength(1);
      const firstParameter = record(params[0], 'first parameter');
      const schema = record(firstParameter['schema'], 'parameter schema');
      expect(schema['$defs']).toEqual({
        Shared: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
        },
      });
    } finally {
      toJsonSchemaSpy.mockRestore();
    }
  });

  it('propagates $defs onto each ContentDescriptor so $ref resolves', () => {
    // A nested object schema reused between two fields causes zod to
    // emit a `$ref` pointing into the parent's `$defs`. Without the
    // fix, the extracted `params[].schema` is a bare `$ref` with
    // nothing to resolve against.
    const nested = z.object({ value: z.string() });
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.defs.demo',
        inputSchema: z.object({ a: nested, b: nested }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods').find(
      (m) => m['name'] === 'weft.defs.demo',
    )!;
    const params = records(method['params'], 'method params');
    for (const p of params) {
      const schema = record(p['schema'], 'parameter schema');
      // If the schema references `$defs`, the `$defs` must come along.
      if (typeof schema['$ref'] === 'string' && schema['$ref'].startsWith('#/$defs/')) {
        expect(schema['$defs']).toBeDefined();
      }
    }
  });

  it('the registry cannot admit an rpc.discover operation — name collision is structurally impossible', () => {
    // Codex flagged a theoretical rpc.discover collision. The
    // `OperationRegistry` enforces the naming convention at
    // construction, so no domain operation can ever be named
    // `rpc.discover`.
    //
    // The rule was since relaxed to admit namespaces other than `weft.`,
    // so a shared catalog can carry `operative.*` and `bureau.*`. That
    // relaxation is exactly the future this test's earlier comment warned
    // about, and the invariant is preserved deliberately rather than
    // devolved to the generator's deduplication backstop:
    // `OPERATION_NAME_PATTERN` now excludes the `rpc.` prefix by negative
    // lookahead, which JSON-RPC 2.0 reserves for rpc-internal methods.
    expect(() =>
      createOperationRegistry([
        makeOp({
          name: 'rpc.discover',
          inputSchema: z.object({}),
          outputSchema: z.object({}),
        }),
      ]),
    ).toThrow(/operation name/);
  });
});
