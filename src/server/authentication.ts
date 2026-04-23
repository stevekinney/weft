/**
 * Authentication middleware for the Weft HTTP server.
 *
 * Supports three authentication methods, all optional and configurable:
 * - **API keys**: validated via `Authorization: Bearer <key>` or `X-API-Key` header
 * - **JWT**: HMAC or RSA/ECDSA signature verification with claims validation
 * - **mTLS**: mutual TLS at the transport layer (configured via Bun.serve tls options)
 *
 * @module server/authentication
 */

import type { AuthorizationScope } from './authorization-scope.ts';
import { principalFromApiKey, type AuthenticatedPrincipal } from './principal.ts';

// ---------------------------------------------------------------------------
// JWT algorithm types
// ---------------------------------------------------------------------------

type HMACAlgorithm = 'HS256' | 'HS384' | 'HS512';
type RSAAlgorithm = 'RS256' | 'RS384' | 'RS512';
type ECDSAAlgorithm = 'ES256' | 'ES384' | 'ES512';

export type JWTAlgorithm = HMACAlgorithm | RSAAlgorithm | ECDSAAlgorithm;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export type JWTConfig = {
  /** HMAC secret for HS256/HS384/HS512 algorithms. */
  secret?: string;
  /** PEM-encoded public key for RS* or ES* algorithms. */
  publicKey?: string;
  /** Signing algorithm (default: HS256). */
  algorithm?: JWTAlgorithm;
  /** Expected `iss` claim. Rejected if present and mismatched. */
  issuer?: string;
  /** Expected `aud` claim. Rejected if present and mismatched. */
  audience?: string;
  /** Seconds of clock skew tolerance for `exp` and `nbf` checks (default: 60). */
  clockTolerance?: number;
};

export type MTLSConfig = {
  /** PEM-encoded CA certificate(s) for client certificate verification. */
  ca: string | string[];
  /** PEM-encoded server certificate. */
  cert: string;
  /** PEM-encoded server private key. */
  key: string;
  /** Reject connections without a valid client certificate (default: true). */
  rejectUnauthorized?: boolean;
};

export type AuthConfig = {
  /** Allowed API keys. Checked against `Authorization: Bearer <key>` and `X-API-Key` headers. */
  apiKeys?: string[];
  /** JWT verification configuration. */
  jwt?: JWTConfig;
  /** Mutual TLS configuration. Passed through to Bun.serve's `tls` option. */
  mtls?: MTLSConfig;
  /** Paths that bypass authentication. Defaults to `['/v1/health', '/v1/metrics']`. */
  publicPaths?: string[];
  /**
   * Optional resolver that maps a presented API key to a fully-shaped
   * `AuthenticatedPrincipal`. When configured, the resolver is
   * authoritative for the entire API-key space:
   *   - returns a principal → admitted with that principal entirely
   *     (scopes authoritative; `defaultApiKeyScopes` IGNORED).
   *   - returns `null` → key rejected; static `apiKeys` is NOT
   *     consulted as a fallback.
   *   - throws → treated as `null` (rejected); server log records the
   *     throw detail, wire error stays generic.
   * When not configured, static `apiKeys` admits and the admitted
   * principal's scopes come from `defaultApiKeyScopes ?? []`.
   */
  resolveApiKeyPrincipal?: (key: string) => Promise<AuthenticatedPrincipal | null>;
  /**
   * Scopes granted to principals admitted via static `apiKeys`. Ignored
   * when `resolveApiKeyPrincipal` is configured (the resolver's scopes
   * are authoritative for keys it admits). Defaults to `[]`.
   */
  defaultApiKeyScopes?: ReadonlyArray<AuthorizationScope>;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type AuthMethod = 'api-key' | 'jwt' | 'mtls' | 'public';

/**
 * Shared context carried from the authenticator through the request
 * pipeline. Single source of truth for the `{ method, claims?,
 * principal? }` shape — re-used by `AuthResult`,
 * `HandlerOptions.authContext`, and the handler's internal
 * `AuthenticatedRequestContext`.
 *
 *   - `method`: which admission path succeeded.
 *   - `claims`: JWT payload when `method === 'jwt'`.
 *   - `principal`: fully-shaped principal forwarded from the
 *     authenticator (resolver admission, or static API-key admission
 *     with `defaultApiKeyScopes`). Downstream pipeline code uses this
 *     verbatim; when absent, `authContextToPrincipal` reconstructs a
 *     minimal principal from `method` + `claims`.
 */
export type AuthContext = {
  method: AuthMethod;
  claims?: JWTPayload;
  principal?: AuthenticatedPrincipal;
};

export type AuthResult =
  | ({ authenticated: true } & AuthContext)
  | { authenticated: false; error: string };

export type JWTPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Authenticator function type
// ---------------------------------------------------------------------------

export type Authenticator = (request: Request) => Promise<AuthResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PUBLIC_PATHS = ['/v1/health', '/v1/metrics'];
const DEFAULT_CLOCK_TOLERANCE = 60;

// ---------------------------------------------------------------------------
// JWT algorithm → Web Crypto parameters
// ---------------------------------------------------------------------------

const HMAC_IMPORT_PARAMS: Record<HMACAlgorithm, HmacImportParams> = {
  HS256: { name: 'HMAC', hash: 'SHA-256' },
  HS384: { name: 'HMAC', hash: 'SHA-384' },
  HS512: { name: 'HMAC', hash: 'SHA-512' },
};

const RSA_IMPORT_PARAMS: Record<RSAAlgorithm, RsaHashedImportParams> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
};

