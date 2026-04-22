/**
 * Tests for the authorization scope vocabulary, scope extraction, and the
 * access-check pipeline step used by `executeOperation`.
 *
 * See Track 8 design decisions 3, 6, and 10.
 */

import { describe, expect, it } from 'bun:test';

import {
  AUTHORIZATION_SCOPES,
  extractScopesFromClaims,
  isAuthorizationScope,
  type AuthorizationScope,
} from './authorization-scope.ts';
import { evaluateAccess, type AccessPolicy } from './authorization.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  type Principal,
} from './principal.ts';

describe('extractScopesFromClaims', () => {
  it('extracts from space-delimited `scope` claim', () => {
    const scopes = extractScopesFromClaims({ scope: 'workflows:read workflows:write' });
    expect(scopes.has('workflows:read')).toBe(true);
    expect(scopes.has('workflows:write')).toBe(true);
  });

  it('extracts from `scp` claim', () => {
    const scopes = extractScopesFromClaims({ scp: 'schedules:read' });
    expect(scopes.has('schedules:read')).toBe(true);
  });

  it('merges scopes across `scope`, `scp`, and `permissions`', () => {
    const scopes = extractScopesFromClaims({
      scope: 'workflows:read',
      scp: 'schedules:read',
      permissions: ['reviews:read'],
    });
    expect(scopes.has('workflows:read')).toBe(true);
    expect(scopes.has('schedules:read')).toBe(true);
    expect(scopes.has('reviews:read')).toBe(true);
    expect(scopes.size).toBe(3);
  });

  it('merges weft scopes from `permissions` even when `scope` carries only OIDC tokens', () => {
    // Real-world shape: IdP puts OIDC scopes in `scope`, custom scopes in `permissions`.
    // A short-circuit on `scope` would silently drop the weft scope.
    const scopes = extractScopesFromClaims({
      scope: 'openid profile email',
      permissions: ['workflows:read'],
    });
    expect(scopes.has('workflows:read')).toBe(true);
    expect(scopes.size).toBe(1);
  });

  it('falls through to `scp` when `scope` is an empty string', () => {
    const scopes = extractScopesFromClaims({ scope: '', scp: 'schedules:read' });
    expect(scopes.has('schedules:read')).toBe(true);
  });

  it('falls through when `scope` is whitespace-only (prevents downgrade attack)', () => {
    const scopes = extractScopesFromClaims({
      scope: '   ',
      scp: 'workflows:admin',
    });
    expect(scopes.has('workflows:admin')).toBe(true);
  });

  it('falls through to `permissions` when `scp` is whitespace-only', () => {
    const scopes = extractScopesFromClaims({
      scp: '\t  \n',
      permissions: ['reviews:read'],
    });
    expect(scopes.has('reviews:read')).toBe(true);
  });

  it('ignores non-string entries in `permissions` array', () => {
    const scopes = extractScopesFromClaims({
      permissions: ['workflows:read', 42, null, true, { oops: 'x' }, 'nonsense-scope'],
    });
    expect(scopes.has('workflows:read')).toBe(true);
    expect(scopes.size).toBe(1);
  });

  it('silently drops unknown scope strings', () => {
    const scopes = extractScopesFromClaims({ scope: 'workflows:read nonsense-scope' });
    expect(scopes.has('workflows:read')).toBe(true);
    expect(scopes.size).toBe(1);
  });

  it('returns an empty set when no scope source is present', () => {
    const scopes = extractScopesFromClaims({ sub: 's' });
    expect(scopes.size).toBe(0);
  });

  it('handles whitespace padding in `scope`', () => {
    const scopes = extractScopesFromClaims({ scope: '   workflows:read    workflows:write  ' });
    expect(scopes.has('workflows:read')).toBe(true);
    expect(scopes.has('workflows:write')).toBe(true);
  });

  it('ignores non-string claim values', () => {
    const scopes = extractScopesFromClaims({
      scope: 42,
      scp: { weird: true },
      permissions: 'oops',
    });
    expect(scopes.size).toBe(0);
  });
});

describe('isAuthorizationScope', () => {
  it('accepts every listed scope', () => {
    for (const scope of AUTHORIZATION_SCOPES) {
      expect(isAuthorizationScope(scope)).toBe(true);
    }
  });

  it('rejects unlisted strings', () => {
    expect(isAuthorizationScope('nonsense')).toBe(false);
    expect(isAuthorizationScope('')).toBe(false);
    expect(isAuthorizationScope('workflows')).toBe(false);
  });
});

