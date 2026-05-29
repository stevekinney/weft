import type { AuthorizationScope } from '../authorization-scope.ts';
import type { AuthenticatedPrincipal } from '../principal.ts';
import type { AuthAuditSink } from './audit.ts';

// ---------------------------------------------------------------------------
// JWT algorithm types
// ---------------------------------------------------------------------------

type HMACAlgorithm = 'HS256' | 'HS384' | 'HS512';
type RSAAlgorithm = 'RS256' | 'RS384' | 'RS512';
type ECDSAAlgorithm = 'ES256' | 'ES384' | 'ES512';

/**
 * JWT signing algorithm supported by {@link JWTConfig}.
 *
 * HMAC variants (`HS256`, `HS384`, `HS512`) use a shared secret; RSA variants
 * (`RS256`, `RS384`, `RS512`) and ECDSA variants (`ES256`, `ES384`, `ES512`) use
 * asymmetric keys configured via `publicKey` in the {@link JWTConfig}.
 *
 * @example
 * ```ts
 * import { type JWTAlgorithm, type JWTConfig } from 'weft';
 *
 * const algorithm: JWTAlgorithm = 'RS256';
 * const config: JWTConfig = {
 *   algorithm,
 *   publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
 *   issuer: 'https://auth.example.com',
 * };
 * void config;
 * ```
 */
export type JWTAlgorithm = HMACAlgorithm | RSAAlgorithm | ECDSAAlgorithm;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Configuration for JWT signature verification in the Weft HTTP server.
 *
 * Supply either `secret` (for HMAC algorithms) or `publicKey` (for RSA/ECDSA).
 * Optional `issuer`, `audience`, and `clockTolerance` fields guard against
 * token reuse and clock-skew rejection.
 *
 * @example
 * ```ts
 * import { type JWTConfig } from 'weft';
 *
 * const jwtConfig: JWTConfig = {
 *   secret: process.env['JWT_SECRET'] ?? '',
 *   algorithm: 'HS256',
 *   issuer: 'https://auth.example.com',
 *   audience: 'weft-api',
 *   clockTolerance: 30,
 * };
 * void jwtConfig;
 * ```
 */
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

/**
 * Mutual TLS configuration passed through to `Bun.serve`'s `tls` option.
 *
 * When present in an {@link AuthConfig}, the server requires every client to
 * present a valid certificate signed by the configured CA.  Requests that reach
 * the application handler are already authenticated at the transport layer.
 *
 * @example
 * ```ts
 * import { type MTLSConfig } from 'weft';
 * import { readFileSync } from 'node:fs';
 *
 * const mtlsConfig: MTLSConfig = {
 *   ca: readFileSync('./certs/ca.pem', 'utf8'),
 *   cert: readFileSync('./certs/server.crt', 'utf8'),
 *   key: readFileSync('./certs/server.key', 'utf8'),
 *   rejectUnauthorized: true,
 * };
 * void mtlsConfig;
 * ```
 */
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

/**
 * Top-level authentication configuration for {@link serve}.
 *
 * At least one of `apiKeys`, `resolveApiKeyPrincipal`, `jwt`, or `mtls` must be
 * present — the server rejects the config at startup otherwise.  Paths listed in
 * `publicPaths` bypass all authentication (default: health, metrics, and
 * discovery document endpoints).
 *
 * @example
 * ```ts
 * import { type AuthConfig } from 'weft';
 *
 * const auth: AuthConfig = {
 *   apiKeys: [process.env['API_KEY'] ?? ''],
 *   jwt: {
 *     secret: process.env['JWT_SECRET'] ?? '',
 *     issuer: 'https://auth.example.com',
 *   },
 *   publicPaths: ['/v1/health', '/openapi.json'],
 * };
 * void auth;
 * ```
 */
