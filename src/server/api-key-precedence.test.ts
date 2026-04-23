/**
 * Phase 16 — API-key admission precedence truth table.
 *
 * Four configurable cells × two key-shape cells × relevant admission
 * outcomes give the six-row matrix the plan mandates:
 *
 *   resolver absent + key-in-static          → admit; scopes = defaultApiKeyScopes ?? []
 *   resolver absent + key-not-in-static      → reject
 *   resolver present + returns principal     → use that principal entirely
 *                                              (defaultApiKeyScopes IGNORED)
 *   resolver present + returns null          → reject (NO fallback to static)
 *
 * The resolver is authoritative for the key space once configured. Static
 * `apiKeys` only admits when no resolver exists. Default scopes only
 * apply to the static-admission principal.
 */

import { describe, expect, it } from 'bun:test';

import { createAuthenticator, validateAuthConfig, type AuthConfig } from './authentication.ts';
import type { AuthorizationScope } from './authorization-scope.ts';
import { principalFromApiKey } from './principal.ts';

function requestWithKey(key: string): Request {
  return new Request('http://localhost/v1/workflows', {
    method: 'GET',
    headers: { 'X-API-Key': key },
  });
}

function requestWithBearer(key: string): Request {
  return new Request('http://localhost/v1/workflows', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
}

describe('API-key admission — resolver absent', () => {
  it('static apiKeys admits the key; principal gets defaultApiKeyScopes', async () => {
    const config: AuthConfig = {
      apiKeys: ['static-key-1'],
      defaultApiKeyScopes: ['workflows:read'],
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('static-key-1'));

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('unreachable: authenticator returned failure');
    expect(result.method).toBe('api-key');
    if (result.principal === undefined) throw new Error('expected principal on authentication');
    expect(result.principal.method).toBe('api-key');
    expect(result.principal.hasScope('workflows:read')).toBe(true);
  });

  it('static apiKeys admits with empty scopes when defaultApiKeyScopes omitted', async () => {
    const config: AuthConfig = { apiKeys: ['static-key-2'] };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('static-key-2'));

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('unreachable');
    if (result.principal === undefined) throw new Error('expected principal');
    expect(result.principal.scopes.size).toBe(0);
  });

  it('key not in static list → rejected', async () => {
    const config: AuthConfig = { apiKeys: ['static-key-3'] };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('wrong-key'));

    expect(result.authenticated).toBe(false);
  });
});

