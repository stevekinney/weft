import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { VERSION } from '../version.ts';
import { generateAsyncApiDocument } from './asyncapi.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { serve, type WeftServer } from './index.ts';
import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

type AsyncApiDocument = {
  asyncapi?: unknown;
  info?: {
    title?: unknown;
    version?: unknown;
  };
  channels?: Record<string, unknown>;
  components?: {
    messages?: Record<string, { payload?: unknown }>;
  };
  servers?: Record<
    string,
    {
      host?: unknown;
      protocol?: unknown;
    }
  >;
};

const PRIVATE_STREAM_OPERATION: ErasedOperation = {
  name: 'weft.private.stream',
  mcpExposable: false,
  destructive: false,
  kind: 'stream',
  summary: 'Private test stream',
  tags: ['Tests'],
  inputSchema: z.object({}),
  outputSchema: z.object({ chunks: z.array(z.unknown()) }),
  eventSchema: z.object({ value: z.unknown() }),
  access: { kind: 'authenticated' },
  discoverable: false,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({ chunks: [] }),
};

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function createRegistryWithPrivateStream(): OperationRegistry {
  const registry = createLiveOperationRegistry();
  return {
    get(name) {
      if (name === PRIVATE_STREAM_OPERATION.name) return PRIVATE_STREAM_OPERATION;
      return registry.get(name);
    },
    list() {
      return [...registry.list(), PRIVATE_STREAM_OPERATION];
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('AsyncAPI document', () => {
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

  it('GET /asyncapi.json returns an AsyncAPI 3.0 document', async () => {
    const engine = createEngine();
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/asyncapi.json`);
    const document = (await response.json()) as AsyncApiDocument;

    expect(response.status).toBe(200);
    expect(document.asyncapi).toBe('3.0.0');
  });

  it('includes the workflow event subscription channel', () => {
    const document = generateAsyncApiDocument({ registry: createLiveOperationRegistry() });

    expect(document['channels']).toHaveProperty('weft/workflows/events');
  });

  it('documents the workflow subscription session method on the subscribe request', () => {
    const document = generateAsyncApiDocument({
      registry: createLiveOperationRegistry(),
    }) as AsyncApiDocument;
    const request = document.components?.messages?.['weft_workflows_events_subscribeRequest'];
    const payload = request?.payload as
      | { properties?: { method?: { const?: unknown } } }
      | undefined;

    expect(payload?.properties?.method?.const).toBe('weft.workflows.subscribe');
  });

  it('includes the workflow SSE stream channel', () => {
    const document = generateAsyncApiDocument({ registry: createLiveOperationRegistry() });

    expect(document['channels']).toHaveProperty('weft/workflows/streams/sse');
  });

  it('emits object payload schemas for every component message', () => {
    const document = generateAsyncApiDocument({
      registry: createLiveOperationRegistry(),
    }) as AsyncApiDocument;
    const messages = document.components?.messages ?? {};

    expect(Object.keys(messages).length).toBeGreaterThan(0);
    for (const message of Object.values(messages)) {
      expect(isRecord(message.payload)).toBe(true);
    }
  });

  it('keeps discoverable async operations and emitted channels in parity', () => {
    const registry = createLiveOperationRegistry();
    const document = generateAsyncApiDocument({ registry }) as AsyncApiDocument;
    const channelNames = new Set(Object.keys(document.channels ?? {}));
    const expectedChannelNames = registry
      .list()
      .filter(
        (operation) =>
          isDiscoverable(operation) &&
          (operation.kind === 'subscription' || operation.kind === 'stream'),
      )
      .map((operation) => operation.name.replaceAll('.', '/'));

    for (const channelName of expectedChannelNames) {
      expect(channelNames.has(channelName)).toBe(true);
    }

    for (const channelName of channelNames) {
      const operationName = channelName.replaceAll('/', '.');
      const operation = registry.get(operationName);
      expect(operation).toBeDefined();
      expect(operation?.kind === 'subscription' || operation?.kind === 'stream').toBe(true);
      if (operation !== undefined) {
        expect(isDiscoverable(operation)).toBe(true);
      }
    }
  });

  it('filters out private non-discoverable async operations', () => {
    const document = generateAsyncApiDocument({
      registry: createRegistryWithPrivateStream(),
    }) as AsyncApiDocument;

    expect(document.channels).not.toHaveProperty('weft/private/stream');
  });

  it('serves /asyncapi.json without an auth header when authentication is enabled', async () => {
    const engine = createEngine();
    engines.push(engine);
    const server = serve({ engine, port: 0, auth: { apiKeys: ['test-key'] } });
    servers.push(server);

    const response = await fetch(`${server.url}/asyncapi.json`);

    expect(response.status).toBe(200);
  });

  it('generates deterministic output', () => {
    const registry = createLiveOperationRegistry();
    const first = generateAsyncApiDocument({ registry });
    const second = generateAsyncApiDocument({ registry });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('uses default info title and version', () => {
    const document = generateAsyncApiDocument({
      registry: createLiveOperationRegistry(),
    }) as AsyncApiDocument;

    expect(document.info?.title).toBe('Weft Workflow Engine');
    expect(document.info?.version).toBe(VERSION);
  });

  it('uses ws for non-TLS server URLs', () => {
    const document = generateAsyncApiDocument({
      registry: createLiveOperationRegistry(),
      serverUrl: 'http://api.example.com/api/v1/tasks/default/stream',
    }) as AsyncApiDocument;

    expect(document.servers?.['default']).toEqual({
      host: 'api.example.com',
      protocol: 'ws',
    });
  });

  it('uses wss for TLS server URLs', () => {
    const document = generateAsyncApiDocument({
      registry: createLiveOperationRegistry(),
      serverUrl: 'https://api.example.com/api/v1/tasks/default/stream',
    }) as AsyncApiDocument;

    expect(document.servers?.['default']).toEqual({
      host: 'api.example.com',
      protocol: 'wss',
    });
  });

  it('falls back to the raw host string when serverUrl is not a valid URL', () => {
    const document = generateAsyncApiDocument({
      registry: createLiveOperationRegistry(),
      serverUrl: 'not-a-url',
    }) as AsyncApiDocument;

    expect(document.servers?.['default']).toEqual({
      host: 'not-a-url',
      protocol: 'ws',
    });
  });
});
