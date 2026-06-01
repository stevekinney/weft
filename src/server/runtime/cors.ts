/**
 * Cross-Origin Resource Sharing (CORS) for the Weft server.
 *
 * The server hosts a browser dashboard (`/ui`) and a documented browser
 * runtime (Service Worker + IndexedDB). When those run on a different origin
 * than the API, the browser enforces CORS — and with no policy configured it
 * blocks every cross-origin call. This module supplies an opt-in, **safe by
 * default** policy: when `serve()` is called without a `cors` option, the
 * server emits no `Access-Control-*` headers at all (same-origin only). It
 * never defaults to `Access-Control-Allow-Origin: *`.
 *
 * Three pieces wire into the request pipeline:
 *   - {@link buildPreflightResponse} answers `OPTIONS` preflight requests
 *     before authentication runs (browsers never send credentials on
 *     preflight, so auth-gating it would break CORS).
 *   - {@link decorateResponseWithCors} adds the response headers for actual
 *     (non-preflight) requests.
 *   - {@link isOriginAllowed} gates WebSocket upgrades, which CORS does not
 *     otherwise protect.
 *
 * Origins are compared as canonical origin tuples (`scheme://host[:port]`)
 * via the URL parser, so case, default-port elision, and trailing slashes do
 * not cause spurious mismatches. The literal `Origin: null` (sandboxed iframe,
 * `file://`) never matches an allowlist entry.
 *
 * @module server/runtime/cors
 */

/**
 * Operator-supplied CORS policy. Attach to `serve({ cors })`. Omitting it is
 * the safe default — the server emits no `Access-Control-*` headers and only
 * same-origin browser requests succeed; it never defaults to a wildcard origin.
 *
 * @example
 * ```ts
 * import { serve, type CorsOptions } from '@lostgradient/weft/server';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * const cors: CorsOptions = {
 *   allowedOrigins: ['https://dashboard.example.com'],
 *   credentials: true,
 * };
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * await using server = serve({ engine, port: 0, cors });
 * void server;
 * ```
 */
export interface CorsOptions {
  /**
   * Origins permitted to make cross-origin requests. Either an explicit
   * allowlist (compared as canonical origins) or a predicate that receives
   * the raw `Origin` header value. The single-element sentinel `['*']` means
   * "any origin" and is only legal when `credentials` is not `true`.
   *
   * Omitting this (or an empty array) allows no cross-origin requests.
   *
   * Note: the array form canonicalizes both the allowlist and the incoming
   * origin (so case, default-port elision, and trailing slashes do not matter).
   * The predicate form receives the **raw** `Origin` header value with no
   * canonicalization — apply `canonicalizeOrigin` yourself if you need the same
   * normalization for case-insensitive or default-port comparisons.
   */
  readonly allowedOrigins?: ReadonlyArray<string> | ((origin: string) => boolean);
  /** Methods advertised in preflight responses. Defaults to the common verbs plus `OPTIONS`. */
  readonly allowedMethods?: ReadonlyArray<string>;
  /** Request headers a client may send. Defaults to `Authorization, Content-Type`. */
  readonly allowedHeaders?: ReadonlyArray<string>;
  /** Response headers exposed to client scripts via `Access-Control-Expose-Headers`. */
  readonly exposedHeaders?: ReadonlyArray<string>;
  /** Whether credentialed requests are allowed. When `true`, the origin is never wildcarded. */
  readonly credentials?: boolean;
  /** Preflight cache lifetime in seconds (`Access-Control-Max-Age`). Defaults to 600. */
  readonly maxAgeSeconds?: number;
}

const DEFAULT_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const DEFAULT_ALLOWED_HEADERS = ['Authorization', 'Content-Type'] as const;
const DEFAULT_MAX_AGE_SECONDS = 600;
const WILDCARD_ORIGIN = '*';

/**
 * A CorsOptions normalized into the exact strings the response builders emit,
 * so the per-request hot path does no defaulting or array joining.
 */
export type ResolvedCorsPolicy = {
  readonly matchOrigin: (origin: string) => boolean;
  readonly allowsAnyOrigin: boolean;
  /** Pre-joined `Access-Control-Allow-Methods` value emitted in preflight responses. */
  readonly allowedMethodsHeader: string;
  /** Uppercased method names, for O(1) validation of the preflight's requested method. */
  readonly allowedMethodSet: ReadonlySet<string>;
  /** Pre-joined `Access-Control-Allow-Headers` value emitted in preflight responses. */
  readonly allowedHeadersHeader: string;
  /** Lowercased header names, for O(1) validation of the preflight's requested headers. */
  readonly allowedHeaderSet: ReadonlySet<string>;
  readonly exposedHeadersHeader: string | null;
  readonly credentials: boolean;
  readonly maxAgeSeconds: number;
};

