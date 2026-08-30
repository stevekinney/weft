/**
 * Truth-table tests for principal + scope gating (plan §6, §11.1, T1.2).
 * Pure logic, no DOM: exercises `PrincipalStore` directly rather than
 * through `providePrincipalStore()`/`getPrincipalStore()`, which need an
 * active Svelte component context (covered later by the app-shell's own
 * component tests, T1.6).
 */
import { describe, expect, test } from 'bun:test';

import { HttpClient, HttpClientError } from '@lostgradient/weft/client';
import { AUTHORIZATION_SCOPES as UPSTREAM_AUTHORIZATION_SCOPES } from '@lostgradient/weft/server';

import {
  AUTHORIZATION_SCOPES,
  isForbidden,
  isUnauthorized,
  PrincipalStore,
  resolvePrincipal,
  scopeGate,
  scopeReason,
  type AuthorizationScope,
  type Principal,
} from './scopes.svelte.ts';

describe('AUTHORIZATION_SCOPES', () => {
  test('is byte-identical to weft’s own exported vocabulary, in order', () => {
    // The real drift detector, available since weft 0.18.0 made
    // `AUTHORIZATION_SCOPES` a public export. The console still keeps its own
    // copy because `src/lib/scopes.svelte.ts` is bundled for the browser and a
    // value import from the server barrel would pull weft's server module
    // graph in with it — but the copy is no longer unverifiable. This test
    // runs under Bun, where importing the server entry point is free, so a
    // weft release that adds, removes, or reorders a scope fails here instead
    // of silently desynchronizing the console's gating vocabulary.
    expect(AUTHORIZATION_SCOPES).toEqual([...UPSTREAM_AUTHORIZATION_SCOPES]);
  });

  test('is the flat 21-scope vocabulary, verbatim, in order', () => {
    // Kept alongside the upstream comparison rather than replaced by it: this
    // spells the vocabulary out, so a review of a weft bump sees exactly which
    // scopes changed rather than just "both sides moved together."
    expect(AUTHORIZATION_SCOPES).toEqual([
      'workflows:read',
      'workflows:write',
      'workflows:admin',
      'schedules:read',
      'schedules:write',
      'signals:write',
      'updates:write',
      'queries:read',
      'reviews:read',
      'reviews:write',
      'attributes:read',
      'attributes:write',
      'tags:write',
      'streams:read',
      'events:read',
      'storage:read',
      'storage:write',
      'storage:admin',
      'workers:write',
      'system:read',
      'system:admin',
    ]);
  });

  test('has no duplicate entries', () => {
    expect(new Set(AUTHORIZATION_SCOPES).size).toBe(AUTHORIZATION_SCOPES.length);
  });
});

describe('the principal-introspection operation (T1.2 pin, adopted in weft 0.18.0)', () => {
  // Constructing an HttpClient does no network I/O (`operations` is a plain
  // object built synchronously from the static catalog name list) — safe to
  // assert against without a live server.
  const client = new HttpClient({ baseUrl: 'http://localhost:0' });

  // This pin ran inverted from weft 0.11.0 through 0.17.0, asserting the
  // operation did NOT exist and that the console's probe-and-infer fallback
  // was therefore load-bearing (plan §14.1 item 4). weft 0.18.0 shipped it;
  // the assertion flips rather than being deleted, so a dependency
  // downgrade that removes the operation fails here instead of silently
  // reverting `resolvePrincipal()` to guessing.
  test('plan §6 names `weft.system.principal` as the expected op; it exists', () => {
    expect('weft.system.principal' in client.operations).toBe(true);
  });
});

function grantedPrincipal(scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES): Principal {
  return { scopes, unauthenticatedAccess: null };
}

describe('PrincipalStore.hasScope', () => {
  test('is false for every scope with no principal', () => {
    const store = new PrincipalStore();
    for (const scope of AUTHORIZATION_SCOPES) {
      expect(store.hasScope(scope)).toBe(false);
    }
  });

  test('is true for every scope of a fully granted principal', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    for (const scope of AUTHORIZATION_SCOPES) {
      expect(store.hasScope(scope)).toBe(true);
    }
  });

  test('scopes are flat — workflows:admin does not imply workflows:read or workflows:write', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal(['workflows:admin']));
    expect(store.hasScope('workflows:admin')).toBe(true);
    expect(store.hasScope('workflows:read')).toBe(false);
    expect(store.hasScope('workflows:write')).toBe(false);
  });

  test('variadic calls are AND — every required scope must be granted', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal(['workflows:read', 'workflows:write']));
    expect(store.hasScope('workflows:read', 'workflows:write')).toBe(true);
    expect(store.hasScope('workflows:read', 'workflows:admin')).toBe(false);
  });

  test('a call with no required scopes is vacuously true for any principal', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal([]));
    expect(store.hasScope()).toBe(true);
  });
});

