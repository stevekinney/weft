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

  it('prefers `tenantId` when all three tenant fields are set', () => {
    const principal = principalFromJwtClaims({
      tenantId: 'wins',
      tenant_id: 'loses',
      tenant: 'also-loses',
      sub: 's',
    });
    expect(principal.tenantId).toBe('wins');
  });

  it('falls through to `tenant_id` when `tenantId` is missing', () => {
    const principal = principalFromJwtClaims({
      tenant_id: 'second',
      tenant: 'third',
      sub: 's',
    });
    expect(principal.tenantId).toBe('second');
  });

  it('skips empty-string `tenantId` and falls through to `tenant_id`', () => {
    const principal = principalFromJwtClaims({
      tenantId: '',
      tenant_id: 'real-tenant',
      sub: 's',
    });
    expect(principal.tenantId).toBe('real-tenant');
  });

  it('skips empty-string `tenant_id` and falls through to `tenant`', () => {
    const principal = principalFromJwtClaims({
      tenantId: '',
      tenant_id: '',
      tenant: 'last-resort',
      sub: 's',
    });
    expect(principal.tenantId).toBe('last-resort');
  });

  it('skips whitespace-only tenant claims and falls through (consistent with scope claims)', () => {
    const principal = principalFromJwtClaims({
      tenantId: '   ',
      tenant_id: '\t\n',
      tenant: 'real-tenant',
      sub: 's',
    });
    expect(principal.tenantId).toBe('real-tenant');
  });

  it('trims surrounding whitespace from an accepted tenantId', () => {
    const principal = principalFromJwtClaims({ tenantId: '  tenant-a  ', sub: 's' });
    expect(principal.tenantId).toBe('tenant-a');
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
