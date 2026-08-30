import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal('release');
});

type OpenApiDocument = {
  paths?: Record<string, Record<string, { operationId?: string }>>;
};

type OpenRpcMethodDocument = {
  name: string;
  paramStructure?: unknown;
  params?: unknown[];
  result?: unknown;
  summary?: string;
};

type OpenRpcDocument = {
  openrpc?: string;
  info?: unknown;
  servers?: unknown[];
  methods?: OpenRpcMethodDocument[];
};

function createHoldEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(holdWorkflow);
  return engine;
}

function listOperationBindings(
  document: OpenApiDocument,
  operationName: string,
): Array<{ path: string; method: string }> {
  const bindings: Array<{ path: string; method: string }> = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation.operationId === operationName) {
        bindings.push({ path, method });
      }
    }
  }
  return bindings;
}

function normalizeOpenRpcDocument(document: OpenRpcDocument): OpenRpcDocument {
  const methods = (document.methods ?? []).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return { ...document, methods };
}

describe('Discovery parity', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (engines.length > 0) {
      engines.pop()?.[Symbol.dispose]();
    }
  });

  it('Both /openapi.json and /openrpc.json are generated from the same operation catalog', async () => {
    const engine = createHoldEngine();
    engines.push(engine);

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const openApiResponse = await fetch(`${server.url}/openapi.json`);
    const openRpcResponse = await fetch(`${server.url}/openrpc.json`);

    expect(openApiResponse.status).toBe(200);
    expect(openRpcResponse.status).toBe(200);

    const openApiDocument = (await openApiResponse.json()) as OpenApiDocument;
    const openRpcDocument = (await openRpcResponse.json()) as OpenRpcDocument;
    const registry = createLiveOperationRegistry();
    const restBindings = createLiveRestBindings();
    const openRpcMethods = openRpcDocument.methods ?? [];
    const openRpcMethodNames = new Set(openRpcMethods.map((method) => method.name));

    for (const method of openRpcMethods) {
      if (!method.name.startsWith('weft.')) continue;

      const operation = registry.get(method.name);
      expect(operation).toBeDefined();
      expect(operation?.transports.jsonRpcHttp || operation?.transports.jsonRpcWebSocket).toBe(
        true,
      );

      const bindings = listOperationBindings(openApiDocument, method.name);
      const expectedBindingCount = operation?.transports.http
        ? restBindings.filter((binding) => binding.operationName === method.name).length
        : 0;
      expect(bindings).toHaveLength(expectedBindingCount);
    }

    for (const pathItem of Object.values(openApiDocument.paths ?? {})) {
      for (const operation of Object.values(pathItem)) {
        if (operation.operationId?.startsWith('weft.')) {
          const definition = registry.get(operation.operationId);
          const expectsOpenRpcMethod =
            definition?.transports.jsonRpcHttp === true ||
            definition?.transports.jsonRpcWebSocket === true;
          expect(openRpcMethodNames.has(operation.operationId)).toBe(expectsOpenRpcMethod);
        }
      }
    }
  });

  it('rpc.discover returns the same OpenRPC document exposed at /openrpc.json', async () => {
    const engine = createHoldEngine();
    engines.push(engine);

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const routeResponse = await fetch(`${server.url}/openrpc.json`);
    expect(routeResponse.status).toBe(200);
    const routeDocument = (await routeResponse.json()) as OpenRpcDocument;

    const httpResponse = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'discover-http',
        method: 'rpc.discover',
        params: {},
      }),
    });
    expect(httpResponse.status).toBe(200);
    const httpBody = (await httpResponse.json()) as { error?: unknown; result?: OpenRpcDocument };
    expect(httpBody.error).toBeUndefined();

    const webSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', (event) => reject(event));
    });

    try {
      const webSocketBody = await new Promise<{ error?: unknown; result?: OpenRpcDocument }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            webSocket.removeEventListener('message', handler);
            reject(new Error('rpc.discover websocket response timed out'));
          }, 3_000);

          function handler(event: MessageEvent): void {
            const parsed = JSON.parse(String(event.data)) as {
              id?: string;
              error?: unknown;
              result?: OpenRpcDocument;
            };
            if (parsed.id === 'discover-websocket') {
              clearTimeout(timer);
              webSocket.removeEventListener('message', handler);
              resolve(parsed);
            }
          }

          webSocket.addEventListener('message', handler);
          webSocket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'discover-websocket',
              method: 'rpc.discover',
              params: {},
            }),
          );
        },
      );

      expect(webSocketBody.error).toBeUndefined();

      expect(normalizeOpenRpcDocument(httpBody.result ?? {})).toEqual(
        normalizeOpenRpcDocument(routeDocument),
      );
      expect(normalizeOpenRpcDocument(webSocketBody.result ?? {})).toEqual(
        normalizeOpenRpcDocument(routeDocument),
      );
    } finally {
      webSocket.close();
    }
  });
});
