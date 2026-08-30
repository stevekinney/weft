/**
 * Authentication middleware for the Weft HTTP server.
 *
 * Supports three authentication methods, all optional and configurable:
 * - **API keys**: validated via `Authorization: Bearer <key>` or `X-API-Key` header
 * - **JWT**: HMAC or RSA/ECDSA signature verification with claims validation
 * - **mTLS**: mutual TLS at the transport layer (configured via Bun.serve tls options)
 *
 * @module server/authentication
 */

import type { AuthorizationScope } from '../authorization-scope.ts';
import { tryAdmitApiKey } from './api-key.ts';
import { defaultAuthAuditSink, emitAuthAuditEvent, type AuthAuditSink } from './audit.ts';
import {
  createConstantTimeApiKeyMatcher,
  type ConstantTimeApiKeyEntry,
} from './constant-time-api-key.ts';
import { importJWTKey, verifyJWT } from './crypto.ts';
import {
  DEFAULT_PUBLIC_PATHS,
  normalizeRequestPathname,
  type AuthConfig,
  type Authenticator,
  type AuthResult,
  type JWTConfig,
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

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  return null;
}

function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get('X-API-Key');
  if (headerKey) return headerKey;
  return extractBearerToken(request);
}

function validateJwtConfig(config: JWTConfig | undefined): void {
  if (config === undefined) return;

  const algorithm = config.algorithm ?? 'HS256';
  if (algorithm.startsWith('HS') && !config.secret) {
    throw new Error('JWT configuration requires "secret" for HMAC algorithms');
  }
  if ((algorithm.startsWith('RS') || algorithm.startsWith('ES')) && !config.publicKey) {
    throw new Error('JWT configuration requires "publicKey" for RSA/ECDSA algorithms');
  }
}

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

type ApiKeyAdmissionOptions = {
  resolver: AuthConfig['resolveApiKeyPrincipal'];
  apiKeyEntries: ReadonlyArray<ConstantTimeApiKeyEntry<undefined>> | null;
  defaultApiKeyScopes: ReadonlyArray<AuthorizationScope>;
};

type AuthAttempt = {
  explicitAuthAttempted: boolean;
  result: AuthResult | null;
};

async function authenticateViaApiKey(
  request: Request,
  options: ApiKeyAdmissionOptions,
): Promise<AuthAttempt> {
  const presentedKey = extractApiKey(request);
  const hasApiKeyPath = options.resolver !== undefined || options.apiKeyEntries !== null;
  if (!presentedKey || !hasApiKeyPath) {
    return { explicitAuthAttempted: false, result: null };
  }

  const result = await tryAdmitApiKey(
    presentedKey,
    options.resolver,
    options.apiKeyEntries,
    options.defaultApiKeyScopes,
  );
  return {
    explicitAuthAttempted: true,
    result: result === 'continue' ? null : result,
  };
}

async function authenticateViaJwt(
  request: Request,
  jwtKey: CryptoKey | null,
  jwtConfig: JWTConfig | undefined,
): Promise<AuthAttempt> {
  if (!jwtKey || !jwtConfig) {
    return { explicitAuthAttempted: false, result: null };
  }

  const token = extractBearerToken(request);
  if (!token) {
    return { explicitAuthAttempted: false, result: null };
  }

  if (!token.includes('.')) {
    return { explicitAuthAttempted: true, result: null };
  }

  try {
    const claims = await verifyJWT(token, jwtKey, jwtConfig);
    return { explicitAuthAttempted: true, result: { authenticated: true, method: 'jwt', claims } };
  } catch (error) {
    console.warn('JWT verification failed:', error instanceof Error ? error.message : error);
    return { explicitAuthAttempted: true, result: null };
  }
}

/**
 * Validate an `AuthConfig` eagerly, throwing on invalid combinations.
 * Called synchronously in `serve()` so misconfigurations fail fast.
 *
 * @example
 * ```ts
 * import { validateAuthConfig } from '@lostgradient/weft';
 *
 * // Throws if config is invalid (e.g. missing secret for HS256)
 * validateAuthConfig({
 *   apiKeys: ['secret-key-1'],
 * });
 * console.log('Config is valid');
 * ```
 */
export function validateAuthConfig(config: AuthConfig): void {
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
 * 4. mTLS (transport-level — any request that reaches the handler is authenticated)
 *
 * @example
 * ```ts
 * import { createAuthenticator } from '@lostgradient/weft';
 *
 * const authenticate = await createAuthenticator({
 *   apiKeys: ['my-secret-key'],
 * });
 * const request = new Request('http://localhost/v1/workflows', {
 *   headers: { 'X-API-Key': 'my-secret-key' },
 * });
 * const result = await authenticate(request);
 * console.log(result.authenticated); // true
 * ```
 */
export async function createAuthenticator(config: AuthConfig): Promise<Authenticator> {
  validateAuthConfig(config);

  const apiKeyEntries = config.apiKeys?.length
    ? createConstantTimeApiKeyMatcher(config.apiKeys).entries
    : null;
  const resolver = config.resolveApiKeyPrincipal;
  const defaultApiKeyScopes = config.defaultApiKeyScopes ?? [];
  const jwtKey = config.jwt ? await importJWTKey(config.jwt) : null;
  const publicPaths = new Set(config.publicPaths ?? DEFAULT_PUBLIC_PATHS);
  const auditSink: AuthAuditSink = config.auditSink ?? defaultAuthAuditSink;

  return async (request: Request): Promise<AuthResult> => {
    // Public-path bypass is not an authentication decision — no credential is
    // examined — so it is intentionally not audited.
    if (publicPaths.has(normalizeRequestPathname(request))) {
      return { authenticated: true, method: 'public' };
    }

    const apiKeyAttempt = await authenticateViaApiKey(request, {
      resolver,
      apiKeyEntries,
      defaultApiKeyScopes,
    });
    if (apiKeyAttempt.result !== null) {
      return auditDecision(auditSink, request, apiKeyAttempt.result);
    }

    const jwtAttempt = await authenticateViaJwt(request, jwtKey, config.jwt);
    if (jwtAttempt.result !== null) {
      return auditDecision(auditSink, request, jwtAttempt.result);
    }

    const explicitAuthAttempted =
      apiKeyAttempt.explicitAuthAttempted || jwtAttempt.explicitAuthAttempted;
    if (config.mtls && !explicitAuthAttempted) {
      return auditDecision(auditSink, request, { authenticated: true, method: 'mtls' });
    }

    return auditDecision(auditSink, request, {
      authenticated: false,
      error: 'No valid credentials provided',
    });
  };
}

/**
 * Emit one audit event for a finalized authentication decision and return the
 * result unchanged. Centralizes the success/failure mapping so every terminal
 * return in the authenticator is audited identically. Never logs the presented
 * credential in cleartext — only its one-way fingerprint, derived inside
 * `emitAuthAuditEvent`.
 */
function auditDecision(sink: AuthAuditSink, request: Request, result: AuthResult): AuthResult {
  if (result.authenticated) {
    emitAuthAuditEvent(sink, {
      outcome: 'success',
      method: result.method,
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
