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

import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import type { StandardJSONSchemaV1 } from '../core/types/definition-schema.ts';
import { listMcpTools } from '../mcp/tools.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { VERSION } from '../version.ts';
import { OpenRpcDocumentSchema } from './openrpc-document-schema.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationRegistry,
  type RegistrableOperation,
} from './operation-catalog.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function createMcpEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  // Two workflow names that collapse to the same MCP tool name after
  // normalization — the dedup test pins that downstream behavior.
  engine.register(
    workflow({
      name: 'checkout_flow',
      inputSchema: z.object({ orderId: z.string() }),
    }).execute(async function* () {
      return { ok: true };
    }),
  );
  engine.register(
    workflow({
      name: 'checkout-flow',
      inputSchema: z.object({ refundId: z.string() }),
    }).execute(async function* () {
      return { ok: true };
    }),
  );
  return engine;
}

function makeOp(
  overrides: Partial<RegistrableOperation> & Pick<RegistrableOperation, 'name'>,
): RegistrableOperation {
  return {
    mcpExposable: false,
    destructive: false,
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({}),
    ...overrides,
  };
}

function createRegistryDouble(operations: ReadonlyArray<RegistrableOperation>): OperationRegistry {
  const erased = operations as unknown as ReadonlyArray<ErasedOperation>;
  return {
    get(name) {
      return erased.find((operation) => operation.name === name);
    },
    list() {
      return erased;
    },
  };
}

function makeDirectionalSchema(
  vendor: string,
  inputShape: Record<string, unknown>,
  outputShape: Record<string, unknown>,
): StandardJSONSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor,
      jsonSchema: {
        input: () => inputShape,
        output: () => outputShape,
      },
    },
  };
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
    expect((document['info'] as Record<string, unknown>)['title']).toBeDefined();
    expect((document['info'] as Record<string, unknown>)['version']).toBe(VERSION);
    expect(Array.isArray(document['methods'])).toBe(true);
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
    const methods = document['methods'] as Array<Record<string, unknown>>;
    const get = methods.find((m) => m['name'] === 'weft.workflows.get');
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
    const methods = document['methods'] as Array<Record<string, unknown>>;
    // 2 domain methods + `rpc.discover`.
    expect(methods.length).toBe(3);
    for (const method of methods) {
      expect(method['paramStructure']).toBe('by-name');
    }
  });
});

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
    expect((document['methods'] as unknown[]).length).toBe(0);
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
    const methods = document['methods'] as Array<Record<string, unknown>>;
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
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.find((m) => m['name'] === 'weft.workflows.subscribe')).toBeUndefined();
    // `rpc.discover` is always listed when JSON-RPC is enabled.
    expect(methods.find((m) => m['name'] === 'rpc.discover')).toBeDefined();
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
    const methods = document['methods'] as Array<Record<string, unknown>>;
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
    const document = generateOpenRpcDocument({
      registry,
      transports: ['bogus' as never],
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.map((method) => method['name'])).toEqual(['rpc.discover']);
  });
});

