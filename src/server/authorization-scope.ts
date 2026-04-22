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

/** Runtime type guard for the `AuthorizationScope` union. */
export function isAuthorizationScope(value: string): value is AuthorizationScope {
  return (AUTHORIZATION_SCOPES as readonly string[]).includes(value);
}

/** Extract the full set of scopes granted by a JWT payload, in priority order. */
export function extractScopesFromClaims(
  claims: Record<string, unknown>,
): ReadonlySet<AuthorizationScope> {
  const scopeValue = claims['scope'];
  if (typeof scopeValue === 'string' && scopeValue.length > 0) {
    return splitScopeString(scopeValue);
  }

  const scpValue = claims['scp'];
  if (typeof scpValue === 'string' && scpValue.length > 0) {
    return splitScopeString(scpValue);
  }

  const permissions = claims['permissions'];
  if (Array.isArray(permissions)) {
    const scopes = new Set<AuthorizationScope>();
    for (const entry of permissions) {
      if (typeof entry === 'string' && isAuthorizationScope(entry)) {
        scopes.add(entry);
      }
    }
    return scopes;
  }

  return EMPTY_SCOPE_SET;
}

function splitScopeString(input: string): ReadonlySet<AuthorizationScope> {
  const scopes = new Set<AuthorizationScope>();
  for (const token of input.split(/\s+/)) {
    if (token.length === 0) continue;
    if (isAuthorizationScope(token)) {
      scopes.add(token);
    }
  }
  return scopes;
}

const EMPTY_SCOPE_SET: ReadonlySet<AuthorizationScope> = new Set<AuthorizationScope>();
