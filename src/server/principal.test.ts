/**
 * Tests for AuthenticatedPrincipal construction, scope derivation, and the
 * stable Principal discriminated union used across all transports.
 */

import { describe, expect, it } from 'bun:test';

import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
  type Principal,
} from './principal.ts';

describe('principalFromJwtClaims', () => {
  it('derives scopes from space-delimited `scope` claim', () => {
    const principal = principalFromJwtClaims({
      scope: 'workflows:read workflows:write',
      sub: 'user-1',
    });
    expect(principal.method).toBe('jwt');
    expect(principal.hasScope('workflows:read')).toBe(true);
    expect(principal.hasScope('workflows:write')).toBe(true);
    expect(principal.hasScope('schedules:read')).toBe(false);
  });

  it('derives scopes from `scp` claim when `scope` is absent', () => {
    const principal = principalFromJwtClaims({ scp: 'schedules:read', sub: 's' });
    expect(principal.hasScope('schedules:read')).toBe(true);
  });

  it('merges scopes from `permissions` array with scopes from the string claims', () => {
    const principal = principalFromJwtClaims({
      scope: 'workflows:read',
      permissions: ['reviews:read', 'reviews:write'],
      sub: 'reviewer',
    });
    expect(principal.hasScope('workflows:read')).toBe(true);
    expect(principal.hasScope('reviews:read')).toBe(true);
    expect(principal.hasScope('reviews:write')).toBe(true);
  });

  it('returns an empty scope set when no scope claim is present', () => {
    const principal = principalFromJwtClaims({ sub: 'user-2' });
    expect(principal.hasScope('workflows:read')).toBe(false);
    expect(principal.scopes.size).toBe(0);
  });

  it('exposes the raw claims as-is and reads `subject` from `sub`', () => {
    const claims = { sub: 'abc', scope: 'workflows:read' };
    const principal = principalFromJwtClaims(claims);
    expect(principal.subject).toBe('abc');
    expect(principal.claims).toBe(claims);
  });

  it('ignores non-string `scope`, `scp`, and non-array `permissions` values', () => {
    const principal = principalFromJwtClaims({
      scope: 42,
      scp: { weird: true },
      permissions: 'oops',
      sub: 's',
    });
    expect(principal.scopes.size).toBe(0);
  });
});

describe('principalFromApiKey', () => {
  it('produces an api-key principal with the supplied scope set', () => {
    const principal = principalFromApiKey({
      subject: 'key-42',
      scopes: ['workflows:read', 'workflows:write'],
    });
    expect(principal.method).toBe('api-key');
    expect(principal.subject).toBe('key-42');
    expect(principal.hasScope('workflows:read')).toBe(true);
    expect(principal.claims).toBeUndefined();
  });

  it('accepts an empty scope list and reports an empty scope set', () => {
    const principal = principalFromApiKey({ subject: 'key-0', scopes: [] });
    expect(principal.scopes.size).toBe(0);
    expect(principal.hasScope('workflows:read')).toBe(false);
  });
});

describe('principalFromMutualTls', () => {
  it('produces an mtls principal with the configured default scopes', () => {
    const principal = principalFromMutualTls({
      subject: 'CN=service',
      scopes: ['system:read'],
    });
    expect(principal.method).toBe('mtls');
    expect(principal.hasScope('system:read')).toBe(true);
  });
});

describe('principalFromStdioLocal', () => {
  it('produces a stdio-local principal with admin scopes', () => {
    const principal = principalFromStdioLocal();

    expect(principal.method).toBe('stdio-local');
    expect(principal.subject).toBe('stdio-local');
    expect(principal.hasScope('workflows:read')).toBe(true);
    expect(principal.hasScope('system:read')).toBe(true);
  });
});

describe('anonymousPrincipal', () => {
  it('is a distinct unauthenticated principal', () => {
    const principal: Principal = anonymousPrincipal();
    expect(principal.method).toBe('unauthenticated');
  });

  it('does not carry a hasScope method', () => {
    const principal: Principal = anonymousPrincipal();
    expect('hasScope' in principal).toBe(false);
  });
});
