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

export function makeOp(overrides: {
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

describe('generateOpenRpcDocument — rpc.discover', () => {
  it('uses a registry-provided rpc.discover once and skips the synthetic duplicate', () => {
    const customDiscover = {
      name: 'rpc.discover',
      mcpExposable: false,
      destructive: false,
      summary: 'custom discover',
      tags: [],
      access: { kind: 'public' as const },
      inputSchema: z.object({}),
      outputSchema: z.object({ custom: z.boolean() }),
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      dispatch: async () => ({ ok: true as const, value: { custom: true } }),
      invoke: async () => ({ custom: true }),
    };
    const document = generateOpenRpcDocument({
      registry: createRegistryDouble([customDiscover]),
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    expect(Array.isArray(methods)).toBe(true);
    if (!Array.isArray(methods)) throw new Error('expected methods array');
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ name: 'rpc.discover', summary: 'custom discover' });
  });

  it('includes rpc.discover as a method', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    const discoverMethod = methods.find((m) => m['name'] === 'rpc.discover');
    expect(discoverMethod).toBeDefined();
    expect(discoverMethod?.['x-weft-access']).toEqual({ kind: 'public' });
  });

  it('requires access metadata in the generated OpenRPC method JSON Schema', () => {
    const document = generateOpenRpcDocument({
      registry: createOperationRegistry([]),
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    const discoverMethod = methods.find((method) => method['name'] === 'rpc.discover')!;
    const result = record(discoverMethod['result'], 'method result');
    const schema = record(result['schema'], 'result schema');
    const properties = record(schema['properties'], 'schema properties');
    const methodsSchema = record(properties['methods'], 'methods schema');
    const methodItems = record(methodsSchema['items'], 'method items');

    expect(methodItems['required']).toContain('x-weft-access');
  });

  it('rpc.discover is listed even when no domain operations are registered', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    expect(methods.length).toBe(1);
    expect(methods[0]!['name']).toBe('rpc.discover');
  });

  it('rpc.discover is omitted when transports is empty', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: [],
    });
    const methods = records(document['methods'], 'document methods');
    expect(methods.length).toBe(0);
  });
});
