import {
  createAdditionalScopeSet,
  EMPTY_SCOPE_VOCABULARY,
  filterRecognizedScopes,
  type PackageAuthorizationScope,
  type ScopeVocabulary,
} from '../authorization-scope.ts';
import { principalFromJwtClaims } from '../principal.ts';
import { tryAdmitApiKey } from './api-key.ts';
import { createConstantTimeApiKeyMatcher } from './constant-time-api-key.ts';
import { importJWTKey, verifyJWT } from './crypto.ts';
import type { AuthConfig, AuthContext, JWTConfig, MTLSConfig } from './types.ts';

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  return null;
}

export function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get('X-API-Key');
  if (headerKey) return headerKey;
  return extractBearerToken(request);
}

export function validateJwtConfig(config: JWTConfig | undefined): void {
  if (config === undefined) return;

  const algorithm = config.algorithm ?? 'HS256';
  if (algorithm.startsWith('HS') && !config.secret) {
    throw new Error('JWT configuration requires "secret" for HMAC algorithms');
  }
  if ((algorithm.startsWith('RS') || algorithm.startsWith('ES')) && !config.publicKey) {
    throw new Error('JWT configuration requires "publicKey" for RSA/ECDSA algorithms');
  }
}

/** The result of examining a request with one credential verifier. */
export type CredentialVerification =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unrecognized' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'admit'; readonly authentication: AuthContext };

/**
 * One ordered credential check. An absent credential leaves the chain unchanged.
 * An unrecognized credential lets later explicit verifiers try, while suppressing
 * mTLS fallback. A rejection ends authentication. The method names successful
 * admissions in audit records.
 */
export type CredentialVerifier = {
  /** The method recorded in the successful authentication audit. */
  readonly method: string;
  /** Inspect the request using the verifier’s credential rules. */
  verify(
    request: Request,
    context: { readonly explicitCredentialAttempted: boolean },
  ): CredentialVerification | Promise<CredentialVerification>;
};

/** Check a static list of API keys or delegate to an authoritative resolver. */
export async function createApiKeyVerifier(
  config: Pick<AuthConfig, 'apiKeys' | 'resolveApiKeyPrincipal' | 'defaultApiKeyScopes'>,
  options: CreateAuthenticatorOptions = {},
): Promise<CredentialVerifier> {
  const resolver = config.resolveApiKeyPrincipal;
  const additionalScopes = createAdditionalScopeSet(options.additionalScopes);
  const scopeVocabulary = options.scopeVocabulary ?? EMPTY_SCOPE_VOCABULARY;
  const defaultScopes = filterRecognizedScopes(
    config.defaultApiKeyScopes ?? [],
    additionalScopes,
    scopeVocabulary,
  );
  const matcher = config.apiKeys?.length
    ? await createConstantTimeApiKeyMatcher(config.apiKeys)
    : null;
  return {
    method: 'api-key',
    async verify(request) {
      const key = extractApiKey(request);
      if (!key || (resolver === undefined && matcher === null)) return { kind: 'absent' };
      const admission = await tryAdmitApiKey(
        key,
        resolver,
        matcher?.entries ?? null,
        defaultScopes,
        additionalScopes,
        scopeVocabulary,
      );
      if (admission === 'continue') return { kind: 'unrecognized' };
      return admission.authenticated
        ? { kind: 'admit', authentication: admission }
        : { kind: 'reject' };
    },
  };
}

/** Check a Bearer JWT and shape its verified claims into a principal. */
export async function createJwtVerifier(
  config: JWTConfig,
  options: CreateAuthenticatorOptions = {},
): Promise<CredentialVerifier> {
  validateJwtConfig(config);
  const jwt = { ...config };
  const additionalScopes = createAdditionalScopeSet(options.additionalScopes);
  const scopeVocabulary = options.scopeVocabulary ?? EMPTY_SCOPE_VOCABULARY;
  const key = await importJWTKey(jwt);
  return {
    method: 'jwt',
    async verify(request) {
      const token = extractBearerToken(request);
      if (!token) return { kind: 'absent' };
      if (!token.includes('.')) return { kind: 'unrecognized' };
      try {
        const claims = await verifyJWT(token, key, jwt);
        const principal = principalFromJwtClaims(claims, { additionalScopes, scopeVocabulary });
        return { kind: 'admit', authentication: { method: 'jwt', claims, principal } };
      } catch (error) {
        console.warn('JWT verification failed:', error instanceof Error ? error.message : error);
        return { kind: 'unrecognized' };
      }
    },
  };
}

/** Admit an mTLS caller when the verifier has positive evidence of a verified certificate. */
export function createMutualTlsVerifier(
  config: Pick<MTLSConfig, 'verifyClientCertificate'>,
  options: CreateAuthenticatorOptions = {},
): CredentialVerifier {
  const verify = config.verifyClientCertificate;
  const transportVerified = options.transportVerifiesClientCertificates === true;
  return {
    method: 'mtls',
    async verify(request, { explicitCredentialAttempted }) {
      if (explicitCredentialAttempted) return { kind: 'absent' };
      try {
        const verified: unknown = verify === undefined ? transportVerified : await verify(request);
        return verified === true
          ? { kind: 'admit', authentication: { method: 'mtls' } }
          : { kind: 'absent' };
      } catch (error) {
        console.warn(
          'Client certificate verification failed:',
          error instanceof Error ? error.message : error,
        );
        return { kind: 'absent' };
      }
    },
  };
}

/**
 * Options supplied by the code that owns the transport, not by `AuthConfig`.
 */
export type CreateAuthenticatorOptions = {
  /** Scopes issued by this host. */
  scopeVocabulary?: ScopeVocabulary;
  /**
   * Attests that the listener carrying these requests requested a client
   * certificate and refused every connection without a verified one, so a
   * request reaching the authenticator is evidence of a verified certificate.
   * `serve()` sets this from the TLS options it builds; leave it unset
   * whenever TLS terminates anywhere else.
   */
  transportVerifiesClientCertificates?: boolean;
  /**
   * Package scopes this authenticator recognizes beyond Weft's built-in
   * vocabulary, such as `bureau.tasks:read`. They are retained from JWT
   * `scope`, `scp`, and `permissions` claims, from `defaultApiKeyScopes`, and
   * from the principal `resolveApiKeyPrincipal` returns; any other unknown
   * scope, including one in the reserved `weft` namespace, is dropped. The set belongs to this
   * authenticator alone. An entry that is not `<namespace>.<resource>:<action>`
   * or that uses the reserved `weft` namespace rejects construction.
   */
  additionalScopes?: readonly PackageAuthorizationScope[];
};
