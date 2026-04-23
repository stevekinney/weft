/**
 * Tests for the OpenRPC 1.3.2 document generator.
 *
 * `generateOpenRpcDocument` intersects the `OperationRegistry` with the
 * live JSON-RPC transport availability (from `ServeOptions.jsonRpc`) so
 * a document always describes the actually-running server:
 *   - `jsonRpc.enabled: false` → zero methods.
 *   - `jsonRpc.transports: ['http']` → WS-only subscribe methods are omitted.
 *   - Every listed method carries `paramStructure: 'by-name'` plus both the
 *     per-field `ContentDescriptor` surface and an `x-weft-paramsSchema`
 *     extension (the authoritative top-level object schema with
 *     `additionalProperties` computed from `unknownKeyPolicy.jsonRpc`).
 *
 * Track 8 design decisions 9, 15, and "OpenAPI / OpenRPC generation."
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry, type RegistrableOperation } from './operation-catalog.ts';

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function makeOp(
  overrides: Partial<RegistrableOperation> & Pick<RegistrableOperation, 'name'>,
): RegistrableOperation {
  return {
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
      jsonRpc: { enabled: true, transports: ['http', 'websocket', 'stdio'] },
    });
    expect(document['openrpc']).toBe('1.3.2');
    expect(typeof document['info']).toBe('object');
    expect((document['info'] as Record<string, unknown>)['title']).toBeDefined();
    expect((document['info'] as Record<string, unknown>)['version']).toBeDefined();
    expect(Array.isArray(document['methods'])).toBe(true);
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
      jsonRpc: { enabled: true, transports: ['http', 'websocket'] },
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    const get = methods.find((m) => m['name'] === 'weft.workflows.get');
    expect(get).toBeDefined();
  });

  it('uses paramStructure: "by-name" on every method', () => {
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
  it('returns zero methods when jsonRpc.enabled is false', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string() }),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      jsonRpc: { enabled: false, transports: [] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.find((m) => m['name'] === 'weft.workflows.subscribe')).toBeUndefined();
    // `rpc.discover` is always listed when JSON-RPC is enabled.
    expect(methods.find((m) => m['name'] === 'rpc.discover')).toBeDefined();
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
    });
    const method = (document['methods'] as Array<Record<string, unknown>>)[0]!;
    const paramsSchema = method['x-weft-paramsSchema'] as Record<string, unknown>;
    expect(paramsSchema).toBeDefined();
    expect(paramsSchema['type']).toBe('object');
    expect(paramsSchema['additionalProperties']).toBe(false);
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.find((m) => m['name'] === 'rpc.discover')).toBeDefined();
  });

  it('rpc.discover is listed even when no domain operations are registered', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      jsonRpc: { enabled: true, transports: ['http'] },
    });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    expect(methods.length).toBe(1);
    expect(methods[0]!['name']).toBe('rpc.discover');
  });

  it('rpc.discover is omitted when JSON-RPC is disabled', () => {
    const registry = createOperationRegistry([]);
    const document = generateOpenRpcDocument({
      registry,
      jsonRpc: { enabled: false, transports: [] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
      jsonRpc: { enabled: true, transports: ['http'] },
    });
    expect(document['servers']).toBeUndefined();
  });
});

describe('generateOpenRpcDocument — Codex regressions', () => {
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
      jsonRpc: { enabled: true, transports: ['http'] },
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
