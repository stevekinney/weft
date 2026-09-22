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

import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import { listMcpTools } from '../mcp/tools.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationRegistry,
} from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';

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
      yield { ok: true };
    }),
  );
  engine.register(
    workflow({
      name: 'checkout-flow',
      inputSchema: z.object({ refundId: z.string() }),
    }).execute(async function* () {
      yield { ok: true };
    }),
  );
  return engine;
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

function createRegistryDouble(operations: ReadonlyArray<ErasedOperation>): OperationRegistry {
  const erased = operations;
  return {
    get(name) {
      return erased.find((operation) => operation.name === name);
    },
    list() {
      return erased;
    },
  };
}

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
    const metadata = record(document['x-weft-mcp'], 'document MCP metadata');

    expect(metadata).toEqual({
      discoveryPath: '/.well-known/mcp.json',
      toolDiscoveryMethod: 'tools/list',
      toolNames: ['checkout_flow'],
    });

    const methods = records(document['methods'], 'document methods');
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
    const metadata = record(document['x-weft-mcp'], 'document MCP metadata');
    const metadataToolNames = Array.isArray(metadata['toolNames'])
      ? metadata['toolNames'].filter((name): name is string => typeof name === 'string')
      : [];
    const methods = records(document['methods'], 'document methods');
    const methodToolNames = methods
      .flatMap((method) => {
        const extension = method['x-weft-mcp'];
        if (extension === undefined) return [];
        const toolName =
          extension && typeof extension === 'object' && !Array.isArray(extension)
            ? record(extension, 'MCP extension')['toolName']
            : undefined;
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
