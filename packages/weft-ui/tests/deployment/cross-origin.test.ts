/**
 * Cross-origin / standalone deployment-mode integration test (plan §3.4,
 * T9.2). Against a REAL in-process `serve({ cors })` (no mock — matches the
 * rest of this repo's integration-test convention, e.g.
 * `live-source-test-server.test-support.ts`).
 *
 * Target route: `GET /v1/health`. It's one of weft's `DEFAULT_PUBLIC_PATHS`
 * (`src/server/authentication/types.ts`), so it bypasses authentication
 * unconditionally — chosen deliberately so a 401/403 can never be misread as
 * a CORS block in these assertions. The server itself is started with
 * `unauthenticatedAccess: 'allow'` (not omitted) so the "no auth configured"
 * startup warning doesn't dirty test output for a suite that isn't about
 * authentication.
 *
 * `fetch()` in Bun (like any non-browser HTTP client) does not enforce CORS —
 * only browsers block based on `Access-Control-Allow-Origin`. So "disallowed
 * origin blocked" is asserted the way the actual protection works: the
 * response headers withhold `Access-Control-Allow-Origin` for that origin
 * (what would make a browser's `fetch`/XHR throw client-side), not that the
 * request itself fails server-side.
 */
import { Engine, MemoryStorage } from '@lostgradient/weft';
import { serve, type CorsOptions, type WeftServer } from '@lostgradient/weft/server';
import { afterEach, describe, expect, test } from 'bun:test';

const ALLOWED_ORIGIN = 'https://weft-console.example.com';
const DISALLOWED_ORIGIN = 'https://untrusted.example.com';

let activeServer: WeftServer | null = null;

afterEach(async () => {
  if (activeServer === null) return;
  await activeServer.stop();
  activeServer = null;
});

function startCorsServer(cors: CorsOptions): WeftServer {
  const engine = new Engine({ storage: new MemoryStorage() });
  const server = serve({ engine, port: 0, cors, unauthenticatedAccess: 'allow' });
  activeServer = server;
  return server;
}

/** `server.url` (e.g. `http://0.0.0.0:PORT`) carries no trailing slash. */
function healthUrl(server: WeftServer): string {
  return `${server.url}/v1/health`;
}

describe('Cross-origin mode — preflight (plan §3.4)', () => {
  test('an allowed origin gets a 204 preflight response with matching CORS headers', async () => {
    const server = startCorsServer({ allowedOrigins: [ALLOWED_ORIGIN] });

    const response = await fetch(healthUrl(server), {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  test('a disallowed origin gets the bounded 204 with no CORS headers', async () => {
    const server = startCorsServer({ allowedOrigins: [ALLOWED_ORIGIN] });

    const response = await fetch(healthUrl(server), {
      method: 'OPTIONS',
      headers: {
        Origin: DISALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Cross-origin mode — actual requests (plan §3.4)', () => {
  test('an allowed origin gets the real response decorated with Access-Control-Allow-Origin', async () => {
    const server = startCorsServer({ allowedOrigins: [ALLOWED_ORIGIN] });

    const response = await fetch(healthUrl(server), {
      headers: { Origin: ALLOWED_ORIGIN },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  test('a disallowed origin gets the real response with no CORS header — the browser, not the server, blocks it', async () => {
    const server = startCorsServer({ allowedOrigins: [ALLOWED_ORIGIN] });

    const response = await fetch(healthUrl(server), {
      headers: { Origin: DISALLOWED_ORIGIN },
    });

    // The server still answers normally — withholding the header is what
    // makes a real browser's fetch/XHR reject the response client-side.
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a same-origin request with no Origin header is unaffected by the cors policy', async () => {
    const server = startCorsServer({ allowedOrigins: [ALLOWED_ORIGIN] });

    const response = await fetch(healthUrl(server));

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Cross-origin mode — illegal configuration rejected at boot (plan §3.4)', () => {
  test('a wildcard origin combined with credentials throws synchronously before the port binds', () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    try {
      expect(() =>
        serve({
          engine,
          port: 0,
          cors: { allowedOrigins: ['*'], credentials: true },
          unauthenticatedAccess: 'allow',
        }),
      ).toThrow();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  test('a wildcard origin combined with an explicit Authorization allowed-header throws synchronously', () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    try {
      expect(() =>
        serve({
          engine,
          port: 0,
          cors: { allowedOrigins: ['*'], allowedHeaders: ['Authorization'] },
          unauthenticatedAccess: 'allow',
        }),
      ).toThrow();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
