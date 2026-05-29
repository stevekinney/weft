import { describe, expect, it } from 'bun:test';

import { isSensitiveHeader, redactCredential, redactHeaders } from './redaction.ts';

describe('redactCredential', () => {
  it('never reveals the secret value', () => {
    const secret = 'weft_key_super_secret_value_12345';
    const masked = redactCredential(secret);
    expect(masked).not.toContain(secret);
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('super');
  });

  it('produces a stable fingerprint for equal inputs', () => {
    expect(redactCredential('abc123')).toBe(redactCredential('abc123'));
  });

  it('produces different fingerprints for different inputs (typically)', () => {
    expect(redactCredential('abc123')).not.toBe(redactCredential('xyz789'));
  });

  it('strips a Bearer scheme so header sources fingerprint alike', () => {
    expect(redactCredential('Bearer token-value')).toBe(redactCredential('token-value'));
  });

  it('reports the token length but not the bytes', () => {
    const masked = redactCredential('1234567890');
    expect(masked).toContain('len=10');
  });

  it('masks empty, null, and undefined uniformly', () => {
    expect(redactCredential('')).toBe('<redacted:empty>');
    expect(redactCredential(null)).toBe('<redacted:empty>');
    expect(redactCredential(undefined)).toBe('<redacted:empty>');
  });
});

describe('redactHeaders', () => {
  it('masks Authorization and X-API-Key but passes other headers through', () => {
    const request = new Request('http://localhost/v1/workflows', {
      headers: {
        Authorization: 'Bearer super-secret-token',
        'X-API-Key': 'weft_key_abc123',
        'X-Trace-Id': 'trace-42',
        'Content-Type': 'application/json',
      },
    });

    const safe = redactHeaders(request.headers);

    expect(safe['authorization']).not.toContain('super-secret-token');
    expect(safe['authorization']?.startsWith('<redacted:')).toBe(true);
    expect(safe['x-api-key']).not.toContain('weft_key_abc123');
    expect(safe['x-api-key']?.startsWith('<redacted:')).toBe(true);
    expect(safe['x-trace-id']).toBe('trace-42');
    expect(safe['content-type']).toBe('application/json');
  });

  it('masks cookie headers', () => {
    const request = new Request('http://localhost/v1/workflows', {
      headers: { Cookie: 'session=secret-session-id' },
    });
    const safe = redactHeaders(request.headers);
    expect(safe['cookie']).not.toContain('secret-session-id');
    expect(safe['cookie']?.startsWith('<redacted:')).toBe(true);
  });

  it('never lets a raw credential survive serialization to a log string', () => {
    const request = new Request('http://localhost/v1/workflows', {
      headers: {
        Authorization: 'Bearer top-secret-jwt',
        'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      },
    });
    const logLine = JSON.stringify(redactHeaders(request.headers));
    expect(logLine).not.toContain('top-secret-jwt');
    expect(logLine).not.toContain('dXNlcjpwYXNz');
  });
});

describe('isSensitiveHeader', () => {
  it('matches case-insensitively', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('AUTHORIZATION')).toBe(true);
    expect(isSensitiveHeader('x-api-key')).toBe(true);
    expect(isSensitiveHeader('X-Trace-Id')).toBe(false);
  });
});