const ECDSA_IMPORT_PARAMS: Record<ECDSAAlgorithm, EcKeyImportParams> = {
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
  ES384: { name: 'ECDSA', namedCurve: 'P-384' },
  ES512: { name: 'ECDSA', namedCurve: 'P-521' },
};

function getImportParams(
  algorithm: JWTAlgorithm,
): HmacImportParams | RsaHashedImportParams | EcKeyImportParams {
  if (algorithm in HMAC_IMPORT_PARAMS) return HMAC_IMPORT_PARAMS[algorithm as HMACAlgorithm];
  if (algorithm in RSA_IMPORT_PARAMS) return RSA_IMPORT_PARAMS[algorithm as RSAAlgorithm];
  return ECDSA_IMPORT_PARAMS[algorithm as ECDSAAlgorithm];
}

function getVerifyParams(algorithm: JWTAlgorithm): AlgorithmIdentifier | EcdsaParams {
  if (algorithm.startsWith('ES')) {
    return { name: 'ECDSA', hash: `SHA-${algorithm.slice(2)}` };
  }
  return getImportParams(algorithm);
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

/**
 * Encode a string to an `ArrayBuffer` for use with Web Crypto APIs.
 *
 * `TextEncoder.encode().buffer` is typed as `ArrayBufferLike` (which includes
 * `SharedArrayBuffer`), but `crypto.subtle` expects `BufferSource`. Copying
 * into a fresh `ArrayBuffer` gives a properly typed result without needing
 * a type assertion that conflicts between tsc and oxlint.
 */
function textToBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

/** Decode a binary string (from `atob`) into a fresh `ArrayBuffer`. */
function binaryStringToBuffer(binary: string): ArrayBuffer {
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64UrlDecode(input: string): ArrayBuffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return binaryStringToBuffer(atob(padded));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// PEM parsing
// ---------------------------------------------------------------------------

function parsePEM(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  return binaryStringToBuffer(atob(base64));
}

// ---------------------------------------------------------------------------
// JWT key import
// ---------------------------------------------------------------------------

/** Import a CryptoKey from JWT configuration for signature verification. */
export async function importJWTKey(config: JWTConfig): Promise<CryptoKey> {
  const algorithm = config.algorithm ?? 'HS256';
  const params = getImportParams(algorithm);

  if (algorithm.startsWith('HS')) {
    if (!config.secret) {
      throw new Error('JWT configuration requires "secret" for HMAC algorithms');
    }
    return crypto.subtle.importKey('raw', textToBuffer(config.secret), params, false, ['verify']);
  }

  if (!config.publicKey) {
    throw new Error('JWT configuration requires "publicKey" for RSA/ECDSA algorithms');
  }
  return crypto.subtle.importKey('spki', parsePEM(config.publicKey), params, false, ['verify']);
}

// ---------------------------------------------------------------------------
// JWT signing (exported for tests only — not used in production)
// ---------------------------------------------------------------------------

/** Sign a JWT payload. Primarily for testing. */
export async function signJWT(
  payload: JWTPayload,
  secret: string,
  algorithm: JWTAlgorithm = 'HS256',
): Promise<string> {
  const header = { alg: algorithm, typ: 'JWT' };
  const headerB64 = base64UrlEncode(textToBuffer(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(textToBuffer(JSON.stringify(payload)));
  const signingInput = textToBuffer(`${headerB64}.${payloadB64}`);

  const params = getImportParams(algorithm);
  const key = await crypto.subtle.importKey('raw', textToBuffer(secret), params, false, ['sign']);

  const signature = await crypto.subtle.sign(params, key, signingInput);
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

/** Verify a JWT token and return its decoded payload. */
export async function verifyJWT(
  token: string,
  key: CryptoKey,
  config: JWTConfig,
): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // Decode and validate header
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as {
    alg?: string;
    typ?: string;
  };
  const expectedAlgorithm = config.algorithm ?? 'HS256';

  if (header.alg !== expectedAlgorithm) {
    throw new Error(`Algorithm mismatch: expected ${expectedAlgorithm}, got ${header.alg}`);
  }

  // Verify signature
  const signingInput = textToBuffer(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const verifyParams = getVerifyParams(expectedAlgorithm);

  const valid = await crypto.subtle.verify(verifyParams, key, signature, signingInput);
  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  // Decode payload
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JWTPayload;

  // Validate temporal claims
  const now = Math.floor(Date.now() / 1000);
  const tolerance = config.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;

  if (typeof payload['exp'] === 'number' && now > payload['exp'] + tolerance) {
    throw new Error('JWT expired');
  }

  if (typeof payload['nbf'] === 'number' && now < payload['nbf'] - tolerance) {
    throw new Error('JWT not yet valid');
  }

  // Validate issuer
  if (config.issuer !== undefined && payload['iss'] !== config.issuer) {
    throw new Error(`Invalid issuer: expected "${config.issuer}", got "${String(payload['iss'])}"`);
  }

  // Validate audience
  if (config.audience !== undefined) {
    const aud = Array.isArray(payload['aud']) ? payload['aud'] : [payload['aud']];
    if (!aud.includes(config.audience)) {
      throw new Error(`Invalid audience: expected "${config.audience}"`);
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  return null;
}

function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get('X-API-Key');
  if (headerKey) return headerKey;
  return extractBearerToken(request);
}

/**
 * Method-mismatch guard. A resolver can return a principal with any
 * `method` string; admitting under `method: 'api-key'` while the
 * principal declares `method: 'jwt'` creates contradictory auth state.
 * Returns `true` when the principal passes (method === 'api-key');
 * logs + returns `false` otherwise. Separated from `deepFreezeApiKeyPrincipal`
 * so each function has one responsibility — guard or copy/freeze.
 */
function validateApiKeyPrincipalMethod(principal: AuthenticatedPrincipal): boolean {
  if (principal.method !== 'api-key') {
    console.warn(
      `resolveApiKeyPrincipal returned principal with method "${principal.method}"; expected "api-key". Rejecting.`,
    );
    return false;
  }
  return true;
}

/**
 * Throws when a guarded scope set sees a mutation attempt. Named at
 * module scope so the function is allocated once, not per-set.
 */
function rejectScopeSetMutation(name: string): () => never {
  return () => {
    throw new TypeError(`Cannot mutate scope set on admitted principal (attempted ${name})`);
  };
}

/**
 * Wrap a scope set so mutation attempts THROW at call time.
 * `Object.freeze(new Set(...))` only freezes the wrapper object —
 * `.add`, `.delete`, `.clear` from `Set.prototype` still mutate the
 * contents. This returns a new frozen object that implements the
 * `ReadonlySet` read contract (`has`, `size`, iterators) by
 * delegating to an internal set, while rejecting mutation calls with
 * a `TypeError` so leaks into admitted auth state fail loudly.
 *
 * Implementation note: Set's internal-slot methods (e.g., `size`
 * getter, `has`) cannot be safely called through a Proxy because they
 * require the Set brand check against `this`. We build a plain object
 * that delegates reads to the bound methods of the internal set — no
 * branded-slot surprises. The final cast to `ReadonlySet` is
 * structurally safe: the object exposes every member the `ReadonlySet`
 * interface requires and rejects the mutating methods at call time.
 */
function immutableScopeSet(
  source: ReadonlySet<AuthorizationScope>,
): ReadonlySet<AuthorizationScope> {
  const inner = new Set<AuthorizationScope>(source);
  const guarded = {
    has: (scope: AuthorizationScope) => inner.has(scope),
    get size() {
      return inner.size;
    },
    forEach: (
      callback: (
        value: AuthorizationScope,
        value2: AuthorizationScope,
        set: ReadonlySet<AuthorizationScope>,
      ) => void,
      thisArg?: unknown,
    ) =>
      inner.forEach((v, v2) =>
        callback.call(thisArg, v, v2, guarded as unknown as ReadonlySet<AuthorizationScope>),
      ),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    // Mutation surface — exposed only so downstream leaks hit a loud
    // error rather than silently succeeding against an unfrozen Set.
    add: rejectScopeSetMutation('add'),
    delete: rejectScopeSetMutation('delete'),
    clear: rejectScopeSetMutation('clear'),
  };
  return Object.freeze(guarded) as unknown as ReadonlySet<AuthorizationScope>;
}

/**
 * Deep-clone an optional JWT claims object so the admitted principal
 * retains an independent copy. API-key principals rarely carry claims
 * (JWT is a separate method), but a resolver may populate them for
 * auditing — `structuredClone` gives a correct deep copy for any
 * JSON-serializable shape without dragging in a third-party dep.
 * Returns `undefined` when no claims are attached.
 */
function cloneClaims(claims: JWTPayload | undefined): JWTPayload | undefined {
  if (claims === undefined) return undefined;
  return structuredClone(claims);
}

/**
 * Deep-freeze an API-key principal for admission. Returns a new
 * principal whose scope set throws on mutation attempts, whose
 * `hasScope` delegates to the guarded set, whose `claims` is a
 * structured clone (so caller-side mutations don't leak), and whose
 * outer object is `Object.freeze`d. Caller mutations on the original
 * principal cannot leak into the returned principal, and downstream
 * code attempting to mutate the admitted principal fails loudly.
 *
 * Preconditions: caller must have already run
 * `validateApiKeyPrincipalMethod(principal) === true`.
 */
function deepFreezeApiKeyPrincipal(principal: AuthenticatedPrincipal): AuthenticatedPrincipal {
  const guardedScopes = immutableScopeSet(principal.scopes);
  const frozen: AuthenticatedPrincipal = {
    method: 'api-key',
    scopes: guardedScopes,
    claims: cloneClaims(principal.claims),
    tenantId: principal.tenantId,
    subject: principal.subject,
    hasScope(scope) {
      return guardedScopes.has(scope);
    },
  };
  return Object.freeze(frozen);
}

// ---------------------------------------------------------------------------
// Authenticator factory
// ---------------------------------------------------------------------------

/**
 * Validate an `AuthConfig` eagerly, throwing on invalid combinations.
 * Called synchronously in `serve()` so misconfigurations fail fast.
 */
export function validateAuthConfig(config: AuthConfig): void {
  if (config.jwt) {
    const algorithm = config.jwt.algorithm ?? 'HS256';
    if (algorithm.startsWith('HS') && !config.jwt.secret) {
      throw new Error('JWT configuration requires "secret" for HMAC algorithms');
    }
    if ((algorithm.startsWith('RS') || algorithm.startsWith('ES')) && !config.jwt.publicKey) {
      throw new Error('JWT configuration requires "publicKey" for RSA/ECDSA algorithms');
    }
  }

  const hasMethod =
    (config.apiKeys && config.apiKeys.length > 0) ||
    config.jwt !== undefined ||
    config.mtls !== undefined ||
    config.resolveApiKeyPrincipal !== undefined;
  if (!hasMethod) {
    throw new Error(
      'AuthConfig must specify at least one authentication method ' +
        '(apiKeys, resolveApiKeyPrincipal, jwt, or mtls)',
    );
  }
}

/**
 * Create an authenticator function from an auth configuration.
 *
 * The returned function checks each configured method in order:
 * 1. Public path bypass
 * 2. API key (O(1) set lookup)
 * 3. JWT (signature + claims verification)
 * 4. mTLS (transport-level — any request that reaches the handler is authenticated)
 */
export async function createAuthenticator(config: AuthConfig): Promise<Authenticator> {
  validateAuthConfig(config);

  const apiKeySet = config.apiKeys?.length ? new Set(config.apiKeys) : null;
  const resolver = config.resolveApiKeyPrincipal;
  const defaultApiKeyScopes = config.defaultApiKeyScopes ?? [];
  const jwtKey = config.jwt ? await importJWTKey(config.jwt) : null;
  const publicPaths = new Set(config.publicPaths ?? DEFAULT_PUBLIC_PATHS);

  return async (request: Request): Promise<AuthResult> => {
    const url = new URL(request.url);
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (publicPaths.has(pathname)) {
      return { authenticated: true, method: 'public' };
    }

    // Track whether the request explicitly provided credentials.
    // If credentials were provided but invalid, do not fall through to mTLS.
    let explicitAuthAttempted = false;

    // API-key admission precedence (single ordered rule per Track 8 plan):
    //   1. resolver configured + returns principal → use that principal.
    //   2. resolver configured + returns null/throws → rejected. Terminal:
    //      do NOT fall through to static apiKeys or to JWT (the same
    //      Bearer token the resolver refused must not be re-tried as a
    //      JWT — that would let a rejected token get admitted by a
    //      different code path).
    //   3. resolver absent → static apiKeys admits; scopes = defaultApiKeyScopes.
    //      If the key is not in the static set, fall through to the JWT
    //      block so Bearer JWT tokens (which look like api keys to
    //      extractApiKey but are actually JWTs) can be verified there.
    const presentedKey = extractApiKey(request);
    if (presentedKey) {
      explicitAuthAttempted = true;
      if (resolver !== undefined) {
        let resolved: AuthenticatedPrincipal | null;
        try {
          resolved = await resolver(presentedKey);
        } catch (error) {
          // Resolver throw: log server-side, reject client. Never leak the
          // thrown error's message to the wire — it may contain DB queries,
          // secrets, or other sensitive context.
          console.warn(
            'resolveApiKeyPrincipal threw:',
            error instanceof Error ? error.message : error,
          );
          resolved = null;
        }
        if (resolved !== null && validateApiKeyPrincipalMethod(resolved)) {
          const admitted = deepFreezeApiKeyPrincipal(resolved);
          return { authenticated: true, method: 'api-key', principal: admitted };
        }
        // Resolver returned null, threw, or produced a method-mismatched
        // principal. Fall through to the terminal rejection below — must
        // NOT admit under a contradictory method claim or consult static
        // apiKeys as a fallback (the resolver is authoritative).
        // Resolver said no (or returned an invalid-shape principal):
        // terminal. Neither static apiKeys nor JWT verification may
        // admit this request — the resolver is authoritative for any
        // key space it is configured for.
        return { authenticated: false, error: 'No valid credentials provided' };
      } else if (apiKeySet?.has(presentedKey)) {
        // Apply the same guard as the resolver path to keep the
        // method-check invariant symmetric across admission paths.
        // `principalFromApiKey` is guaranteed to return method:'api-key'
        // today, but running the check catches future changes to the
        // factory that would otherwise silently skip validation.
        const principal = principalFromApiKey({
          subject: 'api-key-caller',
          scopes: defaultApiKeyScopes,
        });
        if (validateApiKeyPrincipalMethod(principal)) {
          const admitted = deepFreezeApiKeyPrincipal(principal);
          return { authenticated: true, method: 'api-key', principal: admitted };
        }
        // Unreachable today — see the comment above. Keeping the
        // explicit rejection keeps the invariant loud if the factory
        // ever produces a non-api-key principal.
        return { authenticated: false, error: 'No valid credentials provided' };
      }
    }

    // Try JWT verification on Bearer tokens that look like JWTs (contain dots).
    // Any Bearer token counts as an explicit auth attempt — even non-JWT tokens —
    // to prevent falling through to mTLS with invalid credentials.
    if (jwtKey && config.jwt) {
      const token = extractBearerToken(request);
      if (token) {
        explicitAuthAttempted = true;
        if (token.includes('.')) {
          try {
            const claims = await verifyJWT(token, jwtKey, config.jwt);
            return { authenticated: true, method: 'jwt', claims };
          } catch (error) {
            console.warn(
              'JWT verification failed:',
              error instanceof Error ? error.message : error,
            );
            // JWT verification failed — fall through to next method
          }
        }
      }
    }

    // mTLS: if configured, the TLS layer already verified the client certificate.
    // Only use mTLS as fallback if no explicit credentials were provided.
    // A request with invalid API key or JWT should fail, not silently succeed via mTLS.
    if (config.mtls && !explicitAuthAttempted) {
      return { authenticated: true, method: 'mtls' };
    }

    return { authenticated: false, error: 'No valid credentials provided' };
  };
}

/**
 * Build Bun.serve-compatible TLS options from an mTLS configuration.
 * Returns `undefined` when no mTLS is configured.
 */
export function buildTLSOptions(config: AuthConfig | undefined):
  | {
      cert: string;
      key: string;
      ca: string | string[];
      requestCert: boolean;
      rejectUnauthorized: boolean;
    }
  | undefined {
  if (!config?.mtls) return undefined;

  return {
    cert: config.mtls.cert,
    key: config.mtls.key,
    ca: config.mtls.ca,
    requestCert: true,
    rejectUnauthorized: config.mtls.rejectUnauthorized ?? true,
  };
}
