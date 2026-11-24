import { describe, expect, test } from 'bun:test';

import { AgentCard, type SecurityRequirement, type SecurityScheme } from '@a2a-js/sdk';

import { securitySchemesFromAuthConfig } from './security-schemes.ts';

const apiKeyHeader: SecurityScheme = {
  scheme: {
    $case: 'apiKeySecurityScheme',
    value: { description: '', location: 'header', name: 'X-API-Key' },
  },
};
const plainBearer: SecurityScheme = {
  scheme: {
    $case: 'httpAuthSecurityScheme',
    value: { description: '', scheme: 'bearer', bearerFormat: '' },
  },
};
const jwtBearer: SecurityScheme = {
  scheme: {
    $case: 'httpAuthSecurityScheme',
    value: { description: '', scheme: 'bearer', bearerFormat: 'JWT' },
  },
};
const mutualTLS: SecurityScheme = {
  scheme: { $case: 'mtlsSecurityScheme', value: { description: '' } },
};

function alternatives(...names: string[]): SecurityRequirement[] {
  return names.map((name) => ({ schemes: { [name]: { list: [] } } }));
}

describe('securitySchemesFromAuthConfig', () => {
  test('maps apiKeys to an X-API-Key header scheme and a bearer scheme', () => {
    expect(securitySchemesFromAuthConfig({ apiKeys: ['key-1'] })).toEqual({
      securitySchemes: { apiKeyHeader, bearer: plainBearer },
      securityRequirements: alternatives('apiKeyHeader', 'bearer'),
    });
  });

  test('maps resolveApiKeyPrincipal like apiKeys', () => {
    expect(securitySchemesFromAuthConfig({ resolveApiKeyPrincipal: async () => null })).toEqual({
      securitySchemes: { apiKeyHeader, bearer: plainBearer },
      securityRequirements: alternatives('apiKeyHeader', 'bearer'),
    });
  });

  test('maps jwt to a bearer scheme with bearerFormat JWT', () => {
    expect(securitySchemesFromAuthConfig({ jwt: { secret: 'secret' } })).toEqual({
      securitySchemes: { bearer: jwtBearer },
      securityRequirements: alternatives('bearer'),
    });
  });

  test('maps mtls to a mutualTLS scheme when the transport verifies client certificates', () => {
    expect(
      securitySchemesFromAuthConfig(
        { mtls: { ca: 'ca', cert: 'cert', key: 'key' } },
        { transportVerifiesClientCertificates: true },
      ),
    ).toEqual({
      securitySchemes: { mutualTLS },
      securityRequirements: alternatives('mutualTLS'),
    });
  });

  test('maps mtls to a mutualTLS scheme when verifyClientCertificate supplies the evidence', () => {
    expect(
      securitySchemesFromAuthConfig({
        mtls: { ca: 'ca', cert: 'cert', key: 'key', verifyClientCertificate: () => true },
      }),
    ).toEqual({
      securitySchemes: { mutualTLS },
      securityRequirements: alternatives('mutualTLS'),
    });
  });

  test('offers no mutualTLS scheme without evidence that a client certificate is verified', () => {
    const none = { securitySchemes: {}, securityRequirements: [] };
    const listener = { ca: 'ca', cert: 'cert', key: 'key' };

    // TLS terminated outside serve(): the authenticator's evidence option defaults to false.
    expect(securitySchemesFromAuthConfig({ mtls: listener })).toEqual(none);
    expect(
      securitySchemesFromAuthConfig({ mtls: { ...listener, rejectUnauthorized: true } }),
    ).toEqual(none);
    expect(
      securitySchemesFromAuthConfig(
        { mtls: { ...listener, rejectUnauthorized: false } },
        { transportVerifiesClientCertificates: false },
      ),
    ).toEqual(none);
  });

  test('gives apiKeys and jwt together a single bearer scheme', () => {
    const declaration = securitySchemesFromAuthConfig({
      apiKeys: ['key-1'],
      jwt: { secret: 'secret' },
    });

    expect(declaration).toEqual({
      securitySchemes: { apiKeyHeader, bearer: jwtBearer },
      securityRequirements: alternatives('apiKeyHeader', 'bearer'),
    });
  });

  test('declares nothing for an empty apiKeys list', () => {
    expect(securitySchemesFromAuthConfig({ apiKeys: [] })).toEqual({
      securitySchemes: {},
      securityRequirements: [],
    });
  });

  test('serializes as the A2A 1.0.1 AgentCard fields', () => {
    const json = AgentCard.toJSON({
      ...AgentCard.fromJSON({ name: 'n' }),
      ...securitySchemesFromAuthConfig(
        { apiKeys: ['k'], mtls: { ca: 'ca', cert: 'c', key: 'k' } },
        { transportVerifiesClientCertificates: true },
      ),
    }) as Record<string, unknown>;

    expect(json['securitySchemes']).toEqual({
      apiKeyHeader: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } },
      bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } },
      mutualTLS: { mtlsSecurityScheme: {} },
    });
    // An empty scope list is the protobuf default, so it serializes as `{}`.
    expect(json['securityRequirements']).toEqual([
      { schemes: { apiKeyHeader: {} } },
      { schemes: { bearer: {} } },
      { schemes: { mutualTLS: {} } },
    ]);
  });
});
