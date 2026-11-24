import { WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';
/**
 * Test-only entry points that send a request as the one user a server with no
 * authentication knows: the `unauthenticated-local` principal, which holds
 * every built-in scope.
 *
 * `serve()` attaches that principal to every request when it has no `auth`.
 * `handleRequest()` and `executeOperation()` called directly have no such
 * server in front of them, so a bare call is anonymous and may reach only the
 * one public operation (`weft.system.principal`). Tests that exercise an
 * operation's behavior rather than its authorization call these instead, so
 * the scope an operation requires is not what they are measuring.
 *
 * This module is test-only (`.test-support.ts` is excluded from the production
 * build) and must never be imported by production server code.
 */

import { unauthenticatedLocalAuthContext } from "../embedded/backchannel/src/index.ts";
import { handleRequest, type HandlerOptions } from './handler.ts';

/** The context `serve()` attaches to every request when it has no `auth`. */
export const LOCAL_USER_AUTH_CONTEXT = unauthenticatedLocalAuthContext(WEFT_SCOPE_VOCABULARY);

/**
 * `handleRequest` as the local user. An `authContext` in `options` still wins,
 * so a test can opt back into any other caller.
 */
export function handleRequestAsLocalUser(
  request: Request,
  engine: Parameters<typeof handleRequest>[1],
  options: HandlerOptions = {},
): Promise<Response> {
  return handleRequest(request, engine, { authContext: LOCAL_USER_AUTH_CONTEXT, ...options });
}