/**
 * Canonicalize an origin string to its `scheme://host[:port]` tuple. Returns
 * `null` for the literal `"null"`, empty input, or anything the URL parser
 * rejects — those must never match an allowlist entry. Default ports are
 * elided by the URL parser, so `https://x:443` and `https://x` compare equal.
 */
export function canonicalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    // `URL.origin` is already lowercased on host and elides default ports. A
    // non-special scheme (no authority) yields the string "null" — reject it.
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** Build the origin-matching predicate from the configured allowlist. */
function buildOriginMatcher(allowedOrigins: CorsOptions['allowedOrigins']): {
  match: (origin: string) => boolean;
  allowsAny: boolean;
} {
  if (typeof allowedOrigins === 'function') {
    return { match: allowedOrigins, allowsAny: false };
  }
  const list = allowedOrigins ?? [];
  if (list.length === 1 && list[0] === WILDCARD_ORIGIN) {
    return { match: () => true, allowsAny: true };
  }
  // Pre-canonicalize the allowlist once. A non-canonicalizable entry simply
  // never matches (it is dropped from the set), which fails closed.
  const canonical = new Set<string>();
  for (const entry of list) {
    const normalized = canonicalizeOrigin(entry);
    if (normalized !== null) {
      canonical.add(normalized);
    }
  }
  return {
    match: (origin) => {
      const normalized = canonicalizeOrigin(origin);
      return normalized !== null && canonical.has(normalized);
    },
    allowsAny: false,
  };
}

/**
 * Resolve a `CorsOptions` (already validated by {@link validateCorsOptions})
 * into the precomputed policy used per request. When `auth` is configured the
 * caller passes `requireAuthorizationHeader: true` so `Authorization` is
 * always advertised in `Access-Control-Allow-Headers`.
 */
export function resolveCorsPolicy(
  options: CorsOptions,
  requireAuthorizationHeader = false,
): ResolvedCorsPolicy {
  const { match, allowsAny } = buildOriginMatcher(options.allowedOrigins);
  const methods = options.allowedMethods ?? DEFAULT_ALLOWED_METHODS;

  const headerList = [...(options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS)];
  if (
    requireAuthorizationHeader &&
    !headerList.some((header) => header.toLowerCase() === 'authorization')
  ) {
    headerList.push('Authorization');
  }
  // CORS header and method names are case-insensitive per the Fetch spec, so
  // the lookup sets normalize case once here and compare normalized at request
  // time. Headers lowercase, methods uppercase (their conventional forms).
  const allowedHeaderSet = new Set(headerList.map((header) => header.toLowerCase()));
  const allowedMethodSet = new Set(methods.map((method) => method.toUpperCase()));

  const exposed = options.exposedHeaders ?? [];

  return {
    matchOrigin: match,
    allowsAnyOrigin: allowsAny,
    allowedMethodsHeader: methods.join(', '),
    allowedMethodSet,
    allowedHeadersHeader: headerList.join(', '),
    allowedHeaderSet,
    exposedHeadersHeader: exposed.length > 0 ? exposed.join(', ') : null,
    credentials: options.credentials === true,
    maxAgeSeconds: options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
  };
}

/**
 * Whether a request's `Origin` header is permitted by the policy. The literal
 * `Origin: null` (sandboxed iframe, `file://`, some redirects) is rejected
 * unconditionally — even under a wildcard policy — so a sandboxed page can
 * never be treated as an allowed origin.
 */
export function isOriginAllowed(policy: ResolvedCorsPolicy, origin: string | null): boolean {
  if (origin === null || origin.trim() === 'null' || origin.trim() === '') {
    return false;
  }
  return policy.matchOrigin(origin);
}

/**
 * The value to emit in `Access-Control-Allow-Origin`. Credentialed responses
 * must echo the exact request origin (the wildcard is illegal with
 * credentials); non-credentialed wildcard policies may answer `*`.
 */
function allowOriginValue(policy: ResolvedCorsPolicy, requestOrigin: string): string {
  if (policy.allowsAnyOrigin && !policy.credentials) {
    return WILDCARD_ORIGIN;
  }
  return requestOrigin;
}

/** True when the request is a CORS preflight (an `OPTIONS` with the request-method hint). */
export function isPreflightRequest(request: Request): boolean {
  return (
    request.method === 'OPTIONS' && request.headers.get('access-control-request-method') !== null
  );
}

/**
 * Build the preflight (`OPTIONS`) response. Always returns a bounded 204 so
 * the path is cheap and stateless — it emits `Access-Control-*` headers only
 * when the origin is allowed AND the requested method and headers are within
 * policy; otherwise the 204 carries no CORS headers and the browser blocks the
 * real request. `Vary` covers all three request dimensions a shared cache
 * could key on, and `Cache-Control: no-store` keeps a proxy from reusing one
 * origin's decision for another.
 */
