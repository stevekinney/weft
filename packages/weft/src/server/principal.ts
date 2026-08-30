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
 * This stable principal model ensures consistent authentication across all
 * transport layers.
 *
 * The discriminator string for API keys is `'api-key'` (kebab-case) to match
 * the existing `AuthMethod` literal in `authentication.ts`. Keep them aligned;
 * the bridge from `AuthResult` to `Principal` relies on byte-identical strings.
 */

import {
  AUTHORIZATION_SCOPES,
  extractScopesFromClaims,
  type AuthorizationScope,
} from './authorization-scope.ts';

/**
 * Raw JWT payload — intentionally loose; individual claim access is
 * type-guarded at read sites. **Non-authoritative for authorization
 * decisions.** Use `principal.subject` and `principal.scopes` (both
 * derived and normalized at construction time) instead. The `claims`
 * bag is preserved for debugging and pass-through.
 *
 * @example
 * ```ts
 * import { principalFromJwtClaims, type JwtClaims } from '@lostgradient/weft/mcp';
 *
 * const claims: JwtClaims = {
 *   sub: 'user-123',
 *   scope: 'workflows:read',
 * };
 * const principal = principalFromJwtClaims(claims);
 * console.log(principal.subject);
 * ```
 */
export type JwtClaims = Record<string, unknown>;

/**
 * An authenticated caller — JWT, API key, or mTLS. Carries the granted scope
 * set and a `hasScope` accessor; downstream code should narrow to this shape
 * via `isAuthenticated` before calling `hasScope`.
 *
 * The privileged `'stdio-local'` principal is for local stdio admission and
 * carries the full local-admin scope set. It is exported for embedders that
 * implement their own local admission gate; public transports should not mint
 * it for remote callers.
 *
 * @example
 * ```ts
 * import { principalFromApiKey, type AuthenticatedPrincipal } from '@lostgradient/weft/mcp';
 *
 * const principal: AuthenticatedPrincipal = principalFromApiKey({
 *   subject: 'local-tool',
 *   scopes: ['workflows:read'],
 * });
 * console.log(principal.method);
 * ```
 */
export type AuthenticatedPrincipal = {
  readonly method: 'jwt' | 'api-key' | 'mtls' | 'stdio-local';
  readonly scopes: ReadonlySet<AuthorizationScope>;
  readonly claims: JwtClaims | undefined;
  readonly subject: string | undefined;
  hasScope(scope: AuthorizationScope): boolean;
};

/**
 * An unauthenticated caller. Has no scopes and no `hasScope` method —
 * deliberate, so callers MUST narrow via `isAuthenticated` before any
 * scope-bearing access.
 *
 * @example
 * ```ts
 * import { anonymousPrincipal, type UnauthenticatedPrincipal } from '@lostgradient/weft/mcp';
 *
 * const principal: UnauthenticatedPrincipal = anonymousPrincipal();
 * console.log(principal.method);
 * ```
 */
export type UnauthenticatedPrincipal = {
  readonly method: 'unauthenticated';
};

/**
 * The full principal union used everywhere below the transport edge.
 *
 * @example
 * ```ts
 * import { anonymousPrincipal, type Principal } from '@lostgradient/weft/mcp';
 *
 * const principal: Principal = anonymousPrincipal();
 * console.log(principal.method);
 * ```
 */
export type Principal = AuthenticatedPrincipal | UnauthenticatedPrincipal;

/**
 * Build an `AuthenticatedPrincipal` from a JWT claims payload.
 *
 * @example
 * ```ts
 * import { principalFromJwtClaims } from '@lostgradient/weft/mcp';
 *
 * const principal = principalFromJwtClaims({
 *   sub: 'user-123',
 *   scope: 'workflows:read workflows:write',
 * });
 * console.log(principal.hasScope('workflows:read'));
 * ```
 */
export function principalFromJwtClaims(claims: JwtClaims): AuthenticatedPrincipal {
  const scopes = extractScopesFromClaims(claims);
  const subject = typeof claims['sub'] === 'string' ? claims['sub'] : undefined;

  return {
    method: 'jwt',
    scopes,
    claims,
    subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * Build an `AuthenticatedPrincipal` from an API-key admission result.
 *
 * @example
 * ```ts
 * import { principalFromApiKey } from '@lostgradient/weft/mcp';
 *
 * const principal = principalFromApiKey({
 *   subject: 'automation',
 *   scopes: ['workflows:read'],
 * });
 * console.log(principal.subject);
 * ```
 */
export function principalFromApiKey(options: {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
}): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(options.scopes);
  return {
    method: 'api-key',
    scopes,
    claims: undefined,
    subject: options.subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * Build an `AuthenticatedPrincipal` from an mTLS admission result.
 *
 * @example
 * ```ts
 * import { principalFromMutualTls } from '@lostgradient/weft/mcp';
 *
 * const principal = principalFromMutualTls({
 *   subject: 'client-cert-subject',
 *   scopes: ['system:read'],
 * });
 * console.log(principal.method);
 * ```
 */
export function principalFromMutualTls(options: {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
}): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(options.scopes);
  return {
    method: 'mtls',
    scopes,
    claims: undefined,
    subject: options.subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * The single unauthenticated principal.
 *
 * @example
 * ```ts
 * import { anonymousPrincipal } from '@lostgradient/weft/mcp';
 *
 * const principal = anonymousPrincipal();
 * console.log(principal.method);
 * ```
 */
export function anonymousPrincipal(): UnauthenticatedPrincipal {
  return ANONYMOUS;
}

/**
 * Build the privileged `stdio-local` principal for the Phase 13
 * runtime stdio subcommand. Admission is gated at the CLI boundary
 * (`--startup-token <hex>` or `--allow-unauthenticated-local-admin`);
 * once admitted, the session has every scope because it's running as
 * a local process that can already invoke the binary directly.
 *
 * @example
 * ```ts
 * import { principalFromStdioLocal } from '@lostgradient/weft/mcp';
 *
 * const principal = principalFromStdioLocal();
 * console.log(principal.hasScope('workflows:write'));
 * ```
 */
export function principalFromStdioLocal(): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(AUTHORIZATION_SCOPES);
  return {
    method: 'stdio-local',
    scopes,
    claims: undefined,
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
