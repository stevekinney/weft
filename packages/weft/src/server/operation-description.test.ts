/**
 * Regression coverage for the per-operation `description` field added to the
 * operation catalog (task fecf0300).
 *
 * `description` is an OPTIONAL longer-form companion to the mandatory short
 * `summary`. Where an operation declares it, the value must flow through to:
 *   - `/openapi.json`   — the OpenAPI operation object's `description`
 *   - `/openrpc.json`   — the OpenRPC method object's `description` (and the
 *                          strict OpenRPC document schema must accept it)
 *   - the catalog snapshot the CLI reads for `weft api --describe`
 *
 * The `/.well-known/mcp.json` discovery document is pure transport-discovery
 * metadata and intentionally enumerates no operations; the MCP-facing surface
 * for per-operation descriptions is the OpenRPC document it points at via
 * `discovery.openRpc`. That linkage is pinned below.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createCatalogSnapshot } from '../cli/operation-catalog-snapshot.ts';
import { MAX_BATCH_OPERATIONS } from '../storage/interface.ts';
import { generateMcpDiscovery } from './mcp-discovery.ts';
import { emitBindings, generateOpenApiDocument } from './openapi.ts';
import { OpenRpcDocumentSchema } from './openrpc-document-schema.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

const DESCRIBED_OPERATION_DESCRIPTION =
  'Longer-form prose describing what this operation does, its key inputs, and notable faults.';

function describedOperation() {
  return defineOperation({
    name: 'weft.test.described',
    mcpExposable: false,
    destructive: false,
    summary: 'short summary',
    description: DESCRIBED_OPERATION_DESCRIPTION,
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ id: z.string() }),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async () => ({ id: 'x' }),
  });
}

function summaryOnlyOperation() {
  return defineOperation({
    name: 'weft.test.summaryonly',
    mcpExposable: false,
    destructive: false,
    summary: 'just a summary',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ id: z.string() }),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async () => ({ id: 'x' }),
  });
}

const describedBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/test/described',
  pathParamNames: [],
  operationName: 'weft.test.described',
  inputSources: { id: { kind: 'body-field', bodyField: 'id' } },
  extractInput: async (request) => {
    const body = (await request.json()) as Record<string, unknown>;
    return { id: body['id'] };
  },
  success: { kind: 'json', status: 200 },
};

const summaryOnlyBinding: UnknownRestBinding = {
  ...describedBinding,
  path: '/v1/test/summaryonly',
  operationName: 'weft.test.summaryonly',
};

describe('operation catalog description — builder plumbing', () => {
  it('preserves a declared description on the operation definition', () => {
    expect(describedOperation().description).toBe(DESCRIBED_OPERATION_DESCRIPTION);
  });

  it('omits description entirely when not declared (no empty string)', () => {
    expect('description' in summaryOnlyOperation()).toBe(false);
  });
});

describe('operation catalog description — OpenAPI', () => {
  it('emits the description on the OpenAPI operation object when present', () => {
    const registry = createOperationRegistry([describedOperation()]);
    const paths: Record<string, Record<string, unknown>> = {};
    emitBindings(paths, new Set(), [describedBinding], registry);

    const entry = paths['/api/v1/test/described']?.['post'] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(entry['summary']).toBe('short summary');
    expect(entry['description']).toBe(DESCRIBED_OPERATION_DESCRIPTION);
  });

  it('omits the description on the OpenAPI operation object when absent', () => {
    const registry = createOperationRegistry([summaryOnlyOperation()]);
    const paths: Record<string, Record<string, unknown>> = {};
    emitBindings(paths, new Set(), [summaryOnlyBinding], registry);

    const entry = paths['/api/v1/test/summaryonly']?.['post'] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(entry['summary']).toBe('just a summary');
    expect('description' in entry).toBe(false);
  });

  it('carries real interactive-subset descriptions in the live /openapi.json', () => {
    const document = generateOpenApiDocument();
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    // weft.workflows.start is POST /api/v1/workflows.
    const startEntry = paths['/api/v1/workflows']?.['post'];
    expect(startEntry).toBeDefined();
    expect(startEntry!['operationId']).toBe('weft.workflows.start');
    const description = startEntry!['description'];
    const summary = startEntry!['summary'];
    expect(typeof description).toBe('string');
    expect((description as string).length).toBeGreaterThan((summary as string).length);
  });
});

describe('operation catalog description — OpenRPC', () => {
  it('emits the description on the OpenRPC method when present and validates against the strict schema', () => {
    const registry = createOperationRegistry([describedOperation(), summaryOnlyOperation()]);
    const document = generateOpenRpcDocument({ registry, transports: ['http'] });

    // The document must satisfy the committed strict schema; if the schema
    // rejected the new `description` key this parse would throw.
    const parsed = OpenRpcDocumentSchema.parse(document);
    const described = parsed.methods.find((method) => method.name === 'weft.test.described');
    const summaryOnly = parsed.methods.find((method) => method.name === 'weft.test.summaryonly');

    expect(described?.description).toBe(DESCRIBED_OPERATION_DESCRIPTION);
    expect(summaryOnly?.description).toBeUndefined();
  });

  it('carries real interactive-subset descriptions in the live /openrpc.json', () => {
    const document = generateOpenRpcDocument({
      registry: createLiveOperationRegistry(),
      transports: ['http', 'websocket', 'stdio'],
    });
    const parsed = OpenRpcDocumentSchema.parse(document);
    const signal = parsed.methods.find((method) => method.name === 'weft.workflows.signal');
    expect(signal).toBeDefined();
    expect(typeof signal?.description).toBe('string');
    expect((signal?.description ?? '').length).toBeGreaterThan((signal?.summary ?? '').length);
  });
});

describe('operation catalog description — MCP discovery linkage', () => {
  it('routes MCP clients to the OpenRPC document that carries operation descriptions', () => {
    const origin = 'https://api.example.com';
    const discovery = generateMcpDiscovery({ origin });

    // The static discovery document carries no per-operation entries; it points
    // MCP clients at the OpenRPC document, which is where descriptions live.
    expect(discovery.discovery.openRpc).toBe(`${origin}/openrpc.json`);

    const openRpc = OpenRpcDocumentSchema.parse(
      generateOpenRpcDocument({
        registry: createLiveOperationRegistry(),
        transports: ['http', 'websocket', 'stdio'],
      }),
    );
    const start = openRpc.methods.find((method) => method.name === 'weft.workflows.start');
    expect(typeof start?.description).toBe('string');
  });
});

describe('operation catalog description — snapshot', () => {
  it('includes description for the interactive subset and omits it elsewhere', () => {
    const snapshot = createCatalogSnapshot();
    const byName = new Map(snapshot.operations.map((operation) => [operation.name, operation]));

    const cancel = byName.get('weft.workflows.cancel');
    expect(typeof cancel?.description).toBe('string');

    // weft.storage.get is not in the interactive subset and declares no
    // description, so the snapshot must omit the key rather than default it.
    const storageGet = byName.get('weft.storage.get');
    expect(storageGet).toBeDefined();
    expect(storageGet?.description).toBeUndefined();
  });

  it('pins raw storage batch operation-count limits in the catalog schemas', () => {
    const snapshot = createCatalogSnapshot();
    const byName = new Map(snapshot.operations.map((operation) => [operation.name, operation]));

    const batchInputSchema = byName.get('weft.storage.batch')?.inputSchema;
    const batchProperties = batchInputSchema?.['properties'] as Record<string, unknown>;
    const batchOperations = batchProperties['operations'] as Record<string, unknown>;
    expect(batchOperations['maxItems']).toBe(MAX_BATCH_OPERATIONS);

    const conditionalBatchInputSchema = byName.get('weft.storage.conditionalbatch')?.inputSchema;
    const conditionalBatchProperties = conditionalBatchInputSchema?.['properties'] as Record<
      string,
      unknown
    >;
    const conditionalBatchConditions = conditionalBatchProperties['conditions'] as Record<
      string,
      unknown
    >;
    const conditionalBatchOperations = conditionalBatchProperties['operations'] as Record<
      string,
      unknown
    >;
    expect(conditionalBatchConditions['maxItems']).toBe(MAX_BATCH_OPERATIONS);
    expect(conditionalBatchOperations['maxItems']).toBe(MAX_BATCH_OPERATIONS);
  });
});
