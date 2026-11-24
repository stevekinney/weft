import { AUTHORIZATION_SCOPES, WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';
/**
 * The `unauthenticated-local` principal and the scope requirement on static
 * API keys (COR-1466).
 *
 * A `serve()` with no authentication identifies nobody, so every request runs
 * as the one local user, who holds every built-in scope. A `serve()` with
 * static API keys must say which scopes those keys hold, because every
 * operation except `weft.system.principal` now requires one.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  authContextToPrincipal,
  principalFromUnauthenticatedLocal,
  type AuthConfig,
} from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { serve, type WeftServer } from './index.ts';
import { NO_AUTHENTICATION_WARNING } from './serve-internals.ts';

const API_KEY = 'unauthenticated-local-test-key';
const ALL_SCOPES_SORTED = [...AUTHORIZATION_SCOPES].toSorted();

type PrincipalBody = {
  readonly method: string;
  readonly subject: string | null;
  readonly scopes: readonly string[];
};

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

async function readPrincipal(server: WeftServer, headers?: HeadersInit): Promise<PrincipalBody> {
  const response = await fetch(`${server.url}/v1/principal`, headers ? { headers } : undefined);
  expect(response.status).toBe(200);
  return (await response.json()) as PrincipalBody;
}

describe('the unauthenticated-local principal', () => {
  it('holds every built-in scope and names itself', () => {
    const principal = principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY);

    expect(principal.method).toBe('unauthenticated-local');
    expect(principal.subject).toBe('unauthenticated-local');
    expect([...principal.scopes].toSorted()).toEqual(ALL_SCOPES_SORTED);
    for (const scope of AUTHORIZATION_SCOPES) expect(principal.hasScope(scope)).toBe(true);
  });

  it('has scopes that cannot be widened, narrowed, or cleared by a caller', () => {
    const { scopes } = principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY);
    const mutable = scopes as Set<string>;

    expect(() => mutable.add('bureau.tasks:read')).toThrow(TypeError);
    expect(() => mutable.delete('workflows:read')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect([...scopes].toSorted()).toEqual(ALL_SCOPES_SORTED);
    expect(
      principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY).hasScope('bureau.tasks:read'),
    ).toBe(false);
  });

  it('is one shared instance, so two requests compare as the same owner', () => {
    expect(principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY)).toBe(
      principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY),
    );
  });

  it('is what an unauthenticated-local auth context resolves to', () => {
    expect(authContextToPrincipal({ method: 'unauthenticated-local' }, WEFT_SCOPE_VOCABULARY)).toBe(
      principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY),
    );
  });
});

describe('serve() with no authentication', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  for (const unauthenticatedAccess of [undefined, 'warn', 'allow'] as const) {
    describe(`unauthenticatedAccess: ${unauthenticatedAccess ?? '(default)'}`, () => {
      it('runs every request as the unauthenticated-local principal', async () => {
        const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          engine = createEngine();
          server = serve({
            engine,
            port: 0,
            publicOrigin: 'http://localhost',
            ...(unauthenticatedAccess === undefined ? {} : { unauthenticatedAccess }),
          });

          expect(await readPrincipal(server)).toEqual({
            method: 'unauthenticated-local',
            subject: 'unauthenticated-local',
            scopes: ALL_SCOPES_SORTED,
          });
        } finally {
          warningSpy.mockRestore();
        }
      });

      it('reaches operations that require a scope, over REST and JSON-RPC', async () => {
        const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          engine = createEngine();
          server = serve({
            engine,
            port: 0,
            publicOrigin: 'http://localhost',
            ...(unauthenticatedAccess === undefined ? {} : { unauthenticatedAccess }),
          });

          // workflows:read and system:read, over REST.
          const workflowList = await fetch(`${server.url}/v1/workflows`);
          const retention = await fetch(`${server.url}/v1/retention`);
          expect(workflowList.status).toBe(200);
          expect(retention.status).toBe(200);

          // workflows:admin, over JSON-RPC.
          const response = await fetch(`${server.url}/jsonrpc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.recover.all', params: {} }),
          });
          expect(await response.json()).toMatchObject({ id: 1, result: { recovered: [] } });
        } finally {
          warningSpy.mockRestore();
        }
      });
    });
  }

  it('records the unauthenticated-local principal in the audit event of a confirmed bulk operation', async () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = createEngine();
      server = serve({ engine, port: 0, publicOrigin: 'http://localhost' });
    } finally {
      warningSpy.mockRestore();
    }

    const bulkCancel = async (body: object): Promise<Record<string, unknown>> => {
      const response = await fetch(`${server?.url}/v1/workflows/bulk/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: { tags: ['audit-probe'] }, ...body }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };

    const preview = await bulkCancel({ dryRun: true });
    const committed = await bulkCancel({ confirmationToken: preview['confirmationToken'] });

    expect(committed['auditEvent']).toMatchObject({
      principal: { method: 'unauthenticated-local', subject: 'unauthenticated-local' },
    });
  });

  it("warns that every built-in operation is accessible, and names the local principal, under 'warn'", () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = createEngine();
      server = serve({ engine, port: 0, publicOrigin: 'http://localhost' });

      expect(warningSpy).toHaveBeenCalledWith(NO_AUTHENTICATION_WARNING);
      expect(NO_AUTHENTICATION_WARNING).toContain(
        'every built-in operation is accessible to any caller',
      );
      expect(NO_AUTHENTICATION_WARNING).toContain('unauthenticated-local');
      expect(NO_AUTHENTICATION_WARNING).not.toContain('non-public');
      // A package scope is granted only to a credential that holds it.
      expect(NO_AUTHENTICATION_WARNING).toContain('package scope');
    } finally {
      warningSpy.mockRestore();
    }
  });

  it("refuses to start under 'reject', before binding", () => {
    const rejectingEngine = createEngine();
    engine = rejectingEngine;
    expect(() =>
      serve({ engine: rejectingEngine, port: 0, unauthenticatedAccess: 'reject' }),
    ).toThrow('Refusing to start server with no authentication');
  });

  it('refuses to start when WEFT_SERVER_AUTHENTICATION_REQUIRED demands authentication', () => {
    const previous = Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
    Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'] = '1';
    try {
      const requiringEngine = createEngine();
      engine = requiringEngine;
      expect(() =>
        serve({ engine: requiringEngine, port: 0, unauthenticatedAccess: 'allow' }),
      ).toThrow('WEFT_SERVER_AUTHENTICATION_REQUIRED');
    } finally {
      if (previous === undefined) delete Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
      else Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'] = previous;
    }
  });
});

describe('serve() with authentication configured', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  it('never gives a credential-bearing caller the local principal', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });

    expect(await readPrincipal(server, { 'X-API-Key': API_KEY })).toEqual({
      method: 'api-key',
      subject: 'api-key-caller',
      scopes: ['workflows:read'],
    });
  });

  it('refuses a credential-less caller instead of running it as the local user', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });

    const principal = await fetch(`${server.url}/v1/principal`);
    const workflowList = await fetch(`${server.url}/v1/workflows`);
    expect(principal.status).toBe(401);
    expect(workflowList.status).toBe(401);
  });

  it('refuses a key to an operation whose scope it does not hold', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });

    const response = await fetch(`${server.url}/v1/recover`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
    });
    expect(response.status).toBe(403);
  });
});

describe('serve() with static API keys', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  function expectRefusal(auth: AuthConfig): void {
    const refusingEngine = createEngine();
    engine = refusingEngine;
    expect(() => serve({ engine: refusingEngine, port: 0, auth })).toThrow(
      /defaultApiKeyScopes.*resolveApiKeyPrincipal/s,
    );
  }

  it('throws before binding when neither default scopes nor a resolver is configured', () => {
    expectRefusal({ apiKeys: [API_KEY] });
  });

  it('throws when the default scopes are empty', () => {
    expectRefusal({ apiKeys: [API_KEY], defaultApiKeyScopes: [] });
  });

  it('throws when every default scope is one the server does not recognize', () => {
    // A package scope is granted only when the server registers it, so an
    // unregistered one grants nothing and the key would be refused everywhere.
    expectRefusal({ apiKeys: [API_KEY], defaultApiKeyScopes: ['bureau.tasks:read'] });
  });

  it('starts with non-empty default scopes', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it('starts with a registered package scope as the only default scope', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      additionalScopes: ['bureau.tasks:read'],
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['bureau.tasks:read'] },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it('starts with a resolver in place of default scopes', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], resolveApiKeyPrincipal: async () => null },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it('does not constrain a server that authenticates by JWT alone', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { jwt: { secret: 'jwt-only-server-secret-1234567890' } },
    });
    expect(server.port).toBeGreaterThan(0);
  });
});