export function buildPreflightResponse(policy: ResolvedCorsPolicy, request: Request): Response {
  const baseHeaders: Record<string, string> = {
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    'Cache-Control': 'no-store',
  };

  const denied = new Response(null, { status: 204, headers: baseHeaders });

  const origin = request.headers.get('origin');
  if (origin === null || !isOriginAllowed(policy, origin)) {
    return denied;
  }

  const requestedMethod = request.headers.get('access-control-request-method');
  if (requestedMethod === null || !policy.allowedMethodSet.has(requestedMethod.toUpperCase())) {
    return denied;
  }

  const requestedHeaders = parseRequestedHeaders(
    request.headers.get('access-control-request-headers'),
  );
  if (!requestedHeaders.every((header) => policy.allowedHeaderSet.has(header))) {
    return denied;
  }

  // Origin is narrowed to `string` here by the guards above.
  const headers: Record<string, string> = {
    ...baseHeaders,
    'Access-Control-Allow-Origin': allowOriginValue(policy, origin),
    'Access-Control-Allow-Methods': policy.allowedMethodsHeader,
    'Access-Control-Allow-Headers': policy.allowedHeadersHeader,
    'Access-Control-Max-Age': String(policy.maxAgeSeconds),
  };
  if (policy.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Add CORS response headers to an actual (non-preflight) response when the
 * request carried an allowed `Origin`. Mutates and returns the same response.
 * Always sets `Vary: Origin` (appending to any existing value) so caches do
 * not serve one origin's headers to another.
 */
export function decorateResponseWithCors(
  policy: ResolvedCorsPolicy,
  request: Request,
  response: Response,
): Response {
  const origin = request.headers.get('origin');
  if (origin === null || !isOriginAllowed(policy, origin)) {
    return response;
  }

  appendVary(response.headers, 'Origin');
  response.headers.set('Access-Control-Allow-Origin', allowOriginValue(policy, origin));
  if (policy.credentials) {
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  if (policy.exposedHeadersHeader !== null) {
    response.headers.set('Access-Control-Expose-Headers', policy.exposedHeadersHeader);
  }
  return response;
}

/** Parse a comma-separated `Access-Control-Request-Headers` value into lowercase tokens. */
function parseRequestedHeaders(value: string | null): string[] {
  if (value === null || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== '');
}

/** Append a token to the `Vary` header without clobbering existing entries. */
function appendVary(headers: Headers, token: string): void {
  const existing = headers.get('Vary');
  if (existing === null || existing.trim() === '') {
    headers.set('Vary', token);
    return;
  }
  const tokens = existing.split(',').map((entry) => entry.trim().toLowerCase());
  if (tokens.includes(token.toLowerCase()) || tokens.includes('*')) {
    return;
  }
  headers.set('Vary', `${existing}, ${token}`);
}

/**
 * Validate a `CorsOptions` at `serve()` time so misconfigurations fail before
 * the port binds. Throws `Error` on:
 *   - `credentials: true` combined with a wildcard origin (illegal per spec);
 *   - a wildcard origin paired with an `Authorization` allowed-header (lets any
 *     origin read responses to bearer-token requests — almost never intended).
 *
 * `authConfigured` must mirror what `serve()` passes as `requireAuthorizationHeader`
 * to {@link resolveCorsPolicy}: when `auth` is set, `Authorization` is auto-added
 * to the effective allowed-headers, so the wildcard + `Authorization` check has to
 * account for that even when the operator did not list it explicitly. Validating
 * against `options.allowedHeaders` alone would let `cors: { allowedOrigins: ['*'],
 * allowedHeaders: ['Content-Type'] }` pass under `auth` and then resolve to a policy
 * that allows bearer tokens under a wildcard origin.
 */
export function validateCorsOptions(options: CorsOptions, authConfigured = false): void {
  const allowed = options.allowedOrigins;
  const isWildcard =
    Array.isArray(allowed) && allowed.length === 1 && allowed[0] === WILDCARD_ORIGIN;
  if (!isWildcard) {
    return;
  }
  if (options.credentials === true) {
    throw new Error(
      'serve({ cors }): allowedOrigins ["*"] cannot be combined with credentials: true — ' +
        'a wildcard origin is illegal for credentialed CORS. List explicit origins instead.',
    );
  }
  const headers = options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS;
  const allowsAuthorizationHeader =
    authConfigured || headers.some((header) => header.toLowerCase() === 'authorization');
  if (allowsAuthorizationHeader) {
    throw new Error(
      'serve({ cors }): allowedOrigins ["*"] combined with an Authorization allowed-header lets ' +
        'any web origin send bearer tokens and read the response. List explicit origins, or drop ' +
        'Authorization from allowedHeaders if the wildcard is truly intended for a public API. ' +
        '(When serve({ auth }) is configured, Authorization is always an allowed header, so a ' +
        'wildcard origin is rejected regardless of allowedHeaders.)',
    );
  }
}