describe('generateOpenRpcDocument — params schema fidelity', () => {
  it('emits a ContentDescriptor per top-level input field', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.signal',
        inputSchema: z.object({
          id: z.string(),
          name: z.string(),
          payload: z.unknown(),
        }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (m) => m['name'] === 'weft.workflows.signal',
    )!;
    const params = method['params'] as Array<Record<string, unknown>>;
    const sortedNames = params.map((p) => p['name'] as string).toSorted(byString);
    expect(sortedNames).toEqual(['id', 'name', 'payload']);
    for (const p of params) {
      expect(typeof p['schema']).toBe('object');
    }
  });

  it('emits x-weft-paramsSchema with additionalProperties=false when unknownKeyPolicy.jsonRpc is reject', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = (document['methods'] as Array<Record<string, unknown>>)[0]!;
    const paramsSchema = method['x-weft-paramsSchema'] as Record<string, unknown>;
    expect(paramsSchema).toBeDefined();
    expect(paramsSchema['type']).toBe('object');
    expect(paramsSchema['additionalProperties']).toBe(false);
  });

  it('emits parameterized access metadata for selector-scoped operations', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.events',
        inputSchema: z.object({ selector: z.enum(['events', 'tokens']).optional() }),
        outputSchema: z.object({ subscriptionId: z.string() }),
        access: { kind: 'authenticated' },
        discoverable: true,
        parameterizedAccess: {
          discriminator: 'selector',
          defaultValue: 'events',
          variants: [
            {
              value: 'events',
              access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
            },
            {
              value: 'tokens',
              access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
            },
          ],
        },
      }),
    ]);
    const document = generateOpenRpcDocument({ registry, transports: ['websocket'] });
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (candidate) => candidate['name'] === 'weft.workflows.events',
    )!;

    expect(method['x-weft-parameterizedAccess']).toEqual({
      discriminator: 'selector',
      defaultValue: 'events',
      variants: [
        {
          value: 'events',
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
        },
        {
          value: 'tokens',
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
        },
      ],
    });
  });

  it('emits parameterized access metadata for optional and alternative scope policies', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.policy.example',
        inputSchema: z.object({ mode: z.enum(['optional', 'alternative']).optional() }),
        outputSchema: z.object({ ok: z.boolean() }),
        access: { kind: 'authenticated' },
        discoverable: true,
        parameterizedAccess: {
          discriminator: 'mode',
          variants: [
            {
              value: 'optional',
              access: {
                kind: 'optionalAuth',
                authenticatedScopes: { kind: 'anyOf', scopes: ['events:read'] },
              },
            },
            {
              value: 'alternative',
              access: {
                kind: 'scopedAlternatives',
                alternatives: [
                  { kind: 'anyOf', scopes: ['events:read'] },
                  { kind: 'anyOf', scopes: ['streams:read'] },
                ],
              },
            },
          ],
        },
      }),
    ]);

    const document = generateOpenRpcDocument({ registry, transports: ['http'] });
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (candidate) => candidate['name'] === 'weft.policy.example',
    )!;

    expect(method['x-weft-parameterizedAccess']).toEqual({
      discriminator: 'mode',
      variants: [
        {
          value: 'optional',
          access: {
            kind: 'optionalAuth',
            authenticatedScopes: { kind: 'anyOf', scopes: ['events:read'] },
          },
        },
        {
          value: 'alternative',
          access: {
            kind: 'scopedAlternatives',
            alternatives: [
              { kind: 'anyOf', scopes: ['events:read'] },
              { kind: 'anyOf', scopes: ['streams:read'] },
            ],
          },
        },
      ],
    });
  });

  it('emits x-weft-paramsSchema with additionalProperties=true when unknownKeyPolicy.jsonRpc is strip or passthrough', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.permissive.strip',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'strip' },
      }),
      makeOp({
        name: 'weft.permissive.passthrough',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'passthrough' },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = (document['methods'] as Array<Record<string, unknown>>).filter(
      (m) => m['name'] !== 'rpc.discover',
    );
    expect(methods.length).toBe(2);
    for (const method of methods) {
      const paramsSchema = method['x-weft-paramsSchema'] as Record<string, unknown>;
      expect(paramsSchema['additionalProperties']).toBe(true);
    }
  });

  it('ContentDescriptor names exactly match x-weft-paramsSchema properties (drift guard)', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.start',
        inputSchema: z.object({
          id: z.string(),
          input: z.unknown(),
          scheduleAt: z.number().optional(),
        }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = (document['methods'] as Array<Record<string, unknown>>)[0]!;
    const params = method['params'] as Array<Record<string, unknown>>;
    const paramsSchema = method['x-weft-paramsSchema'] as Record<string, unknown>;
    const descriptorNames = params.map((p) => p['name'] as string).toSorted(byString);
    const schemaProperties = Object.keys(paramsSchema['properties'] as object).toSorted(byString);
    expect(descriptorNames).toEqual(schemaProperties);
  });
});

