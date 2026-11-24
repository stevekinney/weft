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

  it('redacts a loose sensitive key only when its value could carry a secret', () => {
    expect(
      sanitizeDebugValueForDisplay({
        inputTokens: 12,
        outputTokens: 3,
        passed: true,
        cardinality: 3,
        sessionId: 's',
        token: 'x',
        authCount: 2,
        refreshToken: null,
        authorization: undefined,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      passed: true,
      cardinality: 3,
      sessionId: '[REDACTED]',
      token: '[REDACTED]',
      authCount: 2,
      refreshToken: null,
      authorization: undefined,
    });
  });

  it('redacts a strong secret key whatever its value is', () => {
    expect(
      sanitizeDebugValueForDisplay({
        card: 4111111111111111,
        cardNumber: 4111111111111111,
        creditCard: 4111111111111111,
        cvv: 123,
        cvc: 123,
        ssn: 123456789,
        pin: 1234,
        password: 12345678,
        passwd: 12345678,
        secret: true,
        clientSecret: 12345,
        apiKey: 987654,
        api_key: 987654,
        'api-key': 987654,
        API_KEY: 987654,
        APIKey: 987654,
        privateKey: 1,
        private_key: 1,
        accessKey: 1,
        accessKeyId: 1,
        credentials: false,
        userSSN: 123456789,
        cards: 1,
        pinCode: 1234,
        secretKey: null,
      }),
    ).toEqual(
      Object.fromEntries(
        [
          'card',
          'cardNumber',
          'creditCard',
          'cvv',
          'cvc',
          'ssn',
          'pin',
          'password',
          'passwd',
          'secret',
          'clientSecret',
          'apiKey',
          'api_key',
          'api-key',
          'API_KEY',
          'APIKey',
          'privateKey',
          'private_key',
          'accessKey',
          'accessKeyId',
          'credentials',
          'userSSN',
          'cards',
          'pinCode',
          'secretKey',
        ].map((key) => [key, '[REDACTED]']),
      ),
    );
  });

  it('matches strong keys by word, so look-alike names stay readable', () => {
    expect(
      sanitizeDebugValueForDisplay({
        cardinality: 3,
        passed: true,
        passCount: 2,
        spinning: 1,
        pinned: true,
        secretary: 4,
        accessCount: 9,
        keyCount: 1,
        discard: 5,
      }),
    ).toEqual({
      cardinality: 3,
      passed: true,
      passCount: 2,
      spinning: 1,
      pinned: true,
      secretary: 4,
      accessCount: 9,
      keyCount: 1,
      discard: 5,
    });
  });

  it('redacts an object, array, bigint, symbol, or function under a loose sensitive key', () => {
    expect(
      sanitizeDebugValueForDisplay({
        authContext: { user: 'ada', count: 3 },
        tokens: ['a', 'b'],
        tokenBigint: 1n,
        sessionSymbol: Symbol('s'),
        authCallback: () => undefined,
      }),
    ).toEqual({
      authContext: '[REDACTED]',
      tokens: '[REDACTED]',
      tokenBigint: '[REDACTED]',
      sessionSymbol: '[REDACTED]',
      authCallback: '[REDACTED]',
    });
  });

  it('applies the same rule to Map entries', () => {
    expect(
      sanitizeDebugValueForDisplay(
        new Map<string, unknown>([
          ['apiKey', 'x'],
          ['tokenCount', 7],
        ]),
      ),
    ).toEqual({ apiKey: '[REDACTED]', tokenCount: 7 });
  });

  it('labels an invalid Date instead of throwing', () => {
    expect(sanitizeDebugValueForDisplay({ when: new Date('not a date'), id: 'wf-1' })).toEqual({
      when: '[Invalid Date]',
      id: 'wf-1',
    });
    expect(sanitizeDebugValueForDisplay(new Date('not a date'))).toBe('[Invalid Date]');
  });

  it('keeps the rest of an object when one property getter throws', () => {
    const hostile: Record<string, unknown> = { id: 'wf-1', apiKey: 'x' };
    Object.defineProperty(hostile, 'broken', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    Object.defineProperty(hostile, 'secretBroken', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });

    expect(sanitizeDebugValueForDisplay(hostile)).toEqual({
      id: 'wf-1',
      apiKey: '[REDACTED]',
      broken: '[unserializable]',
      secretBroken: '[REDACTED]',
    });
  });

  it('labels an object whose keys cannot be read instead of throwing', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys exploded');
        },
      },
    );

    expect(sanitizeDebugValueForDisplay({ id: 'wf-1', hostile })).toEqual({
      id: 'wf-1',
      hostile: '[unserializable]',
    });
  });

  it('labels an Error whose message getter throws instead of throwing', () => {
    const failure = new Error('x');
    Object.defineProperty(failure, 'message', {
      get() {
        throw new Error('message exploded');
      },
    });

    expect(sanitizeDebugValueForDisplay({ failure })).toEqual({ failure: '[unserializable]' });
  });
});
