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

describe('generateOpenRpcDocument — info and servers', () => {
  it('uses custom title and version when provided', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
      title: 'Weft Custom',
      version: '9.9.9',
    });
    const info = record(document['info'], 'document info');
    expect(info['title']).toBe('Weft Custom');
    expect(info['version']).toBe('9.9.9');
  });

  it('includes a servers array when serverUrl is provided', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
      serverUrl: 'https://example.test',
    });
    expect(Array.isArray(records(document['servers'], 'document servers'))).toBe(true);
    const servers = records(document['servers'], 'document servers');
    expect(servers[0]!['url']).toBe('https://example.test');
  });

  it('omits servers when serverUrl is not provided', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    expect(document['servers']).toBeUndefined();
  });
});
