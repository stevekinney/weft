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
import { records } from './protocol.test-support.ts';

import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

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

describe('generateOpenRpcDocument — runtime filtering', () => {
  it('returns zero methods when transports is empty', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string() }),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: [],
    });
    expect(records(document['methods'], 'document methods')).toHaveLength(0);
  });

  it('excludes operations whose JSON-RPC transports are all disabled', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.http.only',
        transports: {
          http: true,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
      }),
      makeOp({
        name: 'weft.rpc.live',
        transports: {
          http: false,
          jsonRpcHttp: true,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    expect(methods.find((m) => m['name'] === 'weft.http.only')).toBeUndefined();
    expect(methods.find((m) => m['name'] === 'weft.rpc.live')).toBeDefined();
  });

  it('omits methods whose required transport is not enabled (e.g. WS-only subscribe on HTTP-only runtime)', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.subscribe',
        transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: true },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods');
    expect(methods.find((m) => m['name'] === 'weft.workflows.subscribe')).toBeUndefined();
    // `rpc.discover` is always listed when JSON-RPC is enabled.
    expect(methods.find((m) => m['name'] === 'rpc.discover')).toBeDefined();
  });

  it('omits REST-only SSE operations from JSON-RPC discovery', () => {
    const document = generateOpenRpcDocument({
      registry: createLiveOperationRegistry(),
      transports: ['http', 'websocket'],
    });
    const methodNames = records(document['methods'], 'document methods').map((method) =>
      String(method['name']),
    );

    expect(methodNames).not.toContain('weft.workflows.events.sse');
    expect(methodNames).not.toContain('weft.events.sse');
  });

  it('includes methods that are live only on websocket or stdio transports', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.ws.only',
        transports: {
          http: false,
          jsonRpcHttp: false,
          jsonRpcWebSocket: true,
          jsonRpcStdio: false,
        },
      }),
      makeOp({
        name: 'weft.stdio.only',
        transports: {
          http: false,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: true,
        },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['websocket', 'stdio'],
    });
    const methods = records(document['methods'], 'document methods');
    expect(methods.find((method) => method['name'] === 'weft.ws.only')).toBeDefined();
    expect(methods.find((method) => method['name'] === 'weft.stdio.only')).toBeDefined();
  });

  it('treats unknown runtime transports as unavailable without crashing the document generator', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string() }),
      }),
    ]);
    const document = Reflect.apply(generateOpenRpcDocument, undefined, [
      { registry, transports: ['bogus'] },
    ]);
    const methods = records(document['methods'], 'document methods');
    expect(methods.map((method) => method['name'])).toEqual(['rpc.discover']);
  });
});
