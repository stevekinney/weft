/**
 * Transport-neutral authorization policy types and the pipeline access check.
 *
 * Hosts the `AccessPolicy` / `ScopeRequirement` discriminated unions and
 * `evaluateAccess`, the function `executeOperation` calls between the
 * authentication step and the operation invocation. The scope vocabulary
 * and JWT claim extraction live in `authorization-scope.ts` — separated to
 * keep `principal.ts` and this file cycle-free.
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

    default:
      // Defensive default — TypeScript proves this is unreachable for
      // well-formed `AccessPolicy` values (the `_exhaustive: never`
      // assignment fails to compile if a new variant is added without a
      // matching case here). At runtime, a malformed `policy` (from JSON,
      // an `any` cast, or a future variant added without updating this
      // function) would otherwise return `undefined` and silently grant
      // access. Throw deterministically so callers see the bug instead.
      return assertExhaustive(policy);
  }
}

function assertExhaustive(value: never): never {
  throw new Error(
    `authorization received a discriminated value with unknown kind: ${String((value as { kind: unknown }).kind)}`,
  );
}

function checkScopeRequirement(
  requirement: ScopeRequirement,
  held: ReadonlySet<AuthorizationScope>,
): AccessCheckResult {
  // `Array.isArray` reads the object's internal `[[IsArray]]` slot, so it
  // cannot be spoofed by prototype tricks. After this guard, `.some` and
  // `.filter` are guaranteed to be the real built-in methods, not
  // attacker-overridden lookalikes on a poisoned object.
  if (!Array.isArray(requirement.scopes)) {
    throw new Error(
      `authorization: ${requirement.kind} ScopeRequirement.scopes is not an array at runtime`,
    );
  }

  switch (requirement.kind) {
    case 'anyOf': {
      const hasAny = requirement.scopes.some((scope) => held.has(scope));
      if (hasAny) return { allowed: true };
      return {
        allowed: false,
        classification: 'forbidden',
        reason: `requires any of: ${requirement.scopes.join(', ')}`,
      };
    }

    case 'allOf': {
      // The non-empty tuple constraint on `ScopeRequirement.scopes` is a
      // compile-time guarantee. A malformed runtime value with an empty
      // array would otherwise satisfy `missing.length === 0` and silently
      // return `allowed: true`, downgrading a scoped policy to "any
      // authenticated principal allowed."
      if (requirement.scopes.length === 0) {
        throw new Error(
          'authorization: allOf ScopeRequirement has an empty scopes array (the non-empty tuple invariant was violated at runtime)',
        );
      }
      const missing = requirement.scopes.filter((scope) => !held.has(scope));
      if (missing.length === 0) return { allowed: true };
      return {
        allowed: false,
        classification: 'forbidden',
        reason: `missing required scopes: ${missing.join(', ')}`,
      };
    }

    default:
      // Same defensive pattern as `evaluateAccess`. Without this, a
      // malformed `requirement.kind` with `scopes: []` would fall into the
      // implicit allOf branch, satisfy `missing.length === 0`, and silently
      // return `{ allowed: true }` — turning a malformed runtime policy
      // into an unintended grant. Throw deterministically instead.
      return assertExhaustive(requirement);
  }
}
