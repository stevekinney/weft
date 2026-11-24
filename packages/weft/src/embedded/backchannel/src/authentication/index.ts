/**
 * Authentication middleware for the Weft HTTP server.
 *
 * Supports three authentication methods, all optional and configurable:
 * - **API keys**: validated via `Authorization: Bearer <key>` or `X-API-Key` header
 * - **JWT**: HMAC or RSA/ECDSA signature verification with claims validation
 * - **mTLS**: mutual TLS at the transport layer (configured via Bun.serve tls options),
 *   admitted only on positive evidence of a verified client certificate
 *
 * @module server/authentication
 */

import { createAdditionalScopeSet } from '../authorization-scope.ts';
import { defaultAuthAuditSink, emitAuthAuditEvent, type AuthAuditSink } from './audit.ts';
import {
  createApiKeyVerifier,
  createJwtVerifier,
  createMutualTlsVerifier,
  extractApiKey,
  validateJwtConfig,
  type CreateAuthenticatorOptions,
  type CredentialVerifier,
} from './credential-verifiers.ts';
import {
  DEFAULT_PUBLIC_PATHS,
  normalizeRequestPathname,
  type AuthConfig,
  type Authenticator,
  type AuthResult,
} from './types.ts';

export {
  defaultAuthAuditSink,
  emitAuthAuditEvent,
  type AuthAuditContext,
  type AuthAuditEvent,
  type AuthAuditSink,
} from './audit.ts';
export { importJWTKey, signJWT, verifyJWT } from './crypto.ts';
export {
  createRateLimiter,
  validateRateLimitConfig,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimiter,
} from './rate-limiter.ts';
export { isSensitiveHeader, redactCredential, redactHeaders } from './redaction.ts';
export {
  createRotatingApiKeyStore,
  type ApiKeyRegistration,
  type RotatingApiKeyStore,
} from './rotating-api-key-store.ts';
export {
  DEFAULT_CLOCK_TOLERANCE,
  DEFAULT_PUBLIC_PATHS,
  type AuthConfig,
  type AuthContext,
  type Authenticator,
  type AuthMethod,
  type AuthResult,
  type JWTAlgorithm,
  type JWTConfig,
  type JWTPayload,
  type MTLSConfig,
} from './types.ts';

function assertAtLeastOneMethod(config: AuthConfig): void {
  const hasMethod =
    (config.apiKeys && config.apiKeys.length > 0) ||
    config.jwt !== undefined ||
    config.mtls !== undefined ||
    config.resolveApiKeyPrincipal !== undefined;
  if (!hasMethod) {
    throw new Error(
      'AuthConfig must specify at least one authentication method ' +
        '(apiKeys, resolveApiKeyPrincipal, jwt, or mtls)',
    );
  }
}

function assertNoConflictingMethods(config: AuthConfig): void {
  if (config.resolveApiKeyPrincipal !== undefined && config.jwt !== undefined) {
    throw new Error(
      'AuthConfig cannot combine resolveApiKeyPrincipal with jwt: ' +
        'the resolver consumes every Authorization: Bearer token before JWT verification, ' +
        'so the JWT method would be unreachable.',
    );
  }
}

export {
  createApiKeyVerifier,
  createJwtVerifier,
  createMutualTlsVerifier,
  type CreateAuthenticatorOptions,
  type CredentialVerification,
  type CredentialVerifier,
} from './credential-verifiers.ts';

/**
 * Whether TLS options built by {@link buildTLSOptions} refuse every
 * connection that lacks a verified client certificate.
 */
export function tlsOptionsVerifyClientCertificates(
  tlsOptions: ReturnType<typeof buildTLSOptions>,
): boolean {
  return tlsOptions !== undefined && tlsOptions.requestCert && tlsOptions.rejectUnauthorized;
}

/**
 * Validate an `AuthConfig` eagerly, throwing on invalid combinations.
 * Called synchronously in `serve()` so misconfigurations fail fast.
 *
 * @example
 * ```ts
 * import { validateAuthConfig } from '@lostgradient/backchannel';
 *
 * // Throws if config is invalid (e.g. missing secret for HS256)
 * validateAuthConfig({
 *   apiKeys: ['secret-key-1'],
 *   defaultApiKeyScopes: ['inventory:read'],
 * });
 * console.log('Config is valid');
 * ```
 */
export function validateAuthConfig(config: AuthConfig): void {
  if (config.verifiers !== undefined) {
    if (
      config.apiKeys !== undefined ||
      config.resolveApiKeyPrincipal !== undefined ||
      config.jwt !== undefined ||
      config.mtls !== undefined
    ) {
      throw new Error('AuthConfig.verifiers cannot be combined with legacy authentication methods');
    }
    if (config.verifiers.length === 0) {
      throw new Error('AuthConfig must specify at least one authentication method');
    }
    return;
  }
  validateJwtConfig(config.jwt);
  assertAtLeastOneMethod(config);
  assertNoConflictingMethods(config);
}

