/**
 * Request admission gate: authentication then per-key rate limiting.
 *
 * Extracted from the server fetch dispatcher so the dispatch path stays small.
 * `gateRequest` runs the two short-circuiting steps a request must pass before
 * any handler sees it:
 *   1. **Authentication** — produces the auth context, a 401, or a public-path
 *      bypass. Auth-event auditing happens inside the authenticator itself.
 *   2. **Rate limiting** — throttles per principal-or-IP key, returning 429 with
 *      `Retry-After` once a key exceeds its window budget. Public-path requests
 *      and servers without a `rateLimit` are never throttled. Failed-auth
 *      requests are also checked against the IP-keyed limiter so that
 *      credential-stuffing floods are shed before returning the 401.
 *
 * @internal
 */

import type { AuthContext } from '../authentication.ts';
import { DEFAULT_PUBLIC_PATHS, normalizeRequestPathname } from '../authentication/types.ts';
import type { ServerContext } from './context.ts';

const DEFAULT_PUBLIC_PATH_SET = new Set(DEFAULT_PUBLIC_PATHS);

/**
 * Outcome of {@link authenticateRequest}: the resolved auth context (absent for
 * public-path bypass and unauthenticated servers), a short-circuit `response`
 * (a 401 on rejection, else `null`), and whether the request hit a public path.
 */
export type AuthenticationOutcome = {
  authContext?: AuthContext;
  response: Response | null;
  /**
   * `true` when the request matched a configured public path and bypassed
   * authentication. The rate-limit step uses this to exempt health, metrics,
   * and discovery probes from per-key throttling.
   */
  publicBypass: boolean;
};

export async function authenticateRequest(
  context: ServerContext,
  request: Request,
): Promise<AuthenticationOutcome> {
  if (!context.authenticatorPromise) {
    // No authenticator is configured. Rate limiting still respects the default
    // public-path list so health, metrics, and discovery probes are exempt.
    const publicBypass = DEFAULT_PUBLIC_PATH_SET.has(normalizeRequestPathname(request));
    return { response: null, publicBypass };
  }

  const authenticator = await context.authenticatorPromise;
  const authResult = await authenticator(request);
  if (authResult.authenticated) {
    if (authResult.method === 'public') {
      return { response: null, publicBypass: true };
    }

    return {
      authContext: {
        method: authResult.method,
        ...(authResult.claims !== undefined ? { claims: authResult.claims } : {}),
        ...(authResult.principal !== undefined ? { principal: authResult.principal } : {}),
      },
      response: null,
      publicBypass: false,
    };
  }

  return {
    response: new Response(JSON.stringify({ error: authResult.error }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    }),
    publicBypass: false,
  };
}

/**
 * Derive the subject from an auth context for rate-limit keying. Mirrors the
 * logic in `subjectFromResult` in `authentication/index.ts`: prefers the
 * forwarded principal's `subject` (API-key auth), then falls back to the JWT
 * `sub` claim (JWT auth), and leaves it undefined for mTLS or claimless
 * admissions.
 */
function subjectFromAuthContext(authContext: AuthContext | undefined): string | undefined {
  if (authContext?.principal?.subject !== undefined) {
    return authContext.principal.subject;
  }
  const sub = authContext?.claims?.['sub'];
  // Mirror subjectFromResult in authentication/index.ts: return the sub claim
  // as-is (including empty string) so keying stays consistent with the audit
  // trail. The rate limiter treats any string — even empty — as a stable key.
  return typeof sub === 'string' ? sub : undefined;
}

/**
 * Stable rate-limit key for a request. Prefers the authenticated subject
 * (so a single principal is throttled across IPs, regardless of whether they
 * authenticated via API key or JWT); falls back to the client address from
 * `server.requestIP()`, and finally to a shared `unidentified` bucket when
 * neither is available.
 */
function rateLimitKeyForRequest(
  server: ReturnType<typeof Bun.serve>,
  request: Request,
  authContext: AuthContext | undefined,
): string {
  const subject = subjectFromAuthContext(authContext);
  if (subject !== undefined) {
    return `principal:${subject}`;
  }
  const address = server.requestIP(request)?.address;
  if (address !== undefined && address.length > 0) {
    return `ip:${address}`;
  }
  return 'unidentified';
}

/**
 * Apply the configured rate limiter to a request and return a `429` response
 * when the request's key is over budget, or `null` to let it proceed. Public
 * bypass requests (health, metrics, discovery) and servers without a limiter
 * are never throttled. The `429` carries `Retry-After` and `X-RateLimit-*`
 * headers and a masked, credential-free body.
 */
function enforceRateLimit(
  context: ServerContext,
  server: ReturnType<typeof Bun.serve>,
  request: Request,
  authContext: AuthContext | undefined,
  publicBypass: boolean,
): Response | null {
  if (context.rateLimiter === null || publicBypass) {
    return null;
  }
  const decision = context.rateLimiter.check(rateLimitKeyForRequest(server, request, authContext));
  if (decision.allowed) {
    return null;
  }
  return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(decision.retryAfterSeconds),
      'X-RateLimit-Limit': String(decision.limit),
      'X-RateLimit-Remaining': String(decision.remaining),
    },
  });
}

/**
 * Run the request gate: authenticate, then rate-limit. Returns a short-circuit
 * `response` (401 or 429) when either step rejects, otherwise `response: null`
 * with the resolved authentication outcome.
 *
 * Failed-auth requests are checked against the IP-keyed limiter before the 401
 * is returned so that credential-stuffing floods consume the rate-limit budget
 * and are eventually shed with a 429 instead of burning CPU indefinitely.
 *
 * `originalRequest` (when provided) is used solely for IP lookup in
 * `server.requestIP()`. Certain callers rewrite the request URL (e.g. to strip
 * an `/api` prefix) via `new Request(url, request)`, which loses Bun's internal
 * socket handle — so `requestIP` on the rewritten copy returns `null`. Passing
 * the pre-rewrite request here ensures IP-based rate limiting stays functional
 * on the `/api/…` prefix path.
 */
export async function gateRequest(
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  request: Request,
  originalRequest: Request = request,
): Promise<{ response: Response | null; authentication: AuthenticationOutcome }> {
  const authentication = await authenticateRequest(context, request);
  if (authentication.response !== null) {
    // Auth failed. Apply the IP-keyed rate limiter to failed-auth requests so
    // that credential-stuffing or wrong-key floods consume the window budget.
    // If the IP is already over budget, return 429 instead of 401.
    // Use originalRequest for IP lookup — the rewritten request object may have
    // lost Bun's internal socket handle and would return null for requestIP.
    const failedAuthThrottle = enforceRateLimit(context, server, originalRequest, undefined, false);
    if (failedAuthThrottle !== null) {
      return { response: failedAuthThrottle, authentication };
    }
    return { response: authentication.response, authentication };
  }
  // Throttle authenticated (and unauthenticated-but-non-public) requests once a
  // per-key budget is exceeded. Runs after auth so it can key by principal
  // subject; before any handler so a flood is shed before doing real work.
  // Use originalRequest for IP fallback keying.
  const rateLimited = enforceRateLimit(
    context,
    server,
    originalRequest,
    authentication.authContext,
    authentication.publicBypass,
  );
  return { response: rateLimited, authentication };
}
