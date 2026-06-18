import type { AuthContext } from '../authentication.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  type Principal,
} from '../principal.ts';

/**
 * Convert the REST transport's `authContext` into a `Principal`. The
 * authenticator (`serve()`) reports method + optional claims; this maps
 * that transport authentication result into the `Principal` used by the
 * operation pipeline.
 * Returns `anonymousPrincipal()` when no context is provided (public
 * request).
 *
 * @example
 * ```ts
 * import { authContextToPrincipal } from '@lostgradient/weft/server/handler';
 *
 * const principal = authContextToPrincipal({ method: 'api-key' });
 * console.log(principal.method); // 'api-key'
 * ```
 */
export function authContextToPrincipal(authContext: AuthContext | undefined): Principal {
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
      return principalFromJwtClaims(authContext.claims);
    }
    case 'api-key':
      return principalFromApiKey({ subject: 'api-key-caller', scopes: [] });
    case 'mtls':
      return principalFromMutualTls({ subject: 'mtls-caller', scopes: [] });
    case 'public':
      return anonymousPrincipal();
  }
}
