import { describe, expect, it } from 'bun:test';

import { isRecord, safeDebugStringify, sanitizeDebugValueForDisplay } from './debug-output.ts';

describe('debug output sanitization', () => {
  it('redacts sensitive keys and token-like strings', () => {
    const sanitized = sanitizeDebugValueForDisplay({
      apiKey: 'sk-test-123',
      authorization: 'Bearer secret-token',
      nested: {
        password: 'p4ssw0rd',
      },
      profile: {
        name: 'Ada',
      },
    });

    expect(sanitized).toEqual({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
      },
      profile: {
        name: 'Ada',
      },
    });
  });

  it('redacts payment-card-like strings', () => {
    expect(sanitizeDebugValueForDisplay('4111 1111 1111 1111')).toBe('[REDACTED]');
    expect(sanitizeDebugValueForDisplay('5555 5555 5555 4444')).toBe('[REDACTED]');
  });

  it('preserves non-sensitive strings that only resemble tokens loosely', () => {
    expect(sanitizeDebugValueForDisplay('short.token.parts')).toBe('short.token.parts');
    expect(sanitizeDebugValueForDisplay('1234x567890123')).toBe('1234x567890123');
  });

  it('sanitizes built-in objects and collection values', () => {
    const sanitized = sanitizeDebugValueForDisplay({
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      failure: new Error('Bearer top-secret'),
      bytes: new Uint8Array([1, 2, 3]),
      map: new Map([
        ['apiKey', 'secret'],
        ['safe', 'visible'],
      ]),
      set: new Set(['4111-1111-1111-1111', 'kept']),
      amount: 42n,
      symbol: Symbol.for('marker'),
      callback: function namedHandler() {
        return undefined;
      },
      instance: new (class CustomThing {
        readonly kind = 'custom';
      })(),
      plainNullPrototype: Object.assign(Object.create(null), { token: 'sensitive' }),
    });

    expect(sanitized).toEqual({
      occurredAt: '2026-01-01T00:00:00.000Z',
      failure: {
        name: 'Error',
        message: '[REDACTED]',
      },
      bytes: '[Uint8Array(3)]',
      map: {
        apiKey: '[REDACTED]',
        safe: 'visible',
      },
      set: ['[REDACTED]', 'kept'],
      amount: '42',
      symbol: 'Symbol(marker)',
      callback: '[Function namedHandler]',
      instance: '[object Object]',
      plainNullPrototype: {
        token: '[REDACTED]',
      },
    });
  });

  it('redacts Basic auth strings and stringifies primitives predictably', () => {
    expect(safeDebugStringify('Basic abc123')).toBe('"[REDACTED]"');
    expect(safeDebugStringify(undefined)).toBe('undefined');
    expect(safeDebugStringify(Symbol.for('worker'))).toBe('"Symbol(worker)"');
  });

  it('stringifies circular values without throwing', () => {
    const circular: Record<string, unknown> = { id: 'wf-1' };
    circular['self'] = circular;

    expect(safeDebugStringify(circular, 2)).toContain('"self": "[Circular]"');
  });

  it('preserves non-secret strings and recognizes record-like values', () => {
    expect(sanitizeDebugValueForDisplay('plain text')).toBe('plain text');
    expect(isRecord({ id: 'wf-1' })).toBe(true);
    expect(isRecord(['wf-1'])).toBe(false);
  });

  it('redacts basic authorization credentials and ignores invalid card-like strings', () => {
    expect(sanitizeDebugValueForDisplay('Basic dXNlcjpzZWNyZXQ=')).toBe('[REDACTED]');
    expect(sanitizeDebugValueForDisplay('4111 1111 1111 1112')).toBe('4111 1111 1111 1112');
    expect(sanitizeDebugValueForDisplay('not.a.jwt')).toBe('not.a.jwt');
  });

  it('sanitizes error, typed-array, set, bigint, symbol, and exotic object values', () => {
    const symbolValue = Symbol('token');
    const sanitized = sanitizeDebugValueForDisplay({
      error: new Error('Bearer token'),
      bytes: new Uint8Array([1, 2, 3]),
      set: new Set(['alpha', 'beta']),
      bigint: 42n,
      symbol: symbolValue,
      exotic: new URL('https://example.com'),
    });

    expect(sanitized).toEqual({
      error: {
        name: 'Error',
        message: '[REDACTED]',
      },
      bytes: '[Uint8Array(3)]',
      set: ['alpha', 'beta'],
      bigint: '42',
      symbol: 'Symbol(token)',
      exotic: '[object URL]',
    });
  });

  it('returns the fallback marker when JSON serialization throws unexpectedly', () => {
    const originalStringify = JSON.stringify;

    try {
      JSON.stringify = (() => {
        throw new Error('serializer exploded');
      }) as typeof JSON.stringify;

      expect(safeDebugStringify({ id: 'wf-1' })).toBe('[unserializable]');
    } finally {
      JSON.stringify = originalStringify;
    }
  });
});
