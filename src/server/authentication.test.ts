import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { AuthConfig, JWTConfig, JWTPayload } from './authentication.ts';
import {
  buildTLSOptions,
  createAuthenticator,
  signJWT,
  validateAuthConfig,
  verifyJWT,
} from './authentication.ts';
import type { WeftServer } from './index.ts';
import { serve } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-secret-key-at-least-32-chars!';
const TEST_API_KEY = 'weft_key_abc123';

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

// ---------------------------------------------------------------------------
// validateAuthConfig
// ---------------------------------------------------------------------------

describe('validateAuthConfig', () => {
  it('accepts valid API key configuration', () => {
    expect(() => validateAuthConfig({ apiKeys: ['key-1', 'key-2'] })).not.toThrow();
  });

  it('accepts valid JWT HMAC configuration', () => {
    expect(() => validateAuthConfig({ jwt: { secret: TEST_SECRET } })).not.toThrow();
  });

  it('accepts valid mTLS configuration', () => {
    expect(() =>
      validateAuthConfig({ mtls: { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem' } }),
    ).not.toThrow();
  });

  it('rejects empty configuration with no methods', () => {
    expect(() => validateAuthConfig({})).toThrow('at least one authentication method');
  });

  it('rejects empty API keys array', () => {
    expect(() => validateAuthConfig({ apiKeys: [] })).toThrow('at least one authentication method');
  });

  it('rejects JWT HMAC config without secret', () => {
    expect(() => validateAuthConfig({ jwt: { algorithm: 'HS256' } })).toThrow('requires "secret"');
  });

  it('rejects JWT RSA config without public key', () => {
    expect(() => validateAuthConfig({ jwt: { algorithm: 'RS256' } })).toThrow(
      'requires "publicKey"',
    );
  });

  it('rejects JWT ECDSA config without public key', () => {
    expect(() => validateAuthConfig({ jwt: { algorithm: 'ES256' } })).toThrow(
      'requires "publicKey"',
    );
  });
});

// ---------------------------------------------------------------------------
// signJWT + verifyJWT round-trip
// ---------------------------------------------------------------------------

describe('JWT verification', () => {
  async function importTestKey(config: JWTConfig) {
    const { importJWTKey } = await import('./authentication.ts');
    return importJWTKey(config);
  }

  it('verifies a valid HS256 JWT', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, algorithm: 'HS256' };
    const payload: JWTPayload = { sub: 'user-1', role: 'admin' };

    const token = await signJWT(payload, TEST_SECRET, 'HS256');
    const key = await importTestKey(config);
    const decoded = await verifyJWT(token, key, config);

    expect(decoded['sub']).toBe('user-1');
    expect(decoded['role']).toBe('admin');
  });

  it('verifies a valid HS384 JWT', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, algorithm: 'HS384' };
    const payload: JWTPayload = { sub: 'user-2' };

    const token = await signJWT(payload, TEST_SECRET, 'HS384');
    const key = await importTestKey(config);
    const decoded = await verifyJWT(token, key, config);

    expect(decoded['sub']).toBe('user-2');
  });

  it('verifies a valid HS512 JWT', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, algorithm: 'HS512' };
    const payload: JWTPayload = { sub: 'user-3' };

    const token = await signJWT(payload, TEST_SECRET, 'HS512');
    const key = await importTestKey(config);
    const decoded = await verifyJWT(token, key, config);

    expect(decoded['sub']).toBe('user-3');
  });

  it('rejects a JWT with an invalid signature', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, algorithm: 'HS256' };
    const token = await signJWT({ sub: 'user-1' }, 'wrong-secret-that-is-long-enough!!', 'HS256');
    const key = await importTestKey(config);

    await expect(verifyJWT(token, key, config)).rejects.toThrow('Invalid JWT signature');
  });

  it('rejects a JWT with a mismatched algorithm', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, algorithm: 'HS256' };
    // Sign with HS384 but verify expecting HS256
    const token = await signJWT({ sub: 'user-1' }, TEST_SECRET, 'HS384');
    const key = await importTestKey(config);

    await expect(verifyJWT(token, key, config)).rejects.toThrow('Algorithm mismatch');
  });

  it('rejects a malformed JWT (not three parts)', async () => {
    const config: JWTConfig = { secret: TEST_SECRET };
    const key = await importTestKey(config);

    await expect(verifyJWT('not-a-jwt', key, config)).rejects.toThrow('Invalid JWT format');
    await expect(verifyJWT('two.parts', key, config)).rejects.toThrow('Invalid JWT format');
  });

  it('rejects an expired JWT', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, clockTolerance: 0 };
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
    const token = await signJWT({ sub: 'user-1', exp: pastExpiry }, TEST_SECRET);
    const key = await importTestKey(config);

    await expect(verifyJWT(token, key, config)).rejects.toThrow('JWT expired');
  });

  it('accepts an expired JWT within clock tolerance', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, clockTolerance: 120 };
    const recentExpiry = Math.floor(Date.now() / 1000) - 60;
    const token = await signJWT({ sub: 'user-1', exp: recentExpiry }, TEST_SECRET);
    const key = await importTestKey(config);

    const decoded = await verifyJWT(token, key, config);
    expect(decoded['sub']).toBe('user-1');
  });

  it('rejects a not-yet-valid JWT', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, clockTolerance: 0 };
    const futureNbf = Math.floor(Date.now() / 1000) + 3600;
    const token = await signJWT({ sub: 'user-1', nbf: futureNbf }, TEST_SECRET);
    const key = await importTestKey(config);

    await expect(verifyJWT(token, key, config)).rejects.toThrow('JWT not yet valid');
  });

  it('rejects a JWT with the wrong issuer', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, issuer: 'https://auth.example.com' };
    const token = await signJWT({ sub: 'user-1', iss: 'https://evil.com' }, TEST_SECRET);
    const key = await importTestKey(config);

    await expect(verifyJWT(token, key, config)).rejects.toThrow('Invalid issuer');
  });

  it('accepts a JWT with the correct issuer', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, issuer: 'https://auth.example.com' };
    const token = await signJWT({ sub: 'user-1', iss: 'https://auth.example.com' }, TEST_SECRET);
    const key = await importTestKey(config);

    const decoded = await verifyJWT(token, key, config);
    expect(decoded['sub']).toBe('user-1');
  });

  it('rejects a JWT with the wrong audience', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, audience: 'weft-api' };
    const token = await signJWT({ sub: 'user-1', aud: 'other-api' }, TEST_SECRET);
    const key = await importTestKey(config);

    await expect(verifyJWT(token, key, config)).rejects.toThrow('Invalid audience');
  });

  it('accepts a JWT with a matching audience in an array', async () => {
    const config: JWTConfig = { secret: TEST_SECRET, audience: 'weft-api' };
    const token = await signJWT({ sub: 'user-1', aud: ['other-api', 'weft-api'] }, TEST_SECRET);
    const key = await importTestKey(config);

    const decoded = await verifyJWT(token, key, config);
    expect(decoded['sub']).toBe('user-1');
  });
});