export type AuthConfig = {
  /** Allowed API keys. Checked against `Authorization: Bearer <key>` and `X-API-Key` headers. */
  apiKeys?: string[];
  /** JWT verification configuration. */
  jwt?: JWTConfig;
  /** Mutual TLS configuration. Passed through to Bun.serve's `tls` option. */
  mtls?: MTLSConfig;
  /**
   * Paths that bypass authentication. Defaults to
   * `['/v1/health', '/v1/metrics', '/.well-known/api-catalog', '/.well-known/mcp.json', '/openapi.json', '/openrpc.json', '/asyncapi.json']`.
   */
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
  /**
   * Sink for the authentication audit trail. The authenticator emits one
   * structured {@link AuthAuditSink} event per non-public decision (admission
   * or rejection), carrying the authenticated subject, method, and outcome —
   * never the presented credential. Public-path bypasses are not audited.
   * Defaults to a sink that writes one JSON line per event to the console
   * (`console.info` for success, `console.warn` for failure). Set to a custom
   * sink to forward audit records to a SIEM, or to a no-op to disable auditing.
   */
  auditSink?: AuthAuditSink;
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Which authentication path admitted a request.
 *
 * Returned inside an {@link AuthResult} when `authenticated: true`.  Use this
 * to distinguish bearer-token callers from mTLS-authenticated services or to
 * log the admission method alongside the request trace.
 *
 * @example
 * ```ts
 * import { createAuthenticator, type AuthMethod } from 'weft';
 *
 * const authenticate = await createAuthenticator({ apiKeys: ['key-1'] });
 * const req = new Request('http://localhost/v1/workflows', {
 *   headers: { 'X-API-Key': 'key-1' },
 * });
 * const result = await authenticate(req);
 * if (result.authenticated) {
 *   const method: AuthMethod = result.method;
 *   console.log(method); // 'api-key'
 * }
 * ```
 */
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

/**
 * Discriminated union returned by an {@link Authenticator}.
 *
 * Check `authenticated` first: when `true`, the request was admitted and
 * `method` (plus optional `claims` / `principal`) are populated.  When
 * `false`, `error` holds a client-safe rejection message.
 *
 * @example
 * ```ts
 * import { createAuthenticator, type AuthResult } from 'weft';
 *
 * const authenticate = await createAuthenticator({ apiKeys: ['s3cr3t'] });
 * const req = new Request('http://localhost/v1/workflows');
 * const result: AuthResult = await authenticate(req);
 * if (!result.authenticated) {
 *   console.error('Rejected:', result.error);
 * } else {
 *   console.log('Admitted via', result.method);
 * }
 * ```
 */
export type AuthResult =
  | ({ authenticated: true } & AuthContext)
  | { authenticated: false; error: string };

/**
 * Decoded JWT claims payload — the JSON object between the JWT header and
 * signature after base64url-decoding.
 *
 * Populated on an {@link AuthResult} when `method === 'jwt'`.  Standard claims
 * (`iss`, `sub`, `aud`, `exp`, `nbf`) are validated automatically; any
 * application-specific claims are accessible as `claims['my-claim']`.
 *
 * @example
 * ```ts
 * import { createAuthenticator, type JWTPayload } from 'weft';
 *
 * const authenticate = await createAuthenticator({
 *   jwt: { secret: 'test-secret' },
 * });
 * const req = new Request('http://localhost/v1/workflows', {
 *   headers: { Authorization: 'Bearer <token>' },
 * });
 * const result = await authenticate(req);
 * if (result.authenticated && result.method === 'jwt') {
 *   const payload: JWTPayload = result.claims ?? {};
 *   console.log(payload['sub']);
 * }
 * ```
 */
export type JWTPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Authenticator function type
// ---------------------------------------------------------------------------

/**
 * Async function that inspects a `Request` and returns an {@link AuthResult}.
 *
 * Obtain an `Authenticator` by calling `createAuthenticator(config)`.  You can
 * also implement this type directly to plug a custom admission strategy into the
 * server handler pipeline.
 *
 * @example
 * ```ts
 * import { createAuthenticator, type Authenticator } from 'weft';
 *
 * const authenticate: Authenticator = await createAuthenticator({
 *   apiKeys: ['my-key'],
 * });
 *
 * const request = new Request('http://localhost/v1/workflows', {
 *   headers: { 'X-API-Key': 'my-key' },
 * });
 * const result = await authenticate(request);
 * console.log(result.authenticated); // true
 * ```
 */
export type Authenticator = (request: Request) => Promise<AuthResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PUBLIC_PATHS = [
  '/v1/health',
  '/v1/metrics',
  '/.well-known/api-catalog',
  '/.well-known/mcp.json',
  '/openapi.json',
  '/openrpc.json',
  '/asyncapi.json',
];
export const DEFAULT_CLOCK_TOLERANCE = 60;
