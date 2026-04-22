/**
 * Transport-neutral authorization policy types and helpers.
 *
 * Hosts the access-policy discriminated union, scope extraction from JWT
 * claims, and the pipeline access check. The scope vocabulary itself lives
 * in `authorization-scope.ts` to keep `principal.ts` and this file
 * cycle-free.
 *
 * See Track 8 design decisions 3, 6, and 10.
 */

import { type AuthorizationScope } from './authorization-scope.ts';
import { isAuthenticated, type Principal } from './principal.ts';

/** Non-empty tuple of authorization scopes. Prevents `anyOf([])` / `allOf([])` at the type level. */
export type ScopeRequirement =
  | { kind: 'anyOf'; scopes: [AuthorizationScope, ...AuthorizationScope[]] }
  | { kind: 'allOf'; scopes: [AuthorizationScope, ...AuthorizationScope[]] };

/** The only representable access policies for an operation. Invalid combinations are unrepresentable. */
export type AccessPolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'scoped'; scopes: ScopeRequirement }
  | { kind: 'optionalAuth'; authenticatedScopes: ScopeRequirement };

/**
 * Result of a pipeline access check. Denials carry a classification so the
 * caller can emit the correct `Unauthorized` vs `Forbidden` fault.
 */
export type AccessCheckResult =
  | { allowed: true }
  | { allowed: false; classification: 'unauthorized' | 'forbidden'; reason: string };

/**
 * Evaluate an `AccessPolicy` against the caller's principal. This is the
 * pipeline step that translates the declarative policy into a pass/fail
 * decision. Credential *validation* happens at the transport edge, BEFORE
 * this function runs; by the time we're here, the principal shape tells us
 * whether the caller is authenticated.
 */
export function evaluateAccess(policy: AccessPolicy, principal: Principal): AccessCheckResult {
  switch (policy.kind) {
    case 'public':
      return { allowed: true };

    case 'authenticated':
      if (isAuthenticated(principal)) return { allowed: true };
      return {
        allowed: false,
        classification: 'unauthorized',
        reason: 'authentication required',
      };

    case 'scoped':
      if (!isAuthenticated(principal)) {
        return {
          allowed: false,
          classification: 'unauthorized',
          reason: 'authentication required',
        };
      }
      return checkScopeRequirement(policy.scopes, principal.scopes);

    case 'optionalAuth':
      if (!isAuthenticated(principal)) return { allowed: true };
      return checkScopeRequirement(policy.authenticatedScopes, principal.scopes);
  }
}

function checkScopeRequirement(
  requirement: ScopeRequirement,
  held: ReadonlySet<AuthorizationScope>,
): AccessCheckResult {
  if (requirement.kind === 'anyOf') {
    const hasAny = requirement.scopes.some((scope) => held.has(scope));
    if (hasAny) return { allowed: true };
    return {
      allowed: false,
      classification: 'forbidden',
      reason: `requires any of: ${requirement.scopes.join(', ')}`,
    };
  }

  const missing = requirement.scopes.filter((scope) => !held.has(scope));
  if (missing.length === 0) return { allowed: true };
  return {
    allowed: false,
    classification: 'forbidden',
    reason: `missing required scopes: ${missing.join(', ')}`,
  };
}