// ---------------------------------------------------------------------------
// createAuthenticator — API key authentication
// ---------------------------------------------------------------------------

describe('createAuthenticator — API keys', () => {
  it('accepts a valid API key via Authorization Bearer header', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${TEST_API_KEY}`,
      }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('api-key');
    }
  });

  it('accepts a valid API key via X-API-Key header', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        'X-API-Key': TEST_API_KEY,
      }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('api-key');
    }
  });

  it('prefers X-API-Key header over Authorization Bearer', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY, 'other-key'] });

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        'X-API-Key': TEST_API_KEY,
        Authorization: 'Bearer invalid-key',
      }),
    );

    expect(result.authenticated).toBe(true);
  });

  it('rejects an invalid API key', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: 'Bearer wrong-key',
      }),
    );

    expect(result.authenticated).toBe(false);
  });

  it('rejects a request with no credentials', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(makeRequest('http://localhost/v1/workflows'));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toBe('No valid credentials provided');
    }
  });
});

// ---------------------------------------------------------------------------
// createAuthenticator — JWT authentication
// ---------------------------------------------------------------------------

describe('createAuthenticator — JWT', () => {
  it('accepts a valid JWT via Authorization Bearer header', async () => {
    const config: AuthConfig = { jwt: { secret: TEST_SECRET } };
    const authenticate = await createAuthenticator(config);
    const token = await signJWT({ sub: 'user-1' }, TEST_SECRET);

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${token}`,
      }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('jwt');
      expect(result.claims?.['sub']).toBe('user-1');
    }
  });

  it('rejects an expired JWT', async () => {
    const config: AuthConfig = { jwt: { secret: TEST_SECRET, clockTolerance: 0 } };
    const authenticate = await createAuthenticator(config);
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
    const token = await signJWT({ sub: 'user-1', exp: pastExpiry }, TEST_SECRET);

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${token}`,
      }),
    );

    expect(result.authenticated).toBe(false);
  });

  it('rejects a JWT signed with the wrong secret', async () => {
    const config: AuthConfig = { jwt: { secret: TEST_SECRET } };
    const authenticate = await createAuthenticator(config);
    const token = await signJWT({ sub: 'user-1' }, 'completely-different-secret-string!');

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${token}`,
      }),
    );

    expect(result.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAuthenticator — combined methods
// ---------------------------------------------------------------------------

describe('createAuthenticator — combined methods', () => {
  it('accepts an API key when both API key and JWT are configured', async () => {
    const config: AuthConfig = {
      apiKeys: [TEST_API_KEY],
      jwt: { secret: TEST_SECRET },
    };
    const authenticate = await createAuthenticator(config);

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${TEST_API_KEY}`,
      }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('api-key');
    }
  });

  it('falls back to JWT when API key does not match', async () => {
    const config: AuthConfig = {
      apiKeys: [TEST_API_KEY],
      jwt: { secret: TEST_SECRET },
    };
    const authenticate = await createAuthenticator(config);
    const token = await signJWT({ sub: 'user-1' }, TEST_SECRET);

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${token}`,
      }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('jwt');
    }
  });

  it('rejects when all methods fail', async () => {
    const config: AuthConfig = {
      apiKeys: [TEST_API_KEY],
      jwt: { secret: TEST_SECRET },
    };
    const authenticate = await createAuthenticator(config);

    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: 'Bearer wrong-key',
      }),
    );

    expect(result.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAuthenticator — public paths
// ---------------------------------------------------------------------------

describe('createAuthenticator — public paths', () => {
  it('bypasses authentication for /v1/health by default', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(makeRequest('http://localhost/v1/health'));

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('public');
    }
  });

  it('bypasses authentication for /v1/metrics by default', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(makeRequest('http://localhost/v1/metrics'));

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('public');
    }
  });

  it('uses custom public paths when provided', async () => {
    const authenticate = await createAuthenticator({
      apiKeys: [TEST_API_KEY],
      publicPaths: ['/v1/health', '/v1/custom'],
    });

    const healthResult = await authenticate(makeRequest('http://localhost/v1/health'));
    expect(healthResult.authenticated).toBe(true);

    const customResult = await authenticate(makeRequest('http://localhost/v1/custom'));
    expect(customResult.authenticated).toBe(true);

    // /v1/metrics is NOT public when custom paths override default
    const metricsResult = await authenticate(makeRequest('http://localhost/v1/metrics'));
    expect(metricsResult.authenticated).toBe(false);
  });

  it('requires authentication for non-public paths', async () => {
    const authenticate = await createAuthenticator({ apiKeys: [TEST_API_KEY] });

    const result = await authenticate(makeRequest('http://localhost/v1/workflows'));
    expect(result.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAuthenticator — mTLS
// ---------------------------------------------------------------------------

describe('createAuthenticator — mTLS', () => {
  it('authenticates via mTLS when configured (transport-level pass-through)', async () => {
    const authenticate = await createAuthenticator({
      mtls: { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem' },
    });

    // Any request that reaches the handler has already passed TLS verification
    const result = await authenticate(makeRequest('http://localhost/v1/workflows'));

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('mtls');
    }
  });

  it('tries API key and JWT before falling through to mTLS', async () => {
    const authenticate = await createAuthenticator({
      apiKeys: [TEST_API_KEY],
      mtls: { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem' },
    });

    // With a valid API key, the method should be 'api-key', not 'mtls'
    const result = await authenticate(
      makeRequest('http://localhost/v1/workflows', {
        Authorization: `Bearer ${TEST_API_KEY}`,
      }),
    );

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.method).toBe('api-key');
    }
  });
});

// ---------------------------------------------------------------------------
// buildTLSOptions
// ---------------------------------------------------------------------------

describe('buildTLSOptions', () => {
  it('returns undefined when no auth config is provided', () => {
    expect(buildTLSOptions(undefined)).toBeUndefined();
  });

  it('returns undefined when no mTLS is configured', () => {
    expect(buildTLSOptions({ apiKeys: ['key'] })).toBeUndefined();
  });

  it('builds TLS options from mTLS configuration', () => {
    const tls = buildTLSOptions({
      mtls: { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem' },
    });

    expect(tls).toEqual({
      cert: 'cert-pem',
      key: 'key-pem',
      ca: 'ca-pem',
      requestCert: true,
      rejectUnauthorized: true,
    });
  });

  it('respects rejectUnauthorized: false', () => {
    const tls = buildTLSOptions({
      mtls: { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem', rejectUnauthorized: false },
    });

    expect(tls?.rejectUnauthorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serve() integration — authentication wiring
// ---------------------------------------------------------------------------

describe('serve() with authentication', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('allows unauthenticated requests when no auth is configured', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
  });

  it('rejects unauthenticated requests when auth is configured', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const response = await fetch(`${server.url}/v1/workflows`);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('No valid credentials provided');
  });

  it('allows authenticated API key requests', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
  });

  it('allows authenticated JWT requests', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { jwt: { secret: TEST_SECRET } } });

    const token = await signJWT({ sub: 'user-1' }, TEST_SECRET);

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
  });

  it('allows health check without authentication', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const response = await fetch(`${server.url}/v1/health`);

    expect(response.status).toBe(200);
  });

  it('allows metrics endpoint without authentication', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const response = await fetch(`${server.url}/v1/metrics`);

    expect(response.status).toBe(200);
  });

  it('rejects requests with an invalid API key', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const response = await fetch(`${server.url}/v1/workflows`, {
      headers: { Authorization: 'Bearer wrong-key' },
    });

    expect(response.status).toBe(401);
  });

  it('includes WWW-Authenticate header on 401 responses', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const response = await fetch(`${server.url}/v1/workflows`);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('authenticates long-poll task endpoints', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    // Without auth
    const noAuthResponse = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=50`);
    expect(noAuthResponse.status).toBe(401);

    // With auth
    const authResponse = await fetch(`${server.url}/v1/tasks/default?activity=charge&timeout=50`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(authResponse.status).toBe(200);
  });

  it('authenticates task completion endpoints', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    const noAuthResponse = await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'op-1', status: 'completed', value: 42 }),
    });
    expect(noAuthResponse.status).toBe(401);

    const authResponse = await fetch(`${server.url}/v1/tasks/default/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ operationId: 'op-1', status: 'completed', value: 42 }),
    });
    expect(authResponse.status).toBe(200);
  });

  it('throws on invalid auth configuration', () => {
    engine = createEngine();
    expect(() => serve({ engine, port: 0, auth: {} })).toThrow(
      'at least one authentication method',
    );
  });
});