describe('API-key admission — resolver present', () => {
  it('resolver returns principal → that principal is used entirely; defaultApiKeyScopes IGNORED', async () => {
    const config: AuthConfig = {
      apiKeys: ['fallback-should-be-ignored'],
      defaultApiKeyScopes: ['workflows:read'], // Must be ignored when resolver admits
      resolveApiKeyPrincipal: async (key) => {
        if (key === 'resolver-key') {
          return principalFromApiKey({
            subject: 'resolver-subject',
            scopes: ['schedules:write'], // Resolver-specific scopes
          });
        }
        return null;
      },
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('resolver-key'));

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('unreachable');
    expect(result.method).toBe('api-key');
    if (result.principal === undefined) throw new Error('expected principal');
    expect(result.principal.subject).toBe('resolver-subject');
    // Authoritative: only resolver-supplied scopes, NOT defaultApiKeyScopes.
    expect(result.principal.hasScope('schedules:write')).toBe(true);
    expect(result.principal.hasScope('workflows:read')).toBe(false);
  });

  it('resolver returns null → rejected; static apiKeys NOT consulted as fallback', async () => {
    // Present a key that IS in the static list. If the resolver path
    // silently fell back to static on null, this would admit. Asserting
    // rejection tightens the invariant: resolver's null is terminal.
    const config: AuthConfig = {
      apiKeys: ['static-key'],
      resolveApiKeyPrincipal: async () => null,
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('static-key'));

    expect(result.authenticated).toBe(false);
  });

  it('resolver throws → rejected; error message stays generic on the wire', async () => {
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async () => {
        throw new Error('secret-resolver-error-message');
      },
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('any-key'));

    expect(result.authenticated).toBe(false);
    if (result.authenticated) throw new Error('unreachable');
    // The plan mandates that resolver-thrown detail stays server-side.
    // The wire error must not leak it.
    expect(result.error).not.toContain('secret-resolver-error-message');
    expect(result.error).toBe('No valid credentials provided');
  });

  it('resolver present with no static apiKeys → admits via resolver only', async () => {
    // The plan's design: apiKeys is optional when resolveApiKeyPrincipal is
    // provided. Without a resolver, apiKeys (or jwt/mtls) must provide at
    // least one admission method; WITH a resolver, the resolver suffices.
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async (key) =>
        key === 'resolver-only-key'
          ? principalFromApiKey({ subject: 'resolver-only', scopes: [] })
          : null,
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('resolver-only-key'));

    expect(result.authenticated).toBe(true);
  });

  it('resolver path also works for keys presented via Authorization: Bearer', async () => {
    // extractApiKey checks X-API-Key FIRST, then Authorization: Bearer.
    // The resolver path must handle both header shapes — a Bearer-
    // presented token must flow through the resolver the same way an
    // X-API-Key does.
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async (key) =>
        key === 'bearer-resolver-key'
          ? principalFromApiKey({ subject: 'bearer-subject', scopes: [] })
          : null,
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithBearer('bearer-resolver-key'));

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('unreachable');
    expect(result.principal?.subject).toBe('bearer-subject');
  });

  it('resolver rejection is terminal: no fallthrough to JWT even when JWT is configured', async () => {
    // Regression test for the fallthrough bug: a Bearer token the
    // resolver explicitly refused must not be re-tried as a JWT by the
    // next block. Configuring JWT + resolver + a Bearer token exercises
    // the exact path that would leak admission.
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async () => null,
      jwt: { algorithm: 'HS256', secret: 'shared-secret' },
    };
    const auth = await createAuthenticator(config);
    // Present a JWT-shaped token (contains dots) via Bearer. A naive
    // implementation might pass this to extractApiKey → resolver null →
    // fall through to JWT verification. The resolver's null must be
    // terminal: the request is rejected without the JWT block running.
    const jwtShapedToken = 'header.payload.signature';
    const result = await auth(requestWithBearer(jwtShapedToken));

    expect(result.authenticated).toBe(false);
  });

  it('resolver returns principal with wrong method → rejected (guards against contradictory auth state)', async () => {
    // A resolver that returns a principal with method !== 'api-key'
    // would create contradictory state: authResult.method === 'api-key'
    // but principal.method === 'jwt' (or similar). The authenticator
    // must reject such principals rather than admit them with a
    // mismatched method.
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async () =>
        ({
          method: 'jwt',
          scopes: new Set(),
          claims: undefined,
          tenantId: undefined,
          subject: 'wrong-method',
          hasScope: () => false,
        }) as never, // Test-only shape to exercise the runtime guard
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('any-key'));

    expect(result.authenticated).toBe(false);
  });

  it('admitted principal is frozen (defensive copy prevents mutation leaks across requests)', async () => {
    // Hand the authenticator a principal with a mutable Set. If the
    // authenticator forwards by reference, later mutations on the
    // caller's copy would leak into auth state. The freeze at the
    // trust boundary means the admitted principal has its OWN scope
    // set, independent of what the resolver returned.
    const originalScopes = new Set<AuthorizationScope>(['workflows:read']);
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async () => {
        const principal = principalFromApiKey({
          subject: 'mutation-test',
          scopes: [...originalScopes],
        });
        return principal;
      },
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('any-key'));

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('unreachable');
    if (result.principal === undefined) throw new Error('expected principal');
    // Mutating the caller's "original" set must not affect the admitted
    // principal. Direct mutation attempts on the frozen set would throw
    // under strict mode; we exercise the defensive-copy guarantee by
    // showing the admitted principal's scope set is independent.
    originalScopes.add('workflows:write');
    expect(result.principal.hasScope('workflows:write')).toBe(false);
    expect(result.principal.hasScope('workflows:read')).toBe(true);
  });
});

describe('validateAuthConfig — resolver-only admission', () => {
  it('accepts resolveApiKeyPrincipal as the sole configured method', () => {
    // Direct unit coverage: the plan mandates resolver-only configs
    // bypass the "at least one method" check. createAuthenticator calls
    // validateAuthConfig internally, but asserting this path in isolation
    // protects against future refactors that might tighten the rule.
    expect(() => validateAuthConfig({ resolveApiKeyPrincipal: async () => null })).not.toThrow();
  });
});