/**
 * Create an authenticator function from an auth configuration.
 *
 * The returned function checks each configured method in order:
 * 1. Public path bypass
 * 2. API key (constant-time digest scan)
 * 3. JWT (signature + claims verification)
 * 4. mTLS, only when no explicit credential was presented and a verified client
 *    certificate is evidenced by `verifyClientCertificate` or by
 *    `options.transportVerifiesClientCertificates`
 *
 * @example
 * ```ts
 * import { createAuthenticator } from '@lostgradient/backchannel';
 *
 * const authenticate = await createAuthenticator({
 *   apiKeys: ['my-secret-key'],
 *   defaultApiKeyScopes: ['inventory:read'],
 * });
 * const request = new Request('http://localhost/v1/workflows', {
 *   headers: { 'X-API-Key': 'my-secret-key' },
 * });
 * const result = await authenticate(request);
 * console.log(result.authenticated); // true
 * ```
 */
export async function createAuthenticator(
  config: AuthConfig,
  options: CreateAuthenticatorOptions = {},
): Promise<Authenticator> {
  validateAuthConfig(config);
  // Validate the scope registration even when the configured verifiers do not use scopes.
  createAdditionalScopeSet(options.additionalScopes);
  const publicPaths = new Set(config.publicPaths ?? DEFAULT_PUBLIC_PATHS);
  const auditSink = config.auditSink ?? defaultAuthAuditSink;
  const verifiers =
    config.verifiers === undefined
      ? await legacyVerifiers(config, options)
      : config.verifiers.map((verifier) => ({
          method: verifier.method,
          verify: verifier.verify.bind(verifier),
        }));

  return async (request: Request): Promise<AuthResult> => {
    if (publicPaths.has(normalizeRequestPathname(request))) {
      return { authenticated: true, method: 'public' };
    }

    let explicitCredentialAttempted = false;
    for (const verifier of verifiers) {
      try {
        const outcome = await verifier.verify(request, { explicitCredentialAttempted });
        if (outcome.kind === 'admit') {
          return auditDecision(
            auditSink,
            request,
            {
              ...outcome.authentication,
              authenticated: true,
            },
            verifier.method,
          );
        }
        if (outcome.kind === 'reject') break;
        if (outcome.kind === 'unrecognized') explicitCredentialAttempted = true;
      } catch (error) {
        console.warn(
          'Credential verification failed:',
          error instanceof Error ? error.message : error,
        );
        break;
      }
    }

    return auditDecision(auditSink, request, {
      authenticated: false,
      error: 'No valid credentials provided',
    });
  };
}

async function legacyVerifiers(
  config: AuthConfig,
  options: CreateAuthenticatorOptions,
): Promise<CredentialVerifier[]> {
  // Start both async preparations before either settles so they snapshot the configuration together.
  const apiKey =
    config.apiKeys?.length || config.resolveApiKeyPrincipal !== undefined
      ? createApiKeyVerifier(config, options)
      : Promise.resolve(undefined);
  const jwt =
    config.jwt === undefined ? Promise.resolve(undefined) : createJwtVerifier(config.jwt, options);
  const mtls =
    config.mtls === undefined ? undefined : createMutualTlsVerifier(config.mtls, options);
  const verifiers = [...(await Promise.all([apiKey, jwt])), mtls];
  return verifiers.filter((verifier) => verifier !== undefined);
}

/**
 * Emit one audit event for a finalized authentication decision and return the
 * result unchanged. Centralizes the success/failure mapping so every terminal
 * return in the authenticator is audited identically. Never logs the presented
 * credential in cleartext — only its one-way fingerprint, derived inside
 * `emitAuthAuditEvent`.
 */
function auditDecision(
  sink: AuthAuditSink,
  request: Request,
  result: AuthResult,
  verifierMethod?: string,
): AuthResult {
  if (result.authenticated) {
    emitAuthAuditEvent(sink, {
      outcome: 'success',
      method: verifierMethod ?? result.method,
      subject: subjectFromResult(result),
      request,
    });
  } else {
    emitAuthAuditEvent(sink, {
      outcome: 'failure',
      method: 'unknown',
      subject: undefined,
      request,
      reason: result.error,
      presentedCredential: extractApiKey(request),
    });
  }
  return result;
}

/**
 * Derive the principal subject from a successful {@link AuthResult} for the
 * audit record. Prefers the forwarded principal's `subject`, falling back to a
 * JWT `sub` claim, and leaving it undefined for mTLS / claimless admissions.
 */
function subjectFromResult(
  result: Extract<AuthResult, { authenticated: true }>,
): string | undefined {
  if (result.principal?.subject !== undefined) {
    return result.principal.subject;
  }
  const sub = result.claims?.['sub'];
  return typeof sub === 'string' ? sub : undefined;
}

/**
 * Build Bun.serve-compatible TLS options from an mTLS configuration.
 * Returns `undefined` when no mTLS is configured.
 */
export function buildTLSOptions(config: AuthConfig | undefined):
  | {
      cert: string;
      key: string;
      ca: string | string[];
      requestCert: boolean;
      rejectUnauthorized: boolean;
    }
  | undefined {
  if (!config?.mtls) return undefined;

  return {
    cert: config.mtls.cert,
    key: config.mtls.key,
    ca: config.mtls.ca,
    requestCert: true,
    rejectUnauthorized: config.mtls.rejectUnauthorized ?? true,
  };
}
