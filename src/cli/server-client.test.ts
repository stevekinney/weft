import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { serve } from '../server/index.ts';
import { callCatalogOperation, failureExitCode } from './server-client.ts';

type StubServer = { url: string; stop: () => void };

let stub: StubServer | undefined;

afterEach(() => {
  stub?.stop();
  stub = undefined;
});

/**
 * A minimal JSON-RPC server that mimics an OLDER Weft server which does not
 * know a given operation: it answers `/jsonrpc` with the reserved MethodNotFound
 * code (-32601) for every method.
 */
function serveMethodNotFound(): StubServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/jsonrpc') {
        const body = (await request.json()) as { id?: unknown };
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not found' },
          id: body.id ?? null,
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { url: server.url.toString(), stop: () => void server.stop(true) };
}

describe('callCatalogOperation version skew', () => {
  it('maps a MethodNotFound error to a specific compat message, not a raw 404', async () => {
    stub = serveMethodNotFound();
    const result = await callCatalogOperation({ server: stub.url }, 'weft.workflows.list', {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('compat');
    expect(result.message).toContain('not available on this server');
    expect(result.message).toContain('weft server info');
    expect(result.message).not.toContain('404');
    expect(failureExitCode(result.kind)).toBe(4);
  });

  it('returns a connection failure when the server is unreachable', async () => {
    const result = await callCatalogOperation(
      { server: 'http://127.0.0.1:1/' },
      'weft.workflows.list',
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('connection');
    expect(failureExitCode(result.kind)).toBe(2);
  });

  it('returns a value when the operation exists on the server', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const result = await callCatalogOperation(
        { server: server.url.toString() },
        'weft.workflows.list',
        {},
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value).toMatchObject({ items: [] });
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });
});
