import { describe, expect, it } from 'bun:test';

import {
  buildPreflightResponse,
  canonicalizeOrigin,
  decorateResponseWithCors,
  isOriginAllowed,
  isPreflightRequest,
  resolveCorsPolicy,
  validateCorsOptions,
  type CorsOptions,
} from './cors.ts';

function preflight(headers: Record<string, string>): Request {
  return new Request('http://api.test/v1/workflows', { method: 'OPTIONS', headers });
}

describe('canonicalizeOrigin', () => {
  it('rejects the literal null origin', () => {
    expect(canonicalizeOrigin('null')).toBeNull();
  });

  it('rejects empty and unparseable input', () => {
    expect(canonicalizeOrigin('')).toBeNull();
    expect(canonicalizeOrigin('   ')).toBeNull();
    expect(canonicalizeOrigin('not a url')).toBeNull();
  });

  it('elides default ports and lowercases the host', () => {
    expect(canonicalizeOrigin('https://Example.com:443')).toBe('https://example.com');
    expect(canonicalizeOrigin('http://Example.com:80')).toBe('http://example.com');
  });

  it('drops trailing path and is stable across a trailing slash', () => {
    expect(canonicalizeOrigin('https://example.com/')).toBe('https://example.com');
    expect(canonicalizeOrigin('https://example.com/ui')).toBe('https://example.com');
  });

  it('preserves a non-default port', () => {
    expect(canonicalizeOrigin('https://example.com:8443')).toBe('https://example.com:8443');
  });
});

describe('isOriginAllowed', () => {
  it('matches an allowlisted origin regardless of case/port/slash', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['https://app.example.com'] });
    expect(isOriginAllowed(policy, 'https://APP.example.com:443/')).toBe(true);
    expect(isOriginAllowed(policy, 'https://other.example.com')).toBe(false);
  });

  it('rejects a null Origin header even with a wildcard policy', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['*'] });
    expect(isOriginAllowed(policy, null)).toBe(false);
    expect(isOriginAllowed(policy, 'null')).toBe(false);
  });

  it('honors a predicate allowlist', () => {
    const policy = resolveCorsPolicy({
      allowedOrigins: (origin) => origin.endsWith('.trusted.test'),
    });
    expect(isOriginAllowed(policy, 'https://a.trusted.test')).toBe(true);
    expect(isOriginAllowed(policy, 'https://evil.test')).toBe(false);
  });

  it('allows any origin under the wildcard sentinel', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['*'] });
    expect(isOriginAllowed(policy, 'https://anything.test')).toBe(true);
  });

  it('allows nothing when no origins are configured', () => {
    const policy = resolveCorsPolicy({});
    expect(isOriginAllowed(policy, 'https://app.example.com')).toBe(false);
  });
});

describe('isPreflightRequest', () => {
  it('is true only for OPTIONS with the request-method hint', () => {
    expect(
      isPreflightRequest(
        preflight({ origin: 'https://x.test', 'access-control-request-method': 'POST' }),
      ),
    ).toBe(true);
    expect(isPreflightRequest(preflight({ origin: 'https://x.test' }))).toBe(false);
    expect(
      isPreflightRequest(
        new Request('http://api.test/v1/workflows', {
          method: 'GET',
          headers: { 'access-control-request-method': 'POST' },
        }),
      ),
    ).toBe(false);
  });
});

