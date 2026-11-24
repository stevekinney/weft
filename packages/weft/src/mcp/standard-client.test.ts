/**
 * A spec-compliant MCP client against `/mcp` on a `serve()` with a static API
 * key, in its default 2025-era mode. The endpoint keeps no session, so every
 * request authenticates with the key it presents.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { serve, type WeftServer } from '../server/index.ts';

const STATIC_KEY = 'standard-client-static-key';

describe('the official MCP SDK client over a static API key', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  function start(): WeftServer {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = new Engine({ storage: new MemoryStorage() });
      server = serve({
        engine,
        port: 0,
        hostname: '127.0.0.1',
        publicOrigin: 'http://localhost',
        auth: { apiKeys: [STATIC_KEY], defaultApiKeyScopes: ['workflows:read'] },
      });
    } finally {
      warningSpy.mockRestore();
    }
    return server;
  }

  it('connects and lists tools with the key in X-API-Key', async () => {
    const running = start();
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
      requestInit: { headers: { 'X-API-Key': STATIC_KEY } },
    });
    const client = new Client({ name: 'standard-client-test', version: '1' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(Array.isArray(tools.tools)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('connects with the key as a bearer token as well', async () => {
    const running = start();
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${STATIC_KEY}` } },
    });
    const client = new Client({ name: 'standard-client-test', version: '1' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(Array.isArray(tools.tools)).toBe(true);
    } finally {
      await client.close();
    }
  });
});
