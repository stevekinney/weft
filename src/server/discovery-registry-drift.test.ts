import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';
import { handleJsonRpcHttpRequestSafely } from './json-rpc-transport-helpers.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';

type OpenRpcMethodDocument = {
  name: string;
};

type OpenRpcDocument = {
  methods?: OpenRpcMethodDocument[];
};

function normalizeOpenRpcDocument(document: OpenRpcDocument): OpenRpcDocument {
  const methods = (document.methods ?? []).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return { ...document, methods };
}

function createFilteredRegistry(): OperationRegistry {
  const liveRegistry = createLiveOperationRegistry();
  const filteredOperations = liveRegistry
    .list()
    .filter((operation) => operation.name.startsWith('weft.workflows.get'));
  const byName = new Map(filteredOperations.map((operation) => [operation.name, operation]));

  return {
    get(name) {
      return byName.get(name);
    },
    list() {
      return filteredOperations;
    },
  };
}

describe('Discovery registry drift', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let engine: Engine | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('registry-drift: /openrpc.json and rpc.discover use the live server registry, not the default', async () => {
    const hostname = '127.0.0.1';
    const localEngine = new Engine({ storage: new MemoryStorage() });
    engine = localEngine;

    const operationRegistry = createFilteredRegistry();
    const restBindings = createLiveRestBindings().filter(
      (binding) => operationRegistry.get(binding.operationName) !== undefined,
    );

    server = Bun.serve({
      hostname,
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/jsonrpc') {
          return handleJsonRpcHttpRequestSafely({
            request,
            registry: operationRegistry,
            engine: localEngine,
            authContext: undefined,
          });
        }

        return handleRequest(request, localEngine, { operationRegistry, restBindings });
      },
    });

    const baseUrl = `http://${hostname}:${server.port}`;
    const routeResponse = await fetch(`${baseUrl}/openrpc.json`);
    expect(routeResponse.status).toBe(200);
    const routeDocument = (await routeResponse.json()) as OpenRpcDocument;

    const discoverResponse = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'registry-drift-discover',
        method: 'rpc.discover',
        params: {},
      }),
    });
    expect(discoverResponse.status).toBe(200);
    const discoverBody = (await discoverResponse.json()) as {
      error?: unknown;
      result?: OpenRpcDocument;
    };
    expect(discoverBody.error).toBeUndefined();

    const expectedMethodNames = [
      ...operationRegistry.list().map((operation) => operation.name),
      'rpc.discover',
    ].toSorted();
    const routeMethodNames = (routeDocument.methods ?? []).map((method) => method.name).toSorted();
    const discoverMethodNames = (discoverBody.result?.methods ?? [])
      .map((method) => method.name)
      .toSorted();

    expect(routeMethodNames).toEqual(expectedMethodNames);
    expect(discoverMethodNames).toEqual(expectedMethodNames);
    expect(normalizeOpenRpcDocument(discoverBody.result ?? {})).toEqual(
      normalizeOpenRpcDocument(routeDocument),
    );
  });

  it('registry-drift: /openapi.json uses the live server restBindings, not the default', async () => {
    const hostname = '127.0.0.1';
    const localEngine = new Engine({ storage: new MemoryStorage() });
    engine = localEngine;

    const operationRegistry = createFilteredRegistry();
    const restBindings = createLiveRestBindings().filter(
      (binding) => operationRegistry.get(binding.operationName) !== undefined,
    );

    server = Bun.serve({
      hostname,
      port: 0,
      fetch(request) {
        return handleRequest(request, localEngine, { operationRegistry, restBindings });
      },
    });

    const response = await fetch(`http://${hostname}:${server.port}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths?: Record<string, Record<string, unknown>> };

    const operationIds = new Set<string>();
    for (const pathItem of Object.values(document.paths ?? {})) {
      for (const methodEntry of Object.values(pathItem)) {
        if (
          typeof methodEntry === 'object' &&
          methodEntry !== null &&
          'operationId' in methodEntry
        ) {
          const operationId = (methodEntry as { operationId?: unknown }).operationId;
          if (typeof operationId === 'string') operationIds.add(operationId);
        }
      }
    }

    // The filtered registry only contains weft.workflows.get* operations.
    // /openapi.json must reflect that filter, not the default REST_BINDINGS
    // set which includes 30+ unrelated operations.
    for (const operationId of operationIds) {
      if (operationId.startsWith('weft.')) {
        expect(operationRegistry.get(operationId)).toBeDefined();
      }
    }
    // And the filtered operations should appear in the document.
    for (const operation of operationRegistry.list()) {
      if (operation.transports.http) {
        expect(operationIds.has(operation.name)).toBe(true);
      }
    }
  });

  it('registry-drift: /asyncapi.json uses the live server restBindings, not the default', async () => {
    const hostname = '127.0.0.1';
    const localEngine = new Engine({ storage: new MemoryStorage() });
    engine = localEngine;

    const liveRegistry = createLiveOperationRegistry();
    const streamOperation = liveRegistry.get('weft.workflows.streams.sse');
    if (streamOperation === undefined) {
      throw new Error('expected weft.workflows.streams.sse to be registered');
    }
    const operationRegistry: OperationRegistry = {
      get(name) {
        return name === streamOperation.name ? streamOperation : undefined;
      },
      list() {
        return [streamOperation];
      },
    };
    const restBindings = createLiveRestBindings()
      .filter((binding) => binding.operationName === streamOperation.name)
      .map((binding) => ({
        ...binding,
        path: '/v1/custom-streams/:id/events',
      }));

    server = Bun.serve({
      hostname,
      port: 0,
      fetch(request) {
        return handleRequest(request, localEngine, { operationRegistry, restBindings });
      },
    });

    const response = await fetch(`http://${hostname}:${server.port}/asyncapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      channels?: Record<string, { address?: unknown }>;
    };

    expect(document.channels?.['weft/workflows/streams/sse']?.address).toBe(
      '/api/v1/custom-streams/{id}/events',
    );
  });
});