describe('buildPreflightResponse', () => {
  const policy = resolveCorsPolicy({
    allowedOrigins: ['https://app.example.com'],
    allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
    maxAgeSeconds: 120,
  });

  it('emits Access-Control-* for an allowed origin, method, and headers', () => {
    const response = buildPreflightResponse(
      policy,
      preflight({
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('120');
    expect(response.headers.get('Vary')).toBe(
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('allows SSE reconnect headers under the default allowed headers', () => {
    const defaultHeaderPolicy = resolveCorsPolicy({
      allowedOrigins: ['https://app.example.com'],
    });

    const response = buildPreflightResponse(
      defaultHeaderPolicy,
      preflight({
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'last-event-id, cache-control',
      }),
    );

    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Last-Event-ID');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Cache-Control');
  });

  it('allows preflight requests without requested headers', () => {
    const response = buildPreflightResponse(
      policy,
      preflight({
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
      }),
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type',
    );
  });

  it('omits CORS headers for a disallowed origin', () => {
    const response = buildPreflightResponse(
      policy,
      preflight({
        origin: 'https://evil.test',
        'access-control-request-method': 'POST',
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // Vary still set so caches do not reuse this decision.
    expect(response.headers.get('Vary')).toContain('Origin');
  });

  it('omits CORS headers when the requested method is not allowed', () => {
    const response = buildPreflightResponse(
      policy,
      preflight({
        origin: 'https://app.example.com',
        'access-control-request-method': 'TRACE',
      }),
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('omits CORS headers when a requested header is not allowed', () => {
    const response = buildPreflightResponse(
      policy,
      preflight({
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-not-allowed',
      }),
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('decorateResponseWithCors', () => {
  it('echoes the exact origin for a credentialed policy (never a wildcard)', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['*'], credentials: false });
    // credentials:false + wildcard may answer '*'
    const wildcard = decorateResponseWithCors(
      policy,
      new Request('http://api.test/v1', { headers: { origin: 'https://a.test' } }),
      new Response('ok'),
    );
    expect(wildcard.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const credentialed = resolveCorsPolicy({
      allowedOrigins: ['https://a.test'],
      credentials: true,
    });
    const echoed = decorateResponseWithCors(
      credentialed,
      new Request('http://api.test/v1', { headers: { origin: 'https://a.test' } }),
      new Response('ok'),
    );
    expect(echoed.headers.get('Access-Control-Allow-Origin')).toBe('https://a.test');
    expect(echoed.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(echoed.headers.get('Vary')).toContain('Origin');
  });

  it('does not add headers for a disallowed or absent origin', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['https://a.test'] });
    const disallowed = decorateResponseWithCors(
      policy,
      new Request('http://api.test/v1', { headers: { origin: 'https://b.test' } }),
      new Response('ok'),
    );
    expect(disallowed.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const noOrigin = decorateResponseWithCors(
      policy,
      new Request('http://api.test/v1'),
      new Response('ok'),
    );
    expect(noOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('exposes configured response headers', () => {
    const policy = resolveCorsPolicy({
      allowedOrigins: ['https://a.test'],
      exposedHeaders: ['X-Weft-Trace', 'X-Request-Id'],
    });
    const response = decorateResponseWithCors(
      policy,
      new Request('http://api.test/v1', { headers: { origin: 'https://a.test' } }),
      new Response('ok'),
    );
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
      'X-Weft-Trace, X-Request-Id',
    );
  });

  it('appends Origin to an existing Vary header without clobbering it, mutating in place', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['https://a.test'] });
    const response = new Response('ok', { headers: { Vary: 'Accept-Encoding' } });
    const result = decorateResponseWithCors(
      policy,
      new Request('http://api.test/v1', { headers: { origin: 'https://a.test' } }),
      response,
    );
    // The decorator mutates and returns the same Response; assert identity so a
    // future move to an immutable (new-Response) implementation cannot pass
    // silently.
    expect(result).toBe(response);
    expect(result.headers.get('Vary')).toBe('Accept-Encoding, Origin');
  });

  it('does not duplicate Origin in Vary when decorated twice', () => {
    const policy = resolveCorsPolicy({ allowedOrigins: ['https://a.test'] });
    const request = new Request('http://api.test/v1', { headers: { origin: 'https://a.test' } });
    const response = new Response('ok');
    decorateResponseWithCors(policy, request, response);
    decorateResponseWithCors(policy, request, response);
    expect(response.headers.get('Vary')).toBe('Origin');
  });
});

describe('resolveCorsPolicy — Authorization auto-add', () => {
  it('adds Authorization to allowed headers when auth is required', () => {
    const policy = resolveCorsPolicy(
      { allowedOrigins: ['https://a.test'], allowedHeaders: ['Content-Type'] },
      true,
    );
    expect(policy.allowedHeadersHeader).toContain('Authorization');
    expect(policy.allowedHeaderSet.has('authorization')).toBe(true);
  });

  it('does not duplicate Authorization when already present', () => {
    const policy = resolveCorsPolicy(
      { allowedOrigins: ['https://a.test'], allowedHeaders: ['authorization', 'Content-Type'] },
      true,
    );
    const count = policy.allowedHeadersHeader
      .split(', ')
      .filter((header) => header.toLowerCase() === 'authorization').length;
    expect(count).toBe(1);
  });
});

describe('validateCorsOptions', () => {
  it('rejects credentials:true with a wildcard origin', () => {
    const options: CorsOptions = { allowedOrigins: ['*'], credentials: true };
    expect(() => validateCorsOptions(options)).toThrow(/wildcard origin is illegal/);
  });

  it('rejects a wildcard origin paired with an Authorization allowed-header', () => {
    const options: CorsOptions = { allowedOrigins: ['*'], allowedHeaders: ['Authorization'] };
    expect(() => validateCorsOptions(options)).toThrow(/bearer tokens/);
  });

  it('rejects a wildcard origin when allowedHeaders is omitted (Authorization is in defaults)', () => {
    // The most likely misconfiguration: `allowedOrigins: ['*']` with no
    // explicit allowedHeaders falls back to DEFAULT_ALLOWED_HEADERS, which
    // includes Authorization — so the guard must still fire.
    const options: CorsOptions = { allowedOrigins: ['*'] };
    expect(() => validateCorsOptions(options)).toThrow(/bearer tokens/);
  });

  it('rejects a wildcard origin under configured auth even when allowedHeaders omits Authorization', () => {
    // resolveCorsPolicy auto-adds Authorization when auth is configured, so the
    // validator must account for that effective header set — otherwise this
    // exact config would pass validation and then resolve to a wildcard origin
    // that accepts bearer tokens.
    const options: CorsOptions = { allowedOrigins: ['*'], allowedHeaders: ['Content-Type'] };
    expect(() => validateCorsOptions(options, /* authConfigured */ true)).toThrow(/bearer tokens/);
    // Without auth, the same config is a legitimate public, non-credentialed API.
    expect(() => validateCorsOptions(options, /* authConfigured */ false)).not.toThrow();
  });

  it('accepts a wildcard origin for a public, non-credentialed, no-Authorization policy', () => {
    const options: CorsOptions = {
      allowedOrigins: ['*'],
      allowedHeaders: ['Content-Type'],
      credentials: false,
    };
    expect(() => validateCorsOptions(options)).not.toThrow();
  });

  it('accepts an explicit allowlist with credentials', () => {
    const options: CorsOptions = { allowedOrigins: ['https://app.example.com'], credentials: true };
    expect(() => validateCorsOptions(options)).not.toThrow();
  });
});
