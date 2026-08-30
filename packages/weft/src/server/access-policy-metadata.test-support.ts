/**
 * Shared access-policy discovery fixtures for OpenAPI and OpenRPC tests.
 * The `.test-support.ts` suffix excludes this module from production builds.
 */
import type { AccessPolicy } from './authorization.ts';
import type { ParameterizedAccessHint } from './operation-catalog.ts';

export type AccessPolicyMetadataExample = {
  readonly segment: string;
  readonly access: AccessPolicy;
  readonly expected: Record<string, unknown>;
};

export const accessPolicyMetadataExamples: ReadonlyArray<AccessPolicyMetadataExample> = [
  { segment: 'public', access: { kind: 'public' }, expected: { kind: 'public' } },
  {
    segment: 'authenticated',
    access: { kind: 'authenticated' },
    expected: { kind: 'authenticated' },
  },
  {
    segment: 'anyof',
    access: {
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['workflows:write', 'workflows:read'] },
    },
    expected: {
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['workflows:read', 'workflows:write'] },
    },
  },
  {
    segment: 'allof',
    access: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['workflows:admin', 'workflows:read'] },
    },
    expected: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['workflows:admin', 'workflows:read'] },
    },
  },
  {
    segment: 'optional',
    access: {
      kind: 'optionalAuth',
      authenticatedScopes: { kind: 'anyOf', scopes: ['events:read'] },
    },
    expected: {
      kind: 'optionalAuth',
      authenticatedScopes: { kind: 'anyOf', scopes: ['events:read'] },
    },
  },
  {
    segment: 'alternatives',
    access: {
      kind: 'scopedAlternatives',
      alternatives: [
        { kind: 'allOf', scopes: ['workflows:write', 'workflows:read'] },
        { kind: 'anyOf', scopes: ['workflows:admin'] },
      ],
    },
    expected: {
      kind: 'scopedAlternatives',
      alternatives: [
        { kind: 'allOf', scopes: ['workflows:read', 'workflows:write'] },
        { kind: 'anyOf', scopes: ['workflows:admin'] },
      ],
    },
  },
];

export const parameterizedAccessMetadataExample: ParameterizedAccessHint = {
  discriminator: 'mode',
  defaultValue: 'events',
  variants: [
    {
      value: 'events',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
    },
    {
      value: 'tokens',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
    },
  ],
};

export const expectedParameterizedAccessMetadata = {
  discriminator: 'mode',
  defaultValue: 'events',
  variants: [
    {
      value: 'events',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
    },
    {
      value: 'tokens',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
    },
  ],
};