describe('generateOpenRpcDocument — rpc.discover', () => {
  it('includes rpc.discover as a method', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.find((m) => m['name'] === 'rpc.discover')).toBeDefined();
  });

  it('rpc.discover is listed even when no domain operations are registered', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.length).toBe(1);
    expect(methods[0]!['name']).toBe('rpc.discover');
  });

  it('rpc.discover is omitted when transports is empty', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: [],
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.length).toBe(0);
  });
});

describe('generateOpenRpcDocument — info and servers', () => {
  it('uses custom title and version when provided', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
      title: 'Weft Custom',
      version: '9.9.9',
    });
    const info = document['info'] as Record<string, unknown>;
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
    expect(Array.isArray(document['servers'])).toBe(true);
    const servers = document['servers'] as Array<Record<string, unknown>>;
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

describe('generateOpenRpcDocument — MCP metadata', () => {
  it('emits x-weft-mcp metadata for MCP-exposable operations and the live MCP discovery surface', () => {
    const engine = createMcpEngine();
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.checkout.start',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'checkout-flow' },
        inputSchema: z.object({ orderId: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
        discoverable: true,
      }),
      makeOp({
        name: 'weft.workflows.internal.start',
        mcpExposable: false,
        destructive: false,
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
      }),
    ]);

    const document = generateOpenRpcDocument({
      registry,
      transports: ['http', 'websocket'],
      mcpTools: listMcpTools(engine),
    });
    const metadata = document['x-weft-mcp'] as Record<string, unknown>;

    expect(metadata).toEqual({
      discoveryPath: '/.well-known/mcp.json',
      toolDiscoveryMethod: 'tools/list',
      toolNames: ['checkout_flow'],
    });

    const methods = document['methods'] as Array<Record<string, unknown>>;
    const checkout = methods.find(
      (candidate) => candidate['name'] === 'weft.workflows.checkout.start',
    );
    const internal = methods.find(
      (candidate) => candidate['name'] === 'weft.workflows.internal.start',
    );
    expect(checkout?.['x-weft-mcp']).toEqual({
      workflowType: 'checkout-flow',
      toolName: 'checkout_flow',
      toolDiscovery: {
        method: 'tools/list',
        source: 'live',
      },
    });
    expect(internal?.['x-weft-mcp']).toBeUndefined();
  });

  it('keeps the root MCP tool list in parity with method-level live MCP tool names', () => {
    const engine = createMcpEngine();
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.checkout.start',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'checkout_flow' },
        inputSchema: z.object({ orderId: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
        discoverable: true,
      }),
      makeOp({
        name: 'weft.workflows.refund.start',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'checkout-flow' },
        inputSchema: z.object({ refundId: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
        discoverable: true,
      }),
    ]);

    const liveToolNames = listMcpTools(engine).map((tool) => tool.name);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
      mcpTools: listMcpTools(engine),
    });
    const metadata = document['x-weft-mcp'] as { toolNames?: string[] };
    const metadataToolNames = metadata.toolNames ?? [];
    const methods = document['methods'] as Array<Record<string, unknown>>;
    const methodToolNames = methods
      .flatMap((method) => {
        const extension = method['x-weft-mcp'];
        if (extension === undefined) return [];
        const toolName = (extension as { toolName?: unknown }).toolName;
        return typeof toolName === 'string' ? [toolName] : [];
      })
      .toSorted(byString);

    expect(metadataToolNames.toSorted(byString)).toEqual(['checkout_flow', 'checkout_flow_2']);
    expect(methodToolNames).toEqual(metadataToolNames.toSorted(byString));
    for (const toolName of methodToolNames) {
      expect(liveToolNames).toContain(toolName);
    }
  });

  it('rejects MCP-exposable operations that cannot be mapped to live tools/list output', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.missing.start',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'missing-workflow' },
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
        discoverable: true,
      }),
    ]);

    expect(() =>
      generateOpenRpcDocument({
        registry,
        transports: ['http'],
        mcpTools: [],
      }),
    ).toThrow(/live MCP tools\/list/);
  });

  it('rejects MCP-exposable operations missing workflow tool metadata', () => {
    const registry = createRegistryDouble([
      makeOp({
        name: 'weft.workflows.unmapped.start',
        mcpExposable: true,
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
        discoverable: true,
      }),
    ]);

    expect(() =>
      generateOpenRpcDocument({
        registry,
        transports: ['http'],
        mcpTools: [],
      }),
    ).toThrow(/lacks mcpTool\.workflowType metadata/);
  });

  it('rejects MCP-exposable operations when live MCP tool metadata is absent', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.checkout.start',
        mcpExposable: true,
        mcpTool: { workflowType: 'checkout-flow' },
        inputSchema: z.object({ orderId: z.string() }),
        outputSchema: z.object({ workflowId: z.string(), status: z.string() }),
        discoverable: true,
      }),
    ]);

    expect(() =>
      generateOpenRpcDocument({
        registry,
        transports: ['http'],
      }),
    ).toThrow(/no live MCP tools\/list metadata/);
  });
});

