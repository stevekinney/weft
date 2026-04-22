/**
 * Authorization scope vocabulary — extracted into its own module to avoid a
 * dependency cycle between `principal.ts` and `authorization.ts`.
 *
 * All authorization-scope-related types and runtime helpers live here. Access
 * policies, scope requirements, and the access-check pipeline live in
 * `authorization.ts`.
 */

/**
 * All authorization scopes recognized by the runtime. Full-word, colon-separated,
 * one entry per (domain, action) pair. Add new scopes here when introducing a
 * new domain; never derive scope strings dynamically.
 *
 * Scope semantics are deliberately FLAT for v1 — `workflows:admin` does NOT
 * imply `workflows:read` or `workflows:write`. Operation authors must declare
 * the exact scope they require. Scope-implication semantics (if any) are a
 * future track.
 */
export const AUTHORIZATION_SCOPES = [
  'workflows:read',
  'workflows:write',
  'workflows:admin',
  'schedules:read',
  'schedules:write',
  'signals:write',
  'updates:write',
  'queries:read',
  'reviews:read',
  'reviews:write',
  'attributes:read',
  'attributes:write',
  'tags:write',
  'streams:read',
  'events:read',
  'budget:read',
  'budget:write',
  'quota:read',
  'system:read',
  'system:admin',
] as const;

/** String-literal union of every authorization scope. */
export type AuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number];

const SCOPE_LOOKUP = new Set<string>(AUTHORIZATION_SCOPES);

/** Runtime type guard for the `AuthorizationScope` union. */
export function isAuthorizationScope(value: string): value is AuthorizationScope {
  return SCOPE_LOOKUP.has(value);
}

/**
 * Extract the full set of scopes granted by a JWT payload by *merging* every
 * recognized claim source. Real-world tokens commonly carry OIDC scopes (e.g.
 * `openid profile`) in `scope` while application scopes live in `permissions`;
 * a short-circuit on the first present claim would silently drop privileges.
 *
 * Sources merged (all consulted, all unioned):
 *   - `scope` — RFC 8693-style space-delimited string
 *   - `scp` — alternate space-delimited string used by some IdPs
 *   - `permissions` — array of strings
 *
 * Whitespace-only values are treated as absent so they never block fallback to
 * other sources. Unknown scope strings are silently filtered out — the
 * vocabulary in `AUTHORIZATION_SCOPES` is the single source of truth and a
 * misspelled scope cannot grant unintended privileges.
 *
 * Credential *validation* (signature verification, expiry, revocation) happens
 * at the transport edge before the claims object reaches this function.
 */
export function extractScopesFromClaims(
  claims: Record<string, unknown>,
): ReadonlySet<AuthorizationScope> {
  const merged = new Set<AuthorizationScope>();
  addStringClaimScopes(claims['scope'], merged);
  addStringClaimScopes(claims['scp'], merged);

  const permissions = claims['permissions'];
  if (Array.isArray(permissions)) {
    for (const entry of permissions) {
      if (typeof entry === 'string' && isAuthorizationScope(entry)) {
        merged.add(entry);
      }
    }
  }

  return merged;
}

/**
 * Add every recognized scope token from a space-delimited claim string into
 * `target`. No-op for non-strings, empty strings, and whitespace-only strings.
 */
function addStringClaimScopes(value: unknown, target: Set<AuthorizationScope>): void {
  if (typeof value !== 'string') return;
  if (value.trim().length === 0) return;
  for (const token of value.split(/\s+/)) {
    if (token.length === 0) continue;
    if (isAuthorizationScope(token)) {
      target.add(token);
    }
  }
}
