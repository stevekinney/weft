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

import { createAuthenticator, type AuthConfig } from './authentication.ts';
import { principalFromApiKey } from './principal.ts';

function requestWithKey(key: string): Request {
  return new Request('http://localhost/v1/workflows', {
    method: 'GET',
    headers: { 'X-API-Key': key },
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
    if (!result.authenticated) throw new Error('unreachable');
    expect(result.method).toBe('api-key');
    expect(result.principal).toBeDefined();
    const principal = result.principal!;
    expect(principal.method).toBe('api-key');
    expect(principal.hasScope('workflows:read')).toBe(true);
  });

  it('static apiKeys admits with empty scopes when defaultApiKeyScopes omitted', async () => {
    const config: AuthConfig = { apiKeys: ['static-key-2'] };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('static-key-2'));

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('unreachable');
    expect(result.principal?.scopes.size).toBe(0);
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
    const principal = result.principal!;
    expect(principal.subject).toBe('resolver-subject');
    // Authoritative: only resolver-supplied scopes, NOT defaultApiKeyScopes.
    expect(principal.hasScope('schedules:write')).toBe(true);
    expect(principal.hasScope('workflows:read')).toBe(false);
  });

  it('resolver returns null → rejected; static apiKeys NOT consulted as fallback', async () => {
    const config: AuthConfig = {
      apiKeys: ['static-key'], // Present but MUST NOT admit when resolver exists
      resolveApiKeyPrincipal: async () => null,
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('static-key'));

    expect(result.authenticated).toBe(false);
  });

  it('resolver throws → rejected (treated as null)', async () => {
    const config: AuthConfig = {
      resolveApiKeyPrincipal: async () => {
        throw new Error('resolver failure');
      },
    };
    const auth = await createAuthenticator(config);
    const result = await auth(requestWithKey('any-key'));

    expect(result.authenticated).toBe(false);
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
});
