/**
 * Canonical discovery-document metadata for operation access policies.
 *
 * @module server/access-policy-metadata
 */
import { z } from 'zod';

import type { AccessPolicy, ScopeRequirement } from './authorization.ts';
import { compareStrings } from './json-schema-utilities.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';

export const ScopeRequirementMetadataSchema = z.strictObject({
  kind: z.enum(['anyOf', 'allOf']),
  scopes: z.array(z.string()).min(1),
});

export const AccessPolicyMetadataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public') }),
  z.strictObject({ kind: z.literal('authenticated') }),
  z.strictObject({
    kind: z.literal('scoped'),
    scopes: ScopeRequirementMetadataSchema,
  }),
  z.strictObject({
    kind: z.literal('optionalAuth'),
    authenticatedScopes: ScopeRequirementMetadataSchema,
  }),
  z.strictObject({
    kind: z.literal('scopedAlternatives'),
    alternatives: z.array(ScopeRequirementMetadataSchema).min(1),
  }),
]);

export const ParameterizedAccessMetadataSchema = z.strictObject({
  discriminator: z.string(),
  defaultValue: z.string().optional(),
  variants: z.array(
    z.strictObject({
      value: z.string(),
      access: AccessPolicyMetadataSchema,
    }),
  ),
});

export type AccessPolicyMetadata = z.infer<typeof AccessPolicyMetadataSchema>;
export type ParameterizedAccessMetadata = z.infer<typeof ParameterizedAccessMetadataSchema>;
type ScopeRequirementMetadata = z.infer<typeof ScopeRequirementMetadataSchema>;

/** Serialize an operation's static access policy for discovery documents. */
export function serializeAccessPolicy(policy: AccessPolicy): AccessPolicyMetadata {
  switch (policy.kind) {
    case 'public':
      return { kind: 'public' };
    case 'authenticated':
      return { kind: 'authenticated' };
    case 'scoped':
      return { kind: 'scoped', scopes: serializeScopeRequirement(policy.scopes) };
    case 'optionalAuth':
      return {
        kind: 'optionalAuth',
        authenticatedScopes: serializeScopeRequirement(policy.authenticatedScopes),
      };
    case 'scopedAlternatives':
      return {
        kind: 'scopedAlternatives',
        alternatives: policy.alternatives.map(serializeScopeRequirement),
      };
    default:
      return unsupportedAccessPolicy(policy);
  }
}

/** Serialize discriminator-specific access overrides for discovery documents. */
export function serializeParameterizedAccess(
  hint: ParameterizedAccessHint,
): ParameterizedAccessMetadata {
  return {
    discriminator: hint.discriminator,
    ...(hint.defaultValue === undefined ? {} : { defaultValue: hint.defaultValue }),
    variants: hint.variants.map((variant) => ({
      value: variant.value,
      access: serializeAccessPolicy(variant.access),
    })),
  };
}

function serializeScopeRequirement(requirement: ScopeRequirement): ScopeRequirementMetadata {
  switch (requirement.kind) {
    case 'anyOf':
    case 'allOf':
      return {
        kind: requirement.kind,
        scopes: [...requirement.scopes].toSorted(compareStrings),
      };
    default:
      return unsupportedScopeRequirement(requirement);
  }
}

function unsupportedAccessPolicy(policy: never): never {
  throw new Error(`cannot serialize unsupported access policy: ${String(policy)}`);
}

function unsupportedScopeRequirement(requirement: never): never {
  throw new Error(`cannot serialize unsupported scope requirement: ${String(requirement)}`);
}
