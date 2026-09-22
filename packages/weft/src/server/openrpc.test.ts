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

import { VERSION } from '../version.ts';
import { accessPolicyMetadataExamples } from './access-policy-metadata.test-support.ts';
import { OpenRpcDocumentSchema } from './openrpc-document-schema.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';
import { isRecord } from './protocol.test-support.ts';

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

describe('generateOpenRpcDocument — basic shape', () => {
  it('emits openrpc 1.3.2 with info and a methods array', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string() }),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http', 'websocket', 'stdio'],
    });
    expect(document['openrpc']).toBe('1.3.2');
    expect(typeof document['info']).toBe('object');
    const info = isRecord(document['info']) ? document['info'] : undefined;
    expect(info?.['title']).toBeDefined();
    expect(info?.['version']).toBe(VERSION);
    expect(Array.isArray(document['methods'])).toBe(true);
  });

  it('advertises every operation access policy with faithful scope semantics', () => {
    const registry = createOperationRegistry(
      accessPolicyMetadataExamples.map(({ segment, access }) =>
        makeOp({ name: `weft.policy.${segment}`, access, discoverable: true }),
      ),
    );

    const document = generateOpenRpcDocument({ registry, transports: ['http'] });
    const methods = document['methods'];
    expect(Array.isArray(methods)).toBe(true);
    if (!Array.isArray(methods)) throw new Error('expected methods to be an array');
    const methodRecords = methods.filter(isRecord);

    for (const { segment, expected } of accessPolicyMetadataExamples) {
      const method = methodRecords.find(
        (candidate) => candidate['name'] === `weft.policy.${segment}`,
      );
      expect(method?.['x-weft-access']).toEqual(expected);
    }
    expect(OpenRpcDocumentSchema.parse(document) as unknown).toEqual(document);
  });

  it('does not advertise a stale root /jsonrpc or /mcp endpoint URL', () => {
    // The live OpenRPC handler emits no `servers` URL, so the document must not
    // leak a root-relative transport endpoint outside current API routing.
    // This guards against a regression that hardcodes `/jsonrpc` or `/mcp`.
    const document = generateOpenRpcDocument({
      registry: createOperationRegistry([
        makeOp({
          name: 'weft.workflows.get',
          inputSchema: z.object({ id: z.string() }),
          outputSchema: z.object({ id: z.string() }),
        }),
      ]),
      transports: ['http', 'websocket'],
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('"/jsonrpc"');
    expect(serialized).not.toContain('"/mcp"');
  });

  it('includes weft.workflows.get when JSON-RPC is enabled and supported', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string() }),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http', 'websocket'],
    });
    const methods = document['methods'];
    expect(Array.isArray(methods)).toBe(true);
    if (!Array.isArray(methods)) throw new Error('expected methods to be an array');
    const get = methods.filter(isRecord).find((m) => m['name'] === 'weft.workflows.get');
    expect(get).toBeDefined();
  });

  it('JSON-RPC uses named params only. The OpenRPC contract documents paramStructure: "by-name" so generated clients and manual callers converge on one request shape.', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.a.b',
        inputSchema: z.object({ x: z.string() }),
        outputSchema: z.object({}),
      }),
      makeOp({
        name: 'weft.c.d',
        inputSchema: z.object({ y: z.number() }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = document['methods'];
    expect(Array.isArray(methods)).toBe(true);
    if (!Array.isArray(methods)) throw new Error('expected methods to be an array');
    // 2 domain methods + `rpc.discover`.
    expect(methods.length).toBe(3);
    for (const method of methods.filter(isRecord)) {
      expect(method['paramStructure']).toBe('by-name');
    }
  });
});