describe('generateOpenRpcDocument — result, tags, nested shapes', () => {
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
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (m) => m['name'] === 'weft.workflows.get',
    )!;
    const result = method['result'] as Record<string, unknown>;
    expect(result['name']).toBe('result');
    expect(result['required']).toBe(true);
    const schema = result['schema'] as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(typeof schema['properties']).toBe('object');
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
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (m) => m['name'] === 'weft.tagged.op',
    )!;
    const tags = method['tags'] as Array<{ name: string }>;
    expect(tags.map((t) => t.name)).toEqual(['alpha', 'mango', 'zebra']);
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
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (m) => m['name'] === 'weft.nested.strict',
    )!;
    const paramsSchema = method['x-weft-paramsSchema'] as Record<string, unknown>;
    const properties = paramsSchema['properties'] as Record<string, Record<string, unknown>>;
    const sub = properties['sub']!;
    expect(sub['type']).toBe('object');
    expect(sub['additionalProperties']).toBe(false);
  });
});

describe('generateOpenRpcDocument — Codex regressions', () => {
  it('tolerates Zod JSON Schema output without $schema and ignores non-object properties/$defs payloads', () => {
    const toJsonSchemaSpy = spyOn(z, 'toJSONSchema').mockImplementation((() => {
      return {
        type: 'object',
        properties: [],
        required: ['id'],
        $defs: [],
      } as unknown as ReturnType<typeof z.toJSONSchema>;
    }) as never);

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

      const method = (document['methods'] as Array<Record<string, unknown>>).find(
        (candidate) => candidate['name'] === 'weft.schema.fallbacks',
      )!;
      expect(method['params']).toEqual([]);
      expect(method['x-weft-paramsSchema']).toMatchObject({
        type: 'object',
        properties: [],
        required: ['id'],
      });
    } finally {
      toJsonSchemaSpy.mockRestore();
    }
  });

  it('propagates object-shaped mocked $defs payloads onto emitted content descriptors', () => {
    const toJsonSchemaSpy = spyOn(z, 'toJSONSchema').mockImplementation((() => {
      return {
        type: 'object',
        properties: {
          shared: { $ref: '#/$defs/Shared' },
        },
        required: ['shared'],
        $defs: {
          Shared: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
        },
      } as unknown as ReturnType<typeof z.toJSONSchema>;
    }) as never);

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

      const method = (document['methods'] as Array<Record<string, unknown>>).find(
        (candidate) => candidate['name'] === 'weft.schema.mockeddefs',
      )!;
      const params = method['params'] as Array<Record<string, unknown>>;
      expect(params).toHaveLength(1);
      expect((params[0]!['schema'] as Record<string, unknown>)['$defs']).toEqual({
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
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (m) => m['name'] === 'weft.defs.demo',
    )!;
    const params = method['params'] as Array<Record<string, unknown>>;
    for (const p of params) {
      const schema = p['schema'] as Record<string, unknown>;
      // If the schema references `$defs`, the `$defs` must come along.
      if (typeof schema['$ref'] === 'string' && schema['$ref'].startsWith('#/$defs/')) {
        expect(schema['$defs']).toBeDefined();
      }
    }
  });

  it('uses a registry-provided rpc.discover once and skips the synthetic duplicate', () => {
    const registry = createRegistryDouble([
      makeOp({
        name: 'rpc.discover',
        summary: 'custom discover',
        inputSchema: z.object({}),
        outputSchema: z.object({ custom: z.boolean() }),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods).toHaveLength(1);
    expect(methods[0]!['name']).toBe('rpc.discover');
    expect(methods[0]!['summary']).toBe('custom discover');
  });

  it('uses output-direction JSON Schema for result descriptors', () => {
    const outputSchema = makeDirectionalSchema(
      'openrpc-output-direction',
      { type: 'object', properties: { beforeParse: { type: 'string' } } },
      { type: 'string' },
    );
    const registry = createRegistryDouble([
      makeOp({
        name: 'weft.directional.result',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: outputSchema as unknown as RegistrableOperation['outputSchema'],
      }),
    ]);

    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = (document['methods'] as Array<Record<string, unknown>>).find(
      (candidate) => candidate['name'] === 'weft.directional.result',
    )!;
    const result = method['result'] as Record<string, unknown>;

    expect(result['schema']).toEqual({ type: 'string' });
  });

  it('throws when a registry entry violates the object-input invariant at runtime', () => {
    const registry = createRegistryDouble([
      makeOp({
        name: 'weft.invalid.input',
        inputSchema: z.string() as unknown as RegistrableOperation['inputSchema'],
        outputSchema: z.object({}),
      }),
    ]);
    expect(() =>
      generateOpenRpcDocument({
        registry,
        transports: ['http'],
      }),
    ).toThrow(/non-object inputSchema/);
  });

  it('the registry cannot admit an rpc.discover operation — name collision is structurally impossible', () => {
    // Codex flagged a theoretical rpc.discover collision. The
    // `OperationRegistry` enforces the `weft.<segment>.<segment>`
    // naming convention at construction, so no domain operation can
    // ever be named `rpc.discover`. This test pins that invariant —
    // if the naming rule is relaxed in the future, the generator's
    // deduplication guard (documented in `generateOpenRpcDocument`)
    // is the backstop.
    expect(() =>
      createOperationRegistry([
        makeOp({
          name: 'rpc.discover',
          inputSchema: z.object({}),
          outputSchema: z.object({}),
        }),
      ]),
    ).toThrow(/weft\./);
  });
});

describe('OpenRPC document schema round-trip', () => {
  it('the live /openrpc.json output validates against the committed minimal OpenRpcDocument schema', () => {
    // Drives the same generator the runtime route handler uses, then
    // parses the result through `OpenRpcDocumentSchema`. If the schema
    // drifts from the live shape (e.g. a generator change adds a field
    // that the schema rejects), this test fails — pinning the schema as
    // the canonical contract description.
    const document = generateOpenRpcDocument({
      registry: createLiveOperationRegistry(),
      transports: ['http', 'websocket'],
    });
    const parsed = OpenRpcDocumentSchema.safeParse(document);
    if (!parsed.success) {
      throw new Error(
        `OpenRpcDocument schema rejected the live document: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data as unknown).toEqual(document);
  });
});
