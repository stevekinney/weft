/**
 * Derive an A2A Agent Card's `securitySchemes` and `securityRequirements` from the
 * {@link AuthConfig} a Weft server authenticates with, so the card advertises exactly
 * the credentials the server accepts.
 *
 * @module a2a/security-schemes
 */

import type { AgentCard, SecurityRequirement, SecurityScheme } from '@a2a-js/sdk';

import type { AuthConfig } from "../embedded/backchannel/src/index.ts";

/** The two A2A 1.0.1 `AgentCard` fields {@link securitySchemesFromAuthConfig} returns. */
export type A2ASecurityDeclaration = Pick<AgentCard, 'securitySchemes' | 'securityRequirements'>;

/**
 * The parts of an {@link AuthConfig} that decide which credentials a Weft server
 * accepts. The rest of the configuration (keys, secrets, audit sinks) never reaches
 * the card.
 */
export type A2AAuthConfigShape = Pick<
  AuthConfig,
  'apiKeys' | 'resolveApiKeyPrincipal' | 'jwt' | 'mtls'
>;

/** Transport facts {@link securitySchemesFromAuthConfig} cannot read from an `AuthConfig`. */
export type A2ASecurityTransportEvidence = {
  /**
   * The value the server's authenticator was created with as
   * `CreateAuthenticatorOptions.transportVerifiesClientCertificates`: whether the
   * listener refuses every connection without a verified client certificate. `serve()`
   * derives it from its own TLS options; leave it unset whenever TLS terminates
   * anywhere else.
   */
  readonly transportVerifiesClientCertificates?: boolean;
};

/** Whether Weft's authenticator could admit anyone by client certificate. */
function mtlsCanAdmit(
  authConfig: A2AAuthConfigShape,
  transport: A2ASecurityTransportEvidence,
): boolean {
  const mtls = authConfig.mtls;
  if (mtls === undefined) return false;
  return (
    mtls.verifyClientCertificate !== undefined ||
    transport.transportVerifiesClientCertificates === true
  );
}

/**
 * Map a Weft {@link AuthConfig} onto the A2A security declaration of an Agent Card.
 *
 * - `apiKeys` or `resolveApiKeyPrincipal` → `apiKeyHeader` (an `apiKey` scheme in the
 *   `X-API-Key` header) and `bearer` (an `http` scheme with scheme `bearer`), because
 *   Weft accepts an API key in either place.
 * - `jwt` → `bearer` with `bearerFormat: "JWT"`. With API keys as well, the two share
 *   the single `bearer` scheme.
 * - `mtls` → `mutualTLS`, only when there is evidence that a client certificate is
 *   verified: a `verifyClientCertificate` callback, or
 *   `transport.transportVerifiesClientCertificates`. Weft's authenticator admits a
 *   caller by certificate on exactly that evidence and on nothing else, so without
 *   it the card does not offer a scheme no one could use.
 *
 * `securityRequirements` lists each scheme as its own alternative: any one of them
 * admits a caller.
 *
 * @example
 * ```ts
 * import { securitySchemesFromAuthConfig } from '@lostgradient/weft/a2a';
 *
 * const { securitySchemes, securityRequirements } = securitySchemesFromAuthConfig({
 *   apiKeys: ['key-1'],
 * });
 * ```
 */
export function securitySchemesFromAuthConfig(
  authConfig: A2AAuthConfigShape,
  transport: A2ASecurityTransportEvidence = {},
): A2ASecurityDeclaration {
  const securitySchemes: Record<string, SecurityScheme> = {};
  const acceptsApiKeys =
    (authConfig.apiKeys !== undefined && authConfig.apiKeys.length > 0) ||
    authConfig.resolveApiKeyPrincipal !== undefined;

  if (acceptsApiKeys) {
    securitySchemes['apiKeyHeader'] = {
      scheme: {
        $case: 'apiKeySecurityScheme',
        value: { description: '', location: 'header', name: 'X-API-Key' },
      },
    };
  }
  if (acceptsApiKeys || authConfig.jwt !== undefined) {
    securitySchemes['bearer'] = {
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: {
          description: '',
          scheme: 'bearer',
          bearerFormat: authConfig.jwt === undefined ? '' : 'JWT',
        },
      },
    };
  }
  if (mtlsCanAdmit(authConfig, transport)) {
    securitySchemes['mutualTLS'] = {
      scheme: { $case: 'mtlsSecurityScheme', value: { description: '' } },
    };
  }

  const securityRequirements: SecurityRequirement[] = Object.keys(securitySchemes).map((name) => ({
    schemes: { [name]: { list: [] } },
  }));
  return { securitySchemes, securityRequirements };
}
