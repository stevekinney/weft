import { describe, expect, it } from 'bun:test';

import { createAuthenticator } from './index.ts';
import { createRotatingApiKeyStore } from './rotating-api-key-store.ts';

function requestWithKey(key: string): Request {
  return new Request('http://localhost/v1/workflows', {
    method: 'GET',
    headers: { 'X-API-Key': key },
  });
}

describe('createRotatingApiKeyStore', () => {
  it('resolves a registered key to a principal with its scopes', async () => {
    const store = createRotatingApiKeyStore();
    store.add('key-1', { subject: 'svc', scopes: ['workflows:read'] });

    const principal = await store.resolve('key-1');
    expect(principal).not.toBeNull();
    expect(principal!.method).toBe('api-key');
    expect(principal!.subject).toBe('svc');
    expect(principal!.hasScope('workflows:read')).toBe(true);
  });

  it('returns null for an unknown key', async () => {
    const store = createRotatingApiKeyStore();
    expect(await store.resolve('nope')).toBeNull();
  });

  it('returns null after a key is revoked', async () => {
    const store = createRotatingApiKeyStore();
    store.add('key-1', { subject: 'svc' });
    expect(store.revoke('key-1')).toBe(true);
    expect(await store.resolve('key-1')).toBeNull();
    expect(store.revoke('key-1')).toBe(false);
  });

  it('rejects keys past their expiry timestamp', async () => {
    let clock = 0;
    const store = createRotatingApiKeyStore(() => clock);
    store.add('expiring', { subject: 'svc', expiresAt: 1_000 });

    expect(await store.resolve('expiring')).not.toBeNull();
    clock = 1_000;
    expect(await store.resolve('expiring')).toBeNull();
    expect(store.has('expiring')).toBe(false);
  });

  it('rejects empty keys', () => {
    const store = createRotatingApiKeyStore();
    expect(() => store.add('', { subject: 'svc' })).toThrow();
  });

  it('replaces a registered key without retaining stale registration data', async () => {
    const store = createRotatingApiKeyStore();
    store.add('key-1', { subject: 'old-service', scopes: ['workflows:read'] });
    store.add('key-1', { subject: 'new-service', scopes: ['workflows:write'] });

    const principal = await store.resolve('key-1');
    expect(principal?.subject).toBe('new-service');
    expect(principal?.hasScope('workflows:read')).toBe(false);
    expect(principal?.hasScope('workflows:write')).toBe(true);
  });

  it('two overlapping valid keys both authenticate during a rotation window', async () => {
    const store = createRotatingApiKeyStore();
    // Introduce the new key while the old one is still valid.
    store.add('key-old', { subject: 'svc', scopes: ['workflows:read'] });
    store.add('key-new', { subject: 'svc', scopes: ['workflows:read'] });

    const auth = await createAuthenticator({ resolveApiKeyPrincipal: store.resolve });

    const oldResult = await auth(requestWithKey('key-old'));
    const newResult = await auth(requestWithKey('key-new'));
    expect(oldResult.authenticated).toBe(true);
    expect(newResult.authenticated).toBe(true);

    // Complete the rotation: revoke the outgoing key. The new key keeps working;
    // the old key is now rejected — no restart required.
    store.revoke('key-old');
    const afterRotationOld = await auth(requestWithKey('key-old'));
    const afterRotationNew = await auth(requestWithKey('key-new'));
    expect(afterRotationOld.authenticated).toBe(false);
    expect(afterRotationNew.authenticated).toBe(true);
  });

  it('reports its size', () => {
    const store = createRotatingApiKeyStore();
    expect(store.size).toBe(0);
    store.add('a', { subject: 's' });
    store.add('b', { subject: 's' });
    expect(store.size).toBe(2);
    store.revoke('a');
    expect(store.size).toBe(1);
  });
});
