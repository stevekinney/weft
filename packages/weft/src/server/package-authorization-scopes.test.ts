/**
 * Package-registered authorization scopes (COR-1478).
 *
 * A package passes its namespaced scopes (`bureau.tasks:read`) to one handler
 * through `additionalScopes`. That handler's authenticator retains them from
 * JWT claims and `defaultApiKeyScopes`, its operations can require them in an
 * `AccessPolicy`, and `weft.system.principal` reports them. Nothing is
 * registered process-wide, so a second handler never sees the first's scopes.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { ClientOperationTypes } from '../client/generated/operation-client.generated.ts';
import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  createAuthenticator,
  createRotatingApiKeyStore,
  signJWT,
  type AuthResult,
} from './authentication.ts';
import type { PackageAuthorizationScope } from './authorization-scope.ts';
import { authContextToPrincipal } from './handler.ts';
import { serve, type WeftServer } from './index.ts';
import { openWebSocket, waitForMessage } from './json-rpc-websocket-client.test-support.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry, executeOperation } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import { getPrincipalOperation } from './operations/get-principal.ts';
import {
  isAuthenticated,
  principalFromApiKey,
  principalFromStdioLocal,
  type Principal,
} from './principal.ts';

const SECRET = 'package-scope-secret-at-least-32-chars!';
const API_KEY = 'weft_key_package_scopes';
const TASKS_READ: PackageAuthorizationScope = 'bureau.tasks:read';
const TASKS_WRITE: PackageAuthorizationScope = 'bureau.tasks:write';

function bearer(token: string): Request {
  return new Request('http://localhost/v1/workflows', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function principalOf(result: AuthResult): Principal {
  if (!result.authenticated) throw new Error(`expected admission, got: ${result.error}`);
  return authContextToPrincipal(result);
}

function scopesOf(principal: Principal): string[] {
  if (!isAuthenticated(principal)) throw new Error('expected an authenticated principal');
  return [...principal.scopes].toSorted();
}

async function jwtPrincipal(
  claims: Record<string, unknown>,
  additionalScopes: readonly PackageAuthorizationScope[],
): Promise<Principal> {
  const authenticate = await createAuthenticator({ jwt: { secret: SECRET } }, { additionalScopes });
  return principalOf(await authenticate(bearer(await signJWT(claims, SECRET))));
}

const readTasksOperation = defineOperation({
  name: 'bureau.tasks.list',
  mcpExposable: false,
  summary: 'List tasks',
  description: 'Test operation that requires a package-registered scope.',
  destructive: false,
  tags: ['System'],
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.literal(true) }),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: [TASKS_READ] } },
  discoverable: true,
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async () => ({ ok: true as const }),
});

describe('additionalScopes — retention', () => {
  it('admits a registered scope through an AccessPolicy built with defineOperation', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    try {
      const registry = createOperationRegistry([readTasksOperation]);
      const run = async (principal: Principal) =>
        executeOperation(
          'bureau.tasks.list',
          {},
          { principal, engine, transport: 'jsonRpcHttp', registry },
        );

      const holder = await jwtPrincipal({ sub: 'u', scope: TASKS_READ }, [TASKS_READ]);
      const allowed = await run(holder);
      expect(allowed.ok).toBe(true);

      const without = await jwtPrincipal({ sub: 'u', scope: 'workflows:read' }, [TASKS_READ]);
      const denied = await run(without);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.fault.code).toBe('Forbidden');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('retains a registered scope from the JWT `scope` claim', async () => {
    const principal = await jwtPrincipal({ scope: `workflows:read ${TASKS_READ}` }, [TASKS_READ]);
    expect(scopesOf(principal)).toEqual([TASKS_READ, 'workflows:read']);
  });

  it('retains a registered scope from the JWT `scp` claim', async () => {
    const principal = await jwtPrincipal({ scp: TASKS_READ }, [TASKS_READ]);
    expect(scopesOf(principal)).toEqual([TASKS_READ]);
  });

  it('retains a registered scope from the JWT `permissions` claim', async () => {
    const principal = await jwtPrincipal({ permissions: [TASKS_READ, 'system:read'] }, [
      TASKS_READ,
    ]);
    expect(scopesOf(principal)).toEqual([TASKS_READ, 'system:read']);
  });

  it('retains a registered scope from defaultApiKeyScopes and drops an unlisted one', async () => {
    const authenticate = await createAuthenticator(
      { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read', TASKS_READ, TASKS_WRITE] },
      { additionalScopes: [TASKS_READ] },
    );
    const principal = principalOf(await authenticate(bearer(API_KEY)));
    expect(scopesOf(principal)).toEqual([TASKS_READ, 'workflows:read']);
  });

  it('still drops an unlisted unknown scope from JWT claims', async () => {
    const principal = await jwtPrincipal(
      {
        scope: `${TASKS_READ} ${TASKS_WRITE} not-a-scope`,
        scp: 'other.pkg:read',
        permissions: ['weft.tasks:read', TASKS_WRITE],
      },
      [TASKS_READ],
    );
    expect(scopesOf(principal)).toEqual([TASKS_READ]);
  });

  it('narrows a resolver principal to built-in and registered scopes', async () => {
    const authenticate = await createAuthenticator(
      {
        resolveApiKeyPrincipal: async () =>
          principalFromApiKey({
            subject: 's',
            scopes: ['other.pkg:admin', 'weft.secret:write', TASKS_READ, 'workflows:read'],
          }),
      },
      { additionalScopes: [TASKS_READ] },
    );
    const principal = principalOf(await authenticate(bearer(API_KEY)));
    expect(scopesOf(principal)).toEqual([TASKS_READ, 'workflows:read']);
    if (!isAuthenticated(principal)) throw new Error('expected an authenticated principal');
    expect(principal.hasScope('weft.secret:write')).toBe(false);
    expect(principal.hasScope('other.pkg:admin')).toBe(false);
  });

  it('narrows a rotating-store principal to built-in and registered scopes', async () => {
    const store = createRotatingApiKeyStore();
    store.add(API_KEY, {
      subject: 'svc',
      scopes: ['weft.system:admin', TASKS_READ, TASKS_WRITE, 'system:read'],
    });
    const authenticate = await createAuthenticator(
      { resolveApiKeyPrincipal: store.resolve },
      { additionalScopes: [TASKS_READ] },
    );
    const principal = principalOf(await authenticate(bearer(API_KEY)));
    expect(scopesOf(principal)).toEqual([TASKS_READ, 'system:read']);
  });

  it('drops every package scope when the handler registers none', async () => {
    const principal = await jwtPrincipal({ scope: `${TASKS_READ} workflows:read` }, []);
    expect(scopesOf(principal)).toEqual(['workflows:read']);
  });
});

describe('additionalScopes — validation at construction', () => {
  const malformed = ['bureau', 'tasks:read', 'bureau.tasks', '.tasks:read', 'bureau.:read'];

  it('rejects a scope that does not match the namespaced template', async () => {
    for (const scope of malformed) {
      const additionalScopes = [scope] as unknown as PackageAuthorizationScope[];
      expect(
        await throwingRejectionOf(
          createAuthenticator({ jwt: { secret: SECRET } }, { additionalScopes }),
        ),
      ).toThrow(/additionalScopes/);
    }
  });

  it('rejects a scope in the reserved `weft` namespace', async () => {
    expect(
      await throwingRejectionOf(
        createAuthenticator({ jwt: { secret: SECRET } }, { additionalScopes: ['weft.tasks:read'] }),
      ),
    ).toThrow(/reserved/);
  });

  it('serve() rejects a malformed or reserved scope before binding', () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    try {
      const bad = ['bureau'] as unknown as PackageAuthorizationScope[];
      expect(() =>
        serve({ engine, port: 0, auth: { jwt: { secret: SECRET } }, additionalScopes: bad }),
      ).toThrow(/additionalScopes/);
      expect(() =>
        serve({
          engine,
          port: 0,
          auth: { jwt: { secret: SECRET } },
          additionalScopes: ['weft.system:read'],
        }),
      ).toThrow(/reserved/);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('additionalScopes — weft.system.principal', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('accepts a registered scope in its output schema', () => {
    const parsed = getPrincipalOperation.outputSchema.safeParse({
      method: 'jwt',
      subject: null,
      scopes: [TASKS_READ, 'workflows:read'],
    });
    expect(parsed.success).toBe(true);
    const rejected = getPrincipalOperation.outputSchema.safeParse({
      method: 'jwt',
      subject: null,
      scopes: ['not-a-scope'],
    });
    expect(rejected.success).toBe(false);
  });

  it('accepts a registered scope in its OpenRPC result schema', () => {
    const document = generateOpenRpcDocument({
      registry: createOperationRegistry([getPrincipalOperation]),
      transports: ['http'],
    });
    const methods = document['methods'] as Array<{
      name: string;
      result: { schema: { properties: { scopes: { items: unknown } } } };
    }>;
    const principal = methods.find((method) => method.name === 'weft.system.principal');
    if (principal === undefined) throw new Error('weft.system.principal missing from OpenRPC');
    const items = principal.result.schema.properties.scopes.items;
    const itemSchema = z.fromJSONSchema(items as z.core.JSONSchema.JSONSchema);
    expect(itemSchema.safeParse(TASKS_READ).success).toBe(true);
    expect(itemSchema.safeParse('workflows:read').success).toBe(true);
    expect(itemSchema.safeParse('not-a-scope').success).toBe(false);
  });

  it('accepts a registered scope in the generated client typing', () => {
    const output: ClientOperationTypes['weft.system.principal']['output'] = {
      method: 'jwt',
      subject: 'u',
      scopes: [TASKS_READ, 'workflows:read'],
    };
    expect(output.scopes).toContain(TASKS_READ);
  });

  it('reads back a registered scope held by the caller', async () => {
    engine = new Engine({ storage: new MemoryStorage() });
    server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: SECRET } },
      additionalScopes: [TASKS_READ],
    });
    const token = await signJWT({ sub: 'operator', scope: `${TASKS_READ} system:read` }, SECRET);

    const response = await fetch(`${server.url}/v1/principal`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: 'jwt',
      subject: 'operator',
      scopes: [TASKS_READ, 'system:read'],
    });
  });
});

describe('additionalScopes — principals built without an authenticator', () => {
  it('rebuilds a jwt context without a forwarded principal with built-in scopes only', () => {
    const principal = authContextToPrincipal({
      method: 'jwt',
      claims: { sub: 'u', scope: `${TASKS_READ} workflows:read` },
    });
    expect(scopesOf(principal)).toEqual(['workflows:read']);
  });

  it('gives the trusted-local principal every built-in scope and no package scope', () => {
    const principal = principalFromStdioLocal();
    expect(principal.hasScope('system:admin')).toBe(true);
    expect(principal.hasScope(TASKS_READ)).toBe(false);
  });
});

describe('additionalScopes — JSON-RPC over WebSocket', () => {
  it('keeps a registered scope on the principal admitted at the upgrade', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: SECRET } },
      additionalScopes: [TASKS_READ],
    });
    try {
      const token = await signJWT({ sub: 'operator', scope: `${TASKS_READ} system:read` }, SECRET);
      const socket = await openWebSocket(
        `${server.url.replace('http://', 'ws://')}/jsonrpc`,
        token,
      );
      try {
        const reply = waitForMessage(
          socket,
          (parsed) => (parsed as { id?: unknown } | null)?.id === 'principal',
        );
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'principal',
            method: 'weft.system.principal',
            params: {},
          }),
        );
        expect(await reply).toEqual({
          jsonrpc: '2.0',
          id: 'principal',
          result: { method: 'jwt', subject: 'operator', scopes: [TASKS_READ, 'system:read'] },
        });
      } finally {
        socket.close();
      }
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });
});

describe('additionalScopes — isolation', () => {
  it('keeps two handlers in one process from seeing each other’s scopes', async () => {
    const claims = { sub: 'u', scope: `${TASKS_READ} catalog.items:read` };
    const bureau = await jwtPrincipal(claims, [TASKS_READ]);
    const catalog = await jwtPrincipal(claims, ['catalog.items:read']);
    const neither = await jwtPrincipal(claims, []);

    expect(scopesOf(bureau)).toEqual([TASKS_READ]);
    expect(scopesOf(catalog)).toEqual(['catalog.items:read']);
    expect(scopesOf(neither)).toEqual([]);
  });

  it('keeps two served handlers in one process isolated', async () => {
    const firstEngine = new Engine({ storage: new MemoryStorage() });
    const secondEngine = new Engine({ storage: new MemoryStorage() });
    const first = serve({
      engine: firstEngine,
      port: 0,
      auth: { jwt: { secret: SECRET } },
      additionalScopes: [TASKS_READ],
    });
    const second = serve({
      engine: secondEngine,
      port: 0,
      auth: { jwt: { secret: SECRET } },
      additionalScopes: ['catalog.items:read'],
    });
    try {
      const token = await signJWT({ sub: 'u', scope: `${TASKS_READ} catalog.items:read` }, SECRET);
      const read = async (server: WeftServer) => {
        const response = await fetch(`${server.url}/v1/principal`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return ((await response.json()) as { scopes: string[] }).scopes;
      };
      expect(await read(first)).toEqual([TASKS_READ]);
      expect(await read(second)).toEqual(['catalog.items:read']);
    } finally {
      await first.stop();
      await second.stop();
      firstEngine[Symbol.dispose]();
      secondEngine[Symbol.dispose]();
    }
  });
});