describe('PrincipalStore.denyScope', () => {
  test('revokes a single scope from the current principal', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    store.denyScope('workers:write');
    expect(store.hasScope('workers:write')).toBe(false);
    expect(store.hasScope('workflows:read')).toBe(true);
  });

  test('revokes multiple scopes in one call', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    store.denyScope('storage:admin', 'system:admin');
    expect(store.hasScope('storage:admin')).toBe(false);
    expect(store.hasScope('system:admin')).toBe(false);
    expect(store.hasScope('storage:read')).toBe(true);
  });

  test('is a no-op with no principal', () => {
    const store = new PrincipalStore();
    expect(() => store.denyScope('workflows:admin')).not.toThrow();
    expect(store.principal).toBeNull();
  });

  test('is idempotent — denying an already-denied scope does not error or duplicate', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    store.denyScope('workers:write');
    store.denyScope('workers:write');
    expect(store.principal?.scopes.filter((scope) => scope === 'workers:write')).toEqual([]);
  });
});

describe('PrincipalStore.bannerMode', () => {
  test('is "auth-required" with no principal', () => {
    const store = new PrincipalStore();
    expect(store.bannerMode).toBe('auth-required');
  });

  test('is "unauthenticated-warn" for unauthenticatedAccess: warn', () => {
    const store = new PrincipalStore();
    store.setPrincipal({ scopes: AUTHORIZATION_SCOPES, unauthenticatedAccess: 'warn' });
    expect(store.bannerMode).toBe('unauthenticated-warn');
  });

  test('is "unauthenticated-allow" for unauthenticatedAccess: allow', () => {
    const store = new PrincipalStore();
    store.setPrincipal({ scopes: AUTHORIZATION_SCOPES, unauthenticatedAccess: 'allow' });
    expect(store.bannerMode).toBe('unauthenticated-allow');
  });

  test('is "none" for unauthenticatedAccess: reject (never actually observed, but representable)', () => {
    const store = new PrincipalStore();
    store.setPrincipal({ scopes: AUTHORIZATION_SCOPES, unauthenticatedAccess: 'reject' });
    expect(store.bannerMode).toBe('none');
  });

  test('is "none" for a normally authenticated principal', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    expect(store.bannerMode).toBe('none');
  });
});

describe('PrincipalStore.setPrincipal / clear', () => {
  test('clear() returns the store to bannerMode "auth-required"', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    store.clear();
    expect(store.principal).toBeNull();
    expect(store.bannerMode).toBe('auth-required');
  });

  test('setPrincipal() replaces prior denials — a fresh principal starts fully granted', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal());
    store.denyScope('workers:write');
    store.setPrincipal(grantedPrincipal());
    expect(store.hasScope('workers:write')).toBe(true);
  });
});

/**
 * Stubs the ONE operation `resolvePrincipal()` calls. `HttpClient.operations`
 * is a plain record keyed by every catalog name, so a structurally complete
 * stub would be ~100 no-op entries for no added coverage — this narrows to
 * the single key under test. The real wire contract (what an auth-configured
 * weft does to a credential-less caller) is pinned by
 * `scopes.svelte.integration.test.ts` against a booted `serve()`.
 */
function principalClient(respond: () => Promise<unknown>): Parameters<typeof resolvePrincipal>[0] {
  return { operations: { 'weft.system.principal': respond } } as unknown as Parameters<
    typeof resolvePrincipal
  >[0];
}

describe('PrincipalStore.bootstrap', () => {
  test('applies a successful resolvePrincipal() result', async () => {
    const store = new PrincipalStore();
    await store.bootstrap(
      principalClient(async () => ({
        method: 'api-key',
        subject: 'boot',
        scopes: ['system:read'],
      })),
    );
    expect(store.principal).toEqual({
      scopes: ['system:read'],
      unauthenticatedAccess: null,
    });
  });

  test('applies a rejected (401) resolvePrincipal() result as null', async () => {
    const store = new PrincipalStore();
    await store.bootstrap(
      principalClient(async () => {
        throw new HttpClientError(401, 'No valid credentials provided');
      }),
    );
    expect(store.principal).toBeNull();
  });
});

