import {
  createAuthenticator,
  validateAuthConfig,
  type AuthConfig,
  type AuthContext,
} from '../authentication.ts';
import {
  createAdditionalScopeSet,
  type PackageAuthorizationScope,
  type ScopeVocabulary,
} from '../authorization-scope.ts';
import { authContextFromAuthResult, unauthorizedResponse } from './authentication-responses.ts';

/**
 * Resolves the caller of one request for `createOperationHandler`. Resolve to
 * an {@link AuthContext} to admit the request, or to a `Response` (usually a
 * 401) to refuse it; a `Response` is returned to the caller as-is.
 */
export type OperationHandlerAuthenticate = (request: Request) => Promise<AuthContext | Response>;

/**
 * The authenticator `createOperationHandlerAuthenticator` builds: an
 * `authenticate` hook plus `ready`, which settles once the credential keys
 * have been imported and rejects when one cannot be. Await it at startup to
 * fail the way `serve()` does, rather than answering every request with a 500
 * for the life of the process.
 */
export type OperationHandlerAuthenticator = OperationHandlerAuthenticate & {
  readonly ready: Promise<void>;
};

/** Options for {@link createOperationHandlerAuthenticator}. */
export type OperationHandlerAuthenticatorOptions = {
  /** Scopes issued by this host. */
  readonly scopeVocabulary?: ScopeVocabulary;
  /**
   * Package scopes the handler's operations require beyond Weft's built-in
   * vocabulary, such as `bureau.tasks:read`. The authenticator retains them
   * from JWT `scope`, `scp`, and `permissions` claims, from
   * `defaultApiKeyScopes`, and from the principal `resolveApiKeyPrincipal`
   * returns; any other unknown scope is dropped. They belong to this
   * authenticator alone. Same rules and the same validation as
   * `serve({ additionalScopes })`.
   */
  readonly additionalScopes?: readonly PackageAuthorizationScope[];
};

/**
 * Build the `authenticate` hook for `createOperationHandler` from Weft's
 * API-key, JWT, and mTLS schemes.
 *
 * It admits and refuses exactly as `serve({ auth })` does: the same
 * `createAuthenticator` underneath, the same forwarded principal, and the same
 * 401 (body and `WWW-Authenticate` challenge) for a rejected credential. A bad
 * `config` or `additionalScopes` entry throws here, synchronously, before the
 * handler serves a request, and so does a `config.publicPaths`: the handler owns
 * public paths. A key that cannot be imported rejects `ready`.
 *
 * mTLS is admitted only on positive evidence of a verified client certificate,
 * and a fetch handler has no transport to supply it, so a request there is
 * never admitted by `mtls`.
 *
 * @example
 * ```ts
 * import { createOperationHandler, createOperationHandlerAuthenticator } from '@lostgradient/backchannel';
 *
 * const handler = createOperationHandler({
 *   operations: [],
 *   host: {},
 *   authenticate: createOperationHandlerAuthenticator(
 *     { apiKeys: ['s3cr3t'], defaultApiKeyScopes: ['inventory:read'] },
 *     { additionalScopes: ['bureau.tasks:read'] },
 *   ),
 * });
 * void handler;
 * ```
 */
export function createOperationHandlerAuthenticator(
  config: AuthConfig,
  options: OperationHandlerAuthenticatorOptions = {},
): OperationHandlerAuthenticator {
  validateAuthConfig(config);
  if (config.publicPaths !== undefined) {
    throw new Error(
      'createOperationHandlerAuthenticator: config.publicPaths is not accepted. Public paths ' +
        "are decided in one place, `createOperationHandler({ publicPaths })` and each mount's " +
        '`publicPaths`; the authenticator itself has none.',
    );
  }
  createAdditionalScopeSet(options.additionalScopes);
  // The authenticator's built-in public paths (`/v1/metrics`, `/.well-known/*`)
  // would admit those requests unauthenticated at a mount that never declared
  // them, so the inner authenticator is given none.
  const authenticatorPromise = createAuthenticator({ ...config, publicPaths: [] }, options);
  // A key that fails to import rejects `ready` and every request. Neither is
  // reported as an unhandled rejection while nothing is awaiting it yet.
  const ready = authenticatorPromise.then(() => undefined);
  ready.catch(() => undefined);

  const authenticate: OperationHandlerAuthenticate = async (request) => {
    const authenticator = await authenticatorPromise;
    const result = await authenticator(request);
    if (!result.authenticated) return unauthorizedResponse(result.error);
    return authContextFromAuthResult(result);
  };
  return Object.assign(authenticate, { ready });
}
