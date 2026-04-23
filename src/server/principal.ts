/**
 * AuthenticatedPrincipal construction and the Principal discriminated union.
 *
 * Principals are the transport-neutral representation of "who made this call."
 * Every transport edge (REST, JSON-RPC HTTP, JSON-RPC WS upgrade, stdio
 * admission) validates credentials and produces exactly one of these shapes
 * before any operation pipeline runs.
 *
 * Credential *validation* (signature verification, expiry, revocation, format
 * checks) is the transport edge's responsibility — these factories assume the
 * inputs they receive describe a credential that has already been accepted.
 *
 * The discriminator string for API keys is `'api-key'` (kebab-case) to match
 * the existing `AuthMethod` literal in `authentication.ts`. Keep them aligned;
 * the bridge from `AuthResult` to `Principal` relies on byte-identical strings.
 *
 * See Track 8 design decisions 3 and 10.
 */

import {
  AUTHORIZATION_SCOPES,
  extractScopesFromClaims,
  type AuthorizationScope,
} from './authorization-scope.ts';

/**
 * Raw JWT payload — intentionally loose; individual claim access is
 * type-guarded at read sites. **Non-authoritative for authorization
 * decisions.** Use `principal.tenantId`, `principal.subject`, and
 * `principal.scopes` (all derived and normalized at construction time)
 * instead. The `claims` bag is preserved for debugging and pass-through.
 */
export type JwtClaims = Record<string, unknown>;

/**
 * An authenticated caller — JWT, API key, or mTLS. Carries the granted scope
 * set and a `hasScope` accessor; downstream code should narrow to this shape
 * via `isAuthenticated` before calling `hasScope`.
 *
 * The privileged `'stdio-local'` principal is deferred to the Phase 13 CLI
 * admission module (see plan design decision 11). That module will extend
 * this union with its own `method` literal when it lands, co-located with
 * the admission check so no transport adapter can mint the privileged
 * principal out-of-band. No factory for stdio-local exists in this PR.
 */
export type AuthenticatedPrincipal = {
  readonly method: 'jwt' | 'api-key' | 'mtls' | 'stdio-local';
  readonly scopes: ReadonlySet<AuthorizationScope>;
  readonly claims: JwtClaims | undefined;
  readonly tenantId: string | undefined;
  readonly subject: string | undefined;
  hasScope(scope: AuthorizationScope): boolean;
};

/**
 * An unauthenticated caller. Has no scopes and no `hasScope` method —
 * deliberate, so callers MUST narrow via `isAuthenticated` before any
 * scope-bearing access.
 */
export type UnauthenticatedPrincipal = {
  readonly method: 'unauthenticated';
};

/** The full principal union used everywhere below the transport edge. */
export type Principal = AuthenticatedPrincipal | UnauthenticatedPrincipal;

/** Build an `AuthenticatedPrincipal` from a JWT claims payload. */
export function principalFromJwtClaims(claims: JwtClaims): AuthenticatedPrincipal {
  const scopes = extractScopesFromClaims(claims);
  const tenantId = extractTenantId(claims);
  const subject = typeof claims['sub'] === 'string' ? claims['sub'] : undefined;

  return {
    method: 'jwt',
    scopes,
    claims,
    tenantId,
    subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/** Build an `AuthenticatedPrincipal` from an API-key admission result. */
export function principalFromApiKey(options: {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
  tenantId?: string;
}): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(options.scopes);
  return {
    method: 'api-key',
    scopes,
    claims: undefined,
    tenantId: options.tenantId,
    subject: options.subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/** Build an `AuthenticatedPrincipal` from an mTLS admission result. */
export function principalFromMutualTls(options: {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
  tenantId?: string;
}): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(options.scopes);
  return {
    method: 'mtls',
    scopes,
    claims: undefined,
    tenantId: options.tenantId,
    subject: options.subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/** The single unauthenticated principal. */
export function anonymousPrincipal(): UnauthenticatedPrincipal {
  return ANONYMOUS;
}

/**
 * Build the privileged `stdio-local` principal for the Phase 13
 * runtime stdio subcommand. Admission is gated at the CLI boundary
 * (`--startup-token <hex>` or `--allow-unauthenticated-local-admin`);
 * once admitted, the session has every scope because it's running as
 * a local process that can already invoke the binary directly.
 */
export function principalFromStdioLocal(): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(AUTHORIZATION_SCOPES);
  return {
    method: 'stdio-local',
    scopes,
    claims: undefined,
    tenantId: undefined,
    subject: 'stdio-local',
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

const ANONYMOUS: UnauthenticatedPrincipal = { method: 'unauthenticated' };

/** Type guard separating authenticated from unauthenticated principals. */
export function isAuthenticated(principal: Principal): principal is AuthenticatedPrincipal {
  return principal.method !== 'unauthenticated';
}

function extractTenantId(claims: JwtClaims): string | undefined {
  for (const key of ['tenantId', 'tenant_id', 'tenant'] as const) {
    const value = claims[key];
    if (typeof value !== 'string') continue;
    // Treat whitespace-only as absent so downstream tenant-isolation logic
    // never receives a blank tenantId that silently passes string checks.
    // Consistent with `addStringClaimScopes` in `authorization-scope.ts`.
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}
