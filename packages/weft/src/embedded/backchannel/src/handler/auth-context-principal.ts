import type { AuthContext } from '../authentication.ts';
import { EMPTY_SCOPE_VOCABULARY, type ScopeVocabulary } from '../authorization-scope.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromUnauthenticatedLocal,
  SHARED_API_KEY_SUBJECT,
  SHARED_MUTUAL_TLS_SUBJECT,
  type Principal,
} from '../principal.ts';

/**
 * Convert the REST transport's `authContext` into a `Principal`. The
 * authenticator (`serve()`) reports method + optional claims; this maps
 * that transport authentication result into the `Principal` used by the
 * operation pipeline.
 * Returns `anonymousPrincipal()` when no context is provided (public
 * request). A forwarded `principal` is used verbatim; without one, a `jwt`
 * context is rebuilt from its claims with built-in scopes only, because the
 * package scopes a handler registered are known only to its authenticator.
 * Forward the authenticator's `principal` to keep them.
 *
 * @example
 * ```ts
 * import { authContextToPrincipal } from '@lostgradient/backchannel';
 *
 * const principal = authContextToPrincipal({ method: 'api-key' });
 * console.log(principal.method); // 'api-key'
 * ```
 */
export function authContextToPrincipal(
  authContext: AuthContext | undefined,
  scopeVocabulary: ScopeVocabulary = EMPTY_SCOPE_VOCABULARY,
): Principal {
  if (authContext === undefined) return anonymousPrincipal();
  if (authContext.principal !== undefined) return authContext.principal;
  switch (authContext.method) {
    case 'jwt': {
      if (authContext.claims === undefined) {
        throw new Error(
          'authContextToPrincipal: jwt authContext reached the pipeline without claims — ' +
            'authenticator contract violation',
        );
      }
      return principalFromJwtClaims(authContext.claims, { scopeVocabulary });
    }
    case 'api-key':
      return principalFromApiKey({ subject: SHARED_API_KEY_SUBJECT, scopes: [] });
    case 'mtls':
      return principalFromMutualTls({ subject: SHARED_MUTUAL_TLS_SUBJECT, scopes: [] });
    case 'unauthenticated-local':
      return principalFromUnauthenticatedLocal(scopeVocabulary);
    case 'public':
      return anonymousPrincipal();
    default: {
      const exhaustiveCheck: never = authContext.method;
      throw new Error(`Unknown auth context method: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Give a trusted local caller the scopes from the supplied host vocabulary.
 * A caller also needs an explicit credential for any additional package scope.
 *
 * @example
 * ```ts
 * import { authContextToPrincipal, createScopeVocabulary, unauthenticatedLocalAuthContext } from '@lostgradient/backchannel';
 *
 * const vocabulary = createScopeVocabulary(['inventory:read']);
 * const principal = authContextToPrincipal(unauthenticatedLocalAuthContext(vocabulary));
 * console.log(principal.method); // 'unauthenticated-local'
 * ```
 */
export function unauthenticatedLocalAuthContext(
  scopeVocabulary: ScopeVocabulary = EMPTY_SCOPE_VOCABULARY,
): AuthContext {
  return Object.freeze({
    method: 'unauthenticated-local',
    principal: principalFromUnauthenticatedLocal(scopeVocabulary),
  });
}
