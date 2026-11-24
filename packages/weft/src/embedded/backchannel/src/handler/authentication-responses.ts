/**
 * What a handler does with an authentication result: the context a successful one admits and the
 * 401 a rejected one receives. Shared by `serve()`'s request gate and the engine-independent
 * handler's authenticator, so the two forward the same principal and claims, and the body and the
 * `WWW-Authenticate` challenge cannot drift apart.
 *
 * @module server/handler/authentication-responses
 */

import type { AuthContext, AuthResult } from '../authentication.ts';

/**
 * The context a successful, non-public authentication result admits. One
 * mapping for `serve()`'s gate and for the engine-independent handler's
 * authenticator, so the two forward the same principal and claims.
 */
export function authContextFromAuthResult(
  authResult: Extract<AuthResult, { authenticated: true }>,
): AuthContext {
  return {
    method: authResult.method,
    ...(authResult.claims !== undefined ? { claims: authResult.claims } : {}),
    ...(authResult.principal !== undefined ? { principal: authResult.principal } : {}),
  };
}

/**
 * The 401 a rejected credential receives. Shared by `serve()`'s gate and the
 * engine-independent handler's authenticator so the body and the
 * `WWW-Authenticate` challenge cannot drift apart.
 */
export function unauthorizedResponse(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    },
  });
}