describe('evaluateAccess', () => {
  const unauth: Principal = anonymousPrincipal();
  const authNoScopes = principalFromApiKey({ subject: 'k1', scopes: [] });
  const withReadOnly = principalFromApiKey({ subject: 'k2', scopes: ['workflows:read'] });
  const withReadWrite = principalFromApiKey({
    subject: 'k3',
    scopes: ['workflows:read', 'workflows:write'],
  });

  it('public: always allows', () => {
    const policy: AccessPolicy = { kind: 'public' };
    expect(evaluateAccess(policy, unauth)).toEqual({ allowed: true });
    expect(evaluateAccess(policy, authNoScopes)).toEqual({ allowed: true });
  });

  it('authenticated: allows any authenticated principal, rejects unauthenticated with Unauthorized', () => {
    const policy: AccessPolicy = { kind: 'authenticated' };
    expect(evaluateAccess(policy, authNoScopes)).toEqual({ allowed: true });
    const denied = evaluateAccess(policy, unauth);
    expect(denied).toEqual({
      allowed: false,
      classification: 'unauthorized',
      reason: 'authentication required',
    });
  });

  it('scoped anyOf: unauthenticated -> Unauthorized; authenticated without scope -> Forbidden; with any scope -> allow', () => {
    const policy: AccessPolicy = {
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['workflows:read', 'workflows:write'] },
    };

    const unauthResult = evaluateAccess(policy, unauth);
    expect(unauthResult.allowed).toBe(false);
    expect(unauthResult).toMatchObject({ classification: 'unauthorized' });

    const noScopeResult = evaluateAccess(policy, authNoScopes);
    expect(noScopeResult).toMatchObject({ allowed: false, classification: 'forbidden' });

    expect(evaluateAccess(policy, withReadOnly)).toEqual({ allowed: true });
    expect(evaluateAccess(policy, withReadWrite)).toEqual({ allowed: true });
  });

  it('scoped anyOf denial reason names the required scopes', () => {
    const policy: AccessPolicy = {
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['workflows:write', 'workflows:admin'] },
    };
    const result = evaluateAccess(policy, authNoScopes);
    if (result.allowed) throw new Error('expected denial');
    expect(result.reason).toContain('workflows:write');
    expect(result.reason).toContain('workflows:admin');
  });

  it('scoped allOf: requires every scope (including unauthenticated guard)', () => {
    const policy: AccessPolicy = {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['workflows:read', 'workflows:write'] },
    };

    // Unauthenticated must short-circuit to `unauthorized`, not `forbidden`.
    expect(evaluateAccess(policy, unauth)).toMatchObject({
      allowed: false,
      classification: 'unauthorized',
    });
    expect(evaluateAccess(policy, withReadOnly)).toMatchObject({
      allowed: false,
      classification: 'forbidden',
    });
    expect(evaluateAccess(policy, withReadWrite)).toEqual({ allowed: true });
  });

  it('optionalAuth anyOf: unauthenticated proceeds; authenticated must satisfy scopes', () => {
    const policy: AccessPolicy = {
      kind: 'optionalAuth',
      authenticatedScopes: { kind: 'anyOf', scopes: ['workflows:read'] },
    };

    expect(evaluateAccess(policy, unauth)).toEqual({ allowed: true });
    expect(evaluateAccess(policy, withReadOnly)).toEqual({ allowed: true });
    expect(evaluateAccess(policy, authNoScopes)).toMatchObject({
      allowed: false,
      classification: 'forbidden',
    });
  });

  it('optionalAuth allOf: unauthenticated proceeds; authenticated must satisfy every scope', () => {
    const policy: AccessPolicy = {
      kind: 'optionalAuth',
      authenticatedScopes: { kind: 'allOf', scopes: ['workflows:read', 'workflows:write'] },
    };
    expect(evaluateAccess(policy, unauth)).toEqual({ allowed: true });
    expect(evaluateAccess(policy, withReadWrite)).toEqual({ allowed: true });
    expect(evaluateAccess(policy, withReadOnly)).toMatchObject({
      allowed: false,
      classification: 'forbidden',
    });
  });

  it('denial reasons name the missing scopes', () => {
    const policy: AccessPolicy = {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['workflows:read', 'workflows:write', 'workflows:admin'] },
    };
    const result = evaluateAccess(policy, withReadOnly);
    if (result.allowed) {
      throw new Error('expected denial');
    }
    expect(result.reason).toContain('workflows:write');
    expect(result.reason).toContain('workflows:admin');
    expect(result.reason).not.toContain('workflows:read');
  });
});

describe('JWT principals integrate with evaluateAccess', () => {
  it('jwt principal with the right scope passes a scoped access check', () => {
    const principal = principalFromJwtClaims({ scope: 'workflows:write', sub: 's' });
    const policy: AccessPolicy = {
      kind: 'scoped',
      scopes: {
        kind: 'anyOf',
        scopes: ['workflows:write'] satisfies [AuthorizationScope, ...AuthorizationScope[]],
      },
    };
    expect(evaluateAccess(policy, principal)).toEqual({ allowed: true });
  });
});
