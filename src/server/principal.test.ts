/**
 * Tests for AuthenticatedPrincipal construction, scope derivation, and the
 * Principal discriminated union.
 *
 * See reference Track 8 plan (design decisions 3 and 10).
 */

import { describe, expect, it } from 'bun:test';

import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
  type AuthenticatedPrincipal,
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

  it('derives scopes from `permissions` array when neither `scope` nor `scp` is set', () => {
    const principal = principalFromJwtClaims({
      permissions: ['reviews:read', 'reviews:write'],
      sub: 'reviewer',
    });
    expect(principal.hasScope('reviews:read')).toBe(true);
    expect(principal.hasScope('reviews:write')).toBe(true);
  });

  it('returns an empty scope set when no scope claim is present', () => {
    const principal = principalFromJwtClaims({ sub: 'user-2' });
    expect(principal.hasScope('workflows:read')).toBe(false);
    expect(principal.scopes.size).toBe(0);
  });

  it('extracts `tenantId` from `tenantId` / `tenant_id` / `tenant` claims in that order', () => {
    const a = principalFromJwtClaims({ tenantId: 'tenant-a', sub: 's' });
    expect(a.tenantId).toBe('tenant-a');

    const b = principalFromJwtClaims({ tenant_id: 'tenant-b', sub: 's' });
    expect(b.tenantId).toBe('tenant-b');

    const c = principalFromJwtClaims({ tenant: 'tenant-c', sub: 's' });
    expect(c.tenantId).toBe('tenant-c');

    const none = principalFromJwtClaims({ sub: 's' });
    expect(none.tenantId).toBeUndefined();
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
      permissions: 'oops' as unknown,
      sub: 's',
    });
    expect(principal.scopes.size).toBe(0);
  });
});

describe('principalFromApiKey', () => {
  it('produces an apiKey principal with the supplied scope set', () => {
    const principal = principalFromApiKey({
      subject: 'key-42',
      scopes: ['workflows:read', 'workflows:write'],
    });
    expect(principal.method).toBe('apiKey');
    expect(principal.subject).toBe('key-42');
    expect(principal.hasScope('workflows:read')).toBe(true);
    expect(principal.claims).toBeUndefined();
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
  it('produces a stdio-local principal with every authorization scope', () => {
    const principal = principalFromStdioLocal();
    expect(principal.method).toBe('stdio-local');
    expect(principal.hasScope('workflows:read')).toBe(true);
    expect(principal.hasScope('workflows:write')).toBe(true);
    expect(principal.hasScope('system:admin')).toBe(true);
  });
});

describe('anonymousPrincipal', () => {
  it('is a distinct unauthenticated principal', () => {
    const principal: Principal = anonymousPrincipal();
    expect(principal.method).toBe('unauthenticated');
  });

  it('does not satisfy any scope check via the AuthenticatedPrincipal shape', () => {
    const principal: Principal = anonymousPrincipal();
    expect((principal as unknown as AuthenticatedPrincipal).hasScope).toBeUndefined();
  });
});
