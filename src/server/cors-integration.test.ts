/**
 * End-to-end CORS behavior through a live `serve()` instance: preflight,
 * actual-response decoration, the safe default (no `cors` → no headers),
 * fail-fast config validation, and cross-origin WebSocket rejection.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

describe('serve({ cors }) — preflight', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('answers a preflight from an allowed origin with Access-Control-* headers', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      cors: { allowedOrigins: ['https://app.example.com'], credentials: true },
    });

    const response = await fetch(`${server.url}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('answers a preflight from a disallowed origin without CORS headers', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, cors: { allowedOrigins: ['https://app.example.com'] } });

    const response = await fetch(`${server.url}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not require authentication for preflight even when auth is configured', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['secret-key'] },
      cors: { allowedOrigins: ['https://app.example.com'], credentials: true },
    });

    // No Authorization header on the preflight — must still succeed.
    const response = await fetch(`${server.url}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    // Authorization is advertised because auth is configured.
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
  });
});

describe('serve({ cors }) — actual responses', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('decorates a real response with the exact origin and Vary for a credentialed policy', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      cors: { allowedOrigins: ['https://app.example.com'], credentials: true },
    });

    const response = await fetch(`${server.url}/v1/health`, {
      headers: { Origin: 'https://app.example.com' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('does not decorate a response for a disallowed origin', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, cors: { allowedOrigins: ['https://app.example.com'] } });

    const response = await fetch(`${server.url}/v1/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('serve() — safe default (no cors)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('never emits Access-Control-Allow-Origin: * by default', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/health`, {
      headers: { Origin: 'https://app.example.com' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();

    // And a preflight is not specially handled — it falls through to normal
    // routing rather than returning a CORS 204.
    const preflight = await fetch(`${server.url}/v1/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('serve({ cors }) — fail-fast validation', () => {
  it('throws on credentials:true with a wildcard origin before binding', () => {
    const engine = createEngine();
    try {
      expect(() =>
        serve({ engine, port: 0, cors: { allowedOrigins: ['*'], credentials: true } }),
      ).toThrow(/wildcard origin is illegal/);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('throws on a wildcard origin with an Authorization allowed-header', () => {
    const engine = createEngine();
    try {
      expect(() =>
        serve({
          engine,
          port: 0,
          cors: { allowedOrigins: ['*'], allowedHeaders: ['Authorization'] },
        }),
      ).toThrow(/bearer tokens/);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('serve({ cors }) — WebSocket origin enforcement', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('rejects a cross-origin WebSocket upgrade from a disallowed origin with 403', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, cors: { allowedOrigins: ['https://app.example.com'] } });

    // A raw upgrade request carrying a disallowed Origin. We assert the HTTP
    // response is 403 rather than completing the upgrade.
    const response = await fetch(`${server.url}/jsonrpc`, {
      headers: {
        Origin: 'https://evil.example.com',
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });

    expect(response.status).toBe(403);
  });
});
