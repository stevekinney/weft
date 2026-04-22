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

/** A claims object extracted from a JWT. Intentionally loose — individual claim
 *  access is type-guarded at read sites. */
export type JwtClaims = Record<string, unknown>;

/**
 * An authenticated caller — JWT, API key, mTLS, or a local stdio session.
 * Carries the granted scope set and a `hasScope` accessor; downstream code
 * should narrow to this shape via `isAuthenticated` before calling `hasScope`.
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

/**
 * Build the privileged local stdio principal — every authorization scope.
 *
 * **Privileged by design.** This principal grants every scope including
 * `system:admin`. It is reachable only when the `weft rpc-stdio` CLI subcommand
 * has explicitly enabled local admin via `--startup-token` (with first-frame
 * authenticate) OR `--allow-unauthenticated-local-admin` (which logs a loud
 * warning at startup). Never call this from request-bearing transports;
 * admission MUST be enforced by the CLI gate before this is invoked.
 *
 * `tenantId` is intentionally undefined — stdio sits above tenant boundaries
 * and operations that scope by tenant must reject `undefined` tenantId.
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

/** The single unauthenticated principal. */
export function anonymousPrincipal(): UnauthenticatedPrincipal {
  return ANONYMOUS;
}

const ANONYMOUS: UnauthenticatedPrincipal = { method: 'unauthenticated' };

/** Type guard separating authenticated from unauthenticated principals. */
export function isAuthenticated(principal: Principal): principal is AuthenticatedPrincipal {
  return principal.method !== 'unauthenticated';
}

function extractTenantId(claims: JwtClaims): string | undefined {
  for (const key of ['tenantId', 'tenant_id', 'tenant'] as const) {
    const value = claims[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