describe('resolvePrincipal', () => {
  test('an authenticated principal reports its granted scopes verbatim, no banner', async () => {
    const principal = await resolvePrincipal(
      principalClient(async () => ({
        method: 'api-key',
        subject: 'console',
        scopes: ['workflows:read', 'system:read'],
      })),
    );
    expect(principal).toEqual({
      scopes: ['workflows:read', 'system:read'],
      unauthenticatedAccess: null,
    });
  });

  test('the reported scope set is copied, not aliased to the response array', async () => {
    // `Principal.scopes` outlives the response object; `denyScope()` rebuilds
    // it by filtering, so a shared reference would be a latent aliasing bug
    // rather than an observable one today. Pin the copy.
    const response = {
      method: 'api-key',
      subject: 'console',
      scopes: ['workflows:read'],
    };
    const principal = await resolvePrincipal(principalClient(async () => response));
    expect(principal?.scopes).not.toBe(response.scopes);
    expect(principal?.scopes).toEqual(['workflows:read']);
  });

  test('an anonymous principal reports zero scopes and the unauthenticated-warn banner', async () => {
    // Reaching this state at all means the server has no `auth` configured:
    // an auth-configured weft 401s a credential-less caller at the transport
    // edge (pinned in the integration test), so it never answers anonymously.
    const principal = await resolvePrincipal(
      principalClient(async () => ({ method: 'unauthenticated', subject: null, scopes: [] })),
    );
    expect(principal).toEqual({ scopes: [], unauthenticatedAccess: 'warn' });
  });

  test('a 401 (no/invalid credential) → null', async () => {
    const principal = await resolvePrincipal(
      principalClient(async () => {
        throw new HttpClientError(401, 'No valid credentials provided');
      }),
    );
    expect(principal).toBeNull();
  });

  test('a non-401 HttpClientError (e.g. 500) is rethrown, not swallowed', async () => {
    await expect(
      resolvePrincipal(
        principalClient(async () => {
          throw new HttpClientError(500, 'Internal server error');
        }),
      ),
    ).rejects.toThrow('Internal server error');
  });

  test('a non-HttpClientError failure (e.g. a network error) is rethrown, not swallowed', async () => {
    await expect(
      resolvePrincipal(
        principalClient(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).rejects.toThrow('fetch failed');
  });
});

describe('isForbidden / isUnauthorized', () => {
  test('isForbidden is true only for a 403 HttpClientError', () => {
    expect(isForbidden(new HttpClientError(403, 'nope'))).toBe(true);
    expect(isForbidden(new HttpClientError(401, 'nope'))).toBe(false);
    expect(isForbidden(new HttpClientError(500, 'nope'))).toBe(false);
    expect(isForbidden(new Error('nope'))).toBe(false);
    expect(isForbidden(new TypeError('fetch failed'))).toBe(false);
    expect(isForbidden(undefined)).toBe(false);
  });

  test('isUnauthorized is true only for a 401 HttpClientError', () => {
    expect(isUnauthorized(new HttpClientError(401, 'nope'))).toBe(true);
    expect(isUnauthorized(new HttpClientError(403, 'nope'))).toBe(false);
    expect(isUnauthorized(new Error('nope'))).toBe(false);
    expect(isUnauthorized('not an error')).toBe(false);
  });
});

describe('scopeReason', () => {
  test('formats a single scope', () => {
    expect(scopeReason('workflows:admin')).toBe('Requires workflows:admin');
  });

  test('formats multiple scopes, comma-joined', () => {
    expect(scopeReason('workflows:admin', 'streams:read')).toBe(
      'Requires workflows:admin, streams:read',
    );
  });

  test('formats zero scopes deterministically', () => {
    expect(scopeReason()).toBe('Requires ');
  });
});

describe('scopeGate', () => {
  test('is enabled (no title) when every required scope is granted', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal(['workflows:read', 'workflows:write']));
    expect(scopeGate(store, ['workflows:read', 'workflows:write'])).toEqual({
      disabled: false,
      title: undefined,
    });
  });

  test('is disabled with a "Requires …" title when a required scope is missing', () => {
    const store = new PrincipalStore();
    store.setPrincipal(grantedPrincipal(['workflows:read']));
    expect(scopeGate(store, ['workflows:read', 'workflows:admin'])).toEqual({
      disabled: true,
      title: 'Requires workflows:read, workflows:admin',
    });
  });

  test('is disabled with no principal', () => {
    const store = new PrincipalStore();
    expect(scopeGate(store, ['workflows:read'])).toEqual({
      disabled: true,
      title: 'Requires workflows:read',
    });
  });
});
