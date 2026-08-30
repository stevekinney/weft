import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { generateAsyncApiDocument } from './asyncapi.ts';
import type { DiscoveryInfo } from './discovery-info.ts';
import { serve, type WeftServer } from './index.ts';
import { generateOpenApiDocument } from './openapi.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

const discoveryInfo: DiscoveryInfo = {
  description: 'Public Weft API for durable workflows.',
  contact: {
    name: 'Weft Operators',
    url: 'https://api.example.com/support',
    email: 'support@example.com',
  },
  license: {
    name: 'MIT',
    url: 'https://opensource.org/license/mit',
  },
  externalDocs: {
    description: 'Operator guide',
    url: 'https://docs.example.com/weft',
  },
};

describe('DiscoveryInfo', () => {
  it('applies shared discovery metadata to OpenAPI, OpenRPC, and AsyncAPI documents', () => {
    const registry = createLiveOperationRegistry();
    const openApiDocument = generateOpenApiDocument({ registry, discoveryInfo });
    const openRpcDocument = generateOpenRpcDocument({
      registry,
      transports: ['http', 'websocket'],
      discoveryInfo,
    });
    const asyncApiDocument = generateAsyncApiDocument({ registry, discoveryInfo });

    expect(openApiDocument['info']).toEqual(
      expect.objectContaining({
        description: discoveryInfo.description,
        contact: discoveryInfo.contact,
        license: discoveryInfo.license,
      }),
    );
    expect(openApiDocument['externalDocs']).toEqual(discoveryInfo.externalDocs);
    expect(openRpcDocument['info']).toEqual(
      expect.objectContaining({
        description: discoveryInfo.description,
        contact: discoveryInfo.contact,
        license: discoveryInfo.license,
        externalDocs: discoveryInfo.externalDocs,
      }),
    );
    expect(asyncApiDocument['info']).toEqual(
      expect.objectContaining({
        description: discoveryInfo.description,
        contact: discoveryInfo.contact,
        license: discoveryInfo.license,
      }),
    );
    expect(asyncApiDocument['externalDocs']).toEqual(discoveryInfo.externalDocs);
  });

  describe('serve() entry-point plumbing', () => {
    const servers: WeftServer[] = [];
    const engines: Engine[] = [];

    afterEach(async () => {
      while (servers.length > 0) await servers.pop()?.stop();
      while (engines.length > 0) engines.pop()?.[Symbol.dispose]();
    });

    it('forwards discoveryInfo from serve() options to /openapi.json, /openrpc.json, and /asyncapi.json', async () => {
      const engine = new Engine({ storage: new MemoryStorage() });
      engines.push(engine);
      const server = serve({ engine, port: 0, discoveryInfo });
      servers.push(server);

      const openApiResponse = await fetch(`${server.url}/openapi.json`);
      const openRpcResponse = await fetch(`${server.url}/openrpc.json`);
      const asyncApiResponse = await fetch(`${server.url}/asyncapi.json`);

      const openApiDocument = (await openApiResponse.json()) as {
        info?: Record<string, unknown>;
        externalDocs?: unknown;
      };
      const openRpcDocument = (await openRpcResponse.json()) as { info?: Record<string, unknown> };
      const asyncApiDocument = (await asyncApiResponse.json()) as {
        info?: Record<string, unknown>;
        externalDocs?: unknown;
      };

      expect(openApiDocument.info).toEqual(
        expect.objectContaining({
          description: discoveryInfo.description,
          contact: discoveryInfo.contact,
          license: discoveryInfo.license,
        }),
      );
      expect(openApiDocument.externalDocs).toEqual(discoveryInfo.externalDocs);
      expect(openRpcDocument.info).toEqual(
        expect.objectContaining({
          description: discoveryInfo.description,
          contact: discoveryInfo.contact,
          license: discoveryInfo.license,
          externalDocs: discoveryInfo.externalDocs,
        }),
      );
      expect(asyncApiDocument.info).toEqual(
        expect.objectContaining({
          description: discoveryInfo.description,
          contact: discoveryInfo.contact,
          license: discoveryInfo.license,
        }),
      );
      expect(asyncApiDocument.externalDocs).toEqual(discoveryInfo.externalDocs);
    });
  });
});
