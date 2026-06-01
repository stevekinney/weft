import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  createPublicOriginWarner,
  generateApiCatalog,
  originFromRequest,
  resetPublicOriginWarningForTesting,
} from './api-catalog.ts';
import { handleRequest } from './handler.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

/**
 * Assert that a discovery request to `requestUrl` is rejected with a 503 whose
 * error names `publicOrigin`/`trustedHosts` when `NODE_ENV` and the untrusted-
 * origin override are both unset. Saves and restores both environment variables
 * around the request so the surrounding suite is unaffected.
 */
async function expectUntrustedOriginRejected(engine: Engine, requestUrl: string): Promise<void> {
  const originalNodeEnv = Bun.env['NODE_ENV'];
  const originalOverride = Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
  delete Bun.env['NODE_ENV'];
  delete Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
  try {
    const response = await handleRequest(new Request(requestUrl), engine);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('publicOrigin');
    expect(body.error).toContain('trustedHosts');
  } finally {
    if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
    else delete Bun.env['NODE_ENV'];
    if (originalOverride !== undefined) {
      Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'] = originalOverride;
    } else {
      delete Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
    }
  }
}

describe('API catalog linkset', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('generates an RFC 9264 linkset with service descriptions sorted by href', () => {
    const document = generateApiCatalog({ origin: 'https://api.example.com' });

    expect(document).toEqual({
      linkset: [
        {
          anchor: 'https://api.example.com',
          'service-desc': [
            {
              href: 'https://api.example.com/.well-known/mcp.json',
              type: 'application/json',
            },
            {
              href: 'https://api.example.com/asyncapi.json',
              type: 'application/asyncapi+json',
            },
            {
              href: 'https://api.example.com/openapi.json',
              type: 'application/openapi+json',
            },
            {
              href: 'https://api.example.com/openrpc.json',
              type: 'application/json',
            },
          ],
        },
      ],
    });
  });

  it('prefers the request URL origin over header-derived values', () => {
    // The request URL reflects the actual incoming scheme/host pair as
    // Bun.serve() resolved them. Headers are client-controllable so they
    // are NOT used when the URL is authoritative.
    const request = new Request('https://api.example.com/.well-known/api-catalog', {
      headers: {
        host: 'attacker.example',
        'x-forwarded-proto': 'http',
      },
    });

    expect(originFromRequest(request)).toBe('https://api.example.com');
  });

  it('rejects an unrecognized X-Forwarded-Proto value', () => {
    // The request URL takes precedence here, so the malicious proto can't
    // poison the result. This test pins the behavior — even when the URL
    // is authoritative, the result is the URL's origin, not header text.
    const request = new Request('https://api.example.com/.well-known/api-catalog', {
      headers: {
        host: 'api.example.com',
        'x-forwarded-proto': 'javascript',
      },
    });

    expect(originFromRequest(request)).toBe('https://api.example.com');
  });

  it('rejects a malformed Host header pattern', () => {
    // Same precedence applies — URL wins, malformed host header is ignored.
    const request = new Request('https://api.example.com/.well-known/api-catalog', {
      headers: {
        host: 'evil@attacker/path',
        'x-forwarded-proto': 'https',
      },
    });

    expect(originFromRequest(request)).toBe('https://api.example.com');
  });

  it('serves the route as application/linkset+json when configured with publicOrigin', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://api.example.com/.well-known/api-catalog', {
        headers: {
          host: 'api.example.com',
          'x-forwarded-proto': 'https',
        },
      }),
      engine,
      { publicOrigin: 'https://api.example.com' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/linkset+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['linkset']).toBeDefined();
  });

  it('serves /.well-known/mcp.json as application/json when configured with publicOrigin', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://attacker.example/.well-known/mcp.json'),
      engine,
      { publicOrigin: 'https://api.example.com' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const body = (await response.json()) as {
      transports?: { streamableHttp?: { url?: string; methods?: string[] } };
      discovery?: { tools?: { method?: string; canonical?: boolean } };
    };
    expect(body.transports?.streamableHttp?.url).toBe('https://api.example.com/api/mcp');
    expect(body.transports?.streamableHttp?.methods).toEqual(['POST', 'GET', 'DELETE']);
    expect(body.discovery?.tools).toEqual({ method: 'tools/list', canonical: true });
  });

  it('serves /.well-known/mcp.json when trustedHosts contains the request Host', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://api.example.com/.well-known/mcp.json'),
      engine,
      { trustedHosts: ['api.example.com'] },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { transports?: { streamableHttp?: { url?: string } } };
    expect(body.transports?.streamableHttp?.url).toBe('https://api.example.com/api/mcp');
  });

  it('returns 421 for /.well-known/mcp.json when trustedHosts rejects the request Host', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://attacker.example/.well-known/mcp.json'),
      engine,
      { trustedHosts: ['api.example.com'] },
    );

    expect(response.status).toBe(421);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('trustedHosts');
  });

  it('returns 503 for /.well-known/mcp.json by default without publicOrigin or trustedHosts', async () => {
    engine = createEngine();
    await expectUntrustedOriginRejected(engine, 'https://attacker.example/.well-known/mcp.json');
  });

  it('serves /.well-known/mcp.json when the explicit untrusted-origin override is set', async () => {
    engine = createEngine();
    const originalNodeEnv = Bun.env['NODE_ENV'];
    const originalOverride = Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
    delete Bun.env['NODE_ENV'];
    Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'] = '1';
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const response = await handleRequest(
        new Request('https://api.example.com/.well-known/mcp.json'),
        engine,
      );
      expect(response.status).toBe(200);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
      if (originalOverride !== undefined) {
        Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'] = originalOverride;
      } else {
        delete Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
      }
    }
  });

  it('uses an explicit publicOrigin from handler options instead of request-derived origin', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://attacker.example/.well-known/api-catalog'),
      engine,
      { publicOrigin: 'https://api.example.com' },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { linkset?: { anchor?: string }[] };
    expect(body.linkset?.[0]?.anchor).toBe('https://api.example.com');
  });

  it('warns once when NODE_ENV=development and publicOrigin is unset', async () => {
    // The unsafe Host-derived fallback is opt-in via NODE_ENV=development
    // (or WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN=1). When opted in, the
    // route logs a one-shot warning so operators see the misconfiguration
    // before they ship.
    engine = createEngine();
    resetPublicOriginWarningForTesting();
    const originalNodeEnv = Bun.env['NODE_ENV'];
    Bun.env['NODE_ENV'] = 'development';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await handleRequest(new Request('https://api.example.com/.well-known/api-catalog'), engine);
      await handleRequest(new Request('https://api.example.com/.well-known/api-catalog'), engine);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
    }
    const matching = warnings.filter((line) =>
      line.includes('discovery routes (`/.well-known/api-catalog`, `/.well-known/mcp.json`)'),
    );
    // One-shot warning: only the first call should log.
    expect(matching).toHaveLength(1);
  });

  it('warns once for /.well-known/mcp.json when NODE_ENV=development and publicOrigin is unset', async () => {
    // MCP discovery uses the same origin-resolution path as the API
    // catalog, so development-mode Host-derived fallback should carry
    // the same one-shot operator warning.
    engine = createEngine();
    resetPublicOriginWarningForTesting();
    const originalNodeEnv = Bun.env['NODE_ENV'];
    Bun.env['NODE_ENV'] = 'development';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await handleRequest(new Request('https://api.example.com/.well-known/mcp.json'), engine);
      await handleRequest(new Request('https://api.example.com/.well-known/mcp.json'), engine);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
    }
    const matching = warnings.filter((line) =>
      line.includes('discovery routes (`/.well-known/api-catalog`, `/.well-known/mcp.json`)'),
    );
    expect(matching).toHaveLength(1);
  });

  it('createPublicOriginWarner produces independent one-shot instances', () => {
    // Bugbot regression: the warning state used to be a module-level
    // boolean that leaked across test isolation boundaries. Each
    // factory-built warner now carries its own state — two warners can
    // each log once without interfering, and `reset` re-arms only the
    // instance it was called on.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const a = createPublicOriginWarner();
      const b = createPublicOriginWarner();
      a.warn();
      a.warn();
      b.warn();
      b.warn();
      // Two warnings (one per warner) — a and b do not share state.
      expect(warnings).toHaveLength(2);
      a.reset();
      a.warn();
      // a reset, b did not — one more warning total.
      expect(warnings).toHaveLength(3);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not warn when publicOrigin is configured', async () => {
    engine = createEngine();
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await handleRequest(new Request('https://api.example.com/.well-known/api-catalog'), engine, {
        publicOrigin: 'https://api.example.com',
      });
    } finally {
      console.warn = originalWarn;
    }
    const matching = warnings.filter((line) => line.includes('publicOrigin'));
    expect(matching).toHaveLength(0);
  });

  it('returns 503 by default when neither publicOrigin nor trustedHosts is configured', async () => {
    // Default-secure: the unsafe Host-derived fallback is opt-in. NODE_ENV
    // unset (or any value other than 'development'), with no
    // WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN override, refuses to serve.
    // Closes Codex round-4 finding: a `production`-only check was too
    // narrow because deployments use staging/prod/preview/unset.
    engine = createEngine();
    await expectUntrustedOriginRejected(engine, 'https://attacker.example/.well-known/api-catalog');
  });

  it('returns 503 when NODE_ENV=staging without publicOrigin/trustedHosts (not just NODE_ENV=production)', async () => {
    // Codex round-4: the previous narrow `production`-only check let
    // staging/prod/preview deployments fall through to the unsafe path.
    // This test pins the default-secure behavior for non-development
    // NODE_ENV values.
    engine = createEngine();
    const originalNodeEnv = Bun.env['NODE_ENV'];
    Bun.env['NODE_ENV'] = 'staging';
    try {
      const response = await handleRequest(
        new Request('https://attacker.example/.well-known/api-catalog'),
        engine,
      );
      expect(response.status).toBe(503);
    } finally {
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
    }
  });

  it('serves the route when WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN=1 is the explicit operator override', async () => {
    // Documented escape hatch for testbeds and CI environments that
    // need the route to operate without configuring publicOrigin /
    // trustedHosts.
    engine = createEngine();
    resetPublicOriginWarningForTesting();
    const originalNodeEnv = Bun.env['NODE_ENV'];
    const originalOverride = Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
    delete Bun.env['NODE_ENV'];
    Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'] = '1';
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const response = await handleRequest(
        new Request('https://api.example.com/.well-known/api-catalog'),
        engine,
      );
      expect(response.status).toBe(200);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
      if (originalOverride !== undefined) {
        Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'] = originalOverride;
      } else {
        delete Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'];
      }
    }
  });

  it('serves the catalog when trustedHosts contains the request Host', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://api.example.com/.well-known/api-catalog'),
      engine,
      { trustedHosts: ['api.example.com'] },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { linkset?: { anchor?: string }[] };
    expect(body.linkset?.[0]?.anchor).toBe('https://api.example.com');
  });

  it('returns 421 when the request Host is not in the trustedHosts allowlist', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://attacker.example/.well-known/api-catalog'),
      engine,
      { trustedHosts: ['api.example.com'] },
    );
    expect(response.status).toBe(421);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('trustedHosts');
  });
});
