import { describe, expect, it } from 'bun:test';

import { defaultAuthAuditSink, emitAuthAuditEvent, type AuthAuditEvent } from './audit.ts';

function request(path = '/v1/workflows', init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe('emitAuthAuditEvent', () => {
  it('emits a structured success event with subject and method', () => {
    const events: AuthAuditEvent[] = [];
    emitAuthAuditEvent((e) => events.push(e), {
      outcome: 'success',
      method: 'api-key',
      subject: 'service-account-7',
      request: request('/v1/workflows', { method: 'POST' }),
    });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.outcome).toBe('success');
    expect(event.method).toBe('api-key');
    expect(event.subject).toBe('service-account-7');
    expect(event.path).toBe('/v1/workflows');
    expect(event.httpMethod).toBe('POST');
    expect(typeof event.timestamp).toBe('string');
  });

  it('emits a structured failure event with a client-safe reason', () => {
    const events: AuthAuditEvent[] = [];
    emitAuthAuditEvent((e) => events.push(e), {
      outcome: 'failure',
      method: 'unknown',
      subject: undefined,
      request: request(),
      reason: 'No valid credentials provided',
    });

    expect(events[0]!.outcome).toBe('failure');
    expect(events[0]!.reason).toBe('No valid credentials provided');
    expect(events[0]!.subject).toBeUndefined();
  });

  it('records a one-way credential fingerprint but never the raw credential', () => {
    const events: AuthAuditEvent[] = [];
    const secret = 'weft_key_top_secret_value';
    emitAuthAuditEvent((e) => events.push(e), {
      outcome: 'failure',
      method: 'unknown',
      subject: undefined,
      request: request(),
      presentedCredential: secret,
    });

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('top_secret');
    expect(events[0]!.credentialFingerprint).toBeDefined();
    expect(events[0]!.credentialFingerprint).not.toContain(secret);
  });

  it('swallows a throwing sink so request handling is not broken', () => {
    expect(() =>
      emitAuthAuditEvent(
        () => {
          throw new Error('sink exploded');
        },
        {
          outcome: 'success',
          method: 'jwt',
          subject: 'u1',
          request: request(),
        },
      ),
    ).not.toThrow();
  });
});

describe('defaultAuthAuditSink', () => {
  it('writes a structured JSON line discriminated by type', () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (line: string) => lines.push(line);
    try {
      defaultAuthAuditSink({
        outcome: 'success',
        method: 'api-key',
        subject: 'svc',
        path: '/v1/workflows',
        httpMethod: 'GET',
        timestamp: new Date().toISOString(),
      });
    } finally {
      console.info = originalInfo;
    }

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe('weft.auth-audit');
    expect(parsed.outcome).toBe('success');
  });

  it('routes failures to console.warn', () => {
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: string) => warned.push(line);
    try {
      defaultAuthAuditSink({
        outcome: 'failure',
        method: 'unknown',
        path: '/v1/workflows',
        httpMethod: 'GET',
        timestamp: new Date().toISOString(),
        reason: 'No valid credentials provided',
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!).outcome).toBe('failure');
  });
});
