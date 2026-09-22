import type { AccessPolicy, ScopeRequirement } from '../authorization.ts';
import type { OperationDefinitionBase, ParameterizedAccessHint } from './types.ts';

type OperationMetadata = Omit<OperationDefinitionBase<unknown, unknown>, 'authorize'>;

/** Select metadata explicitly, so registry entries never expose authoring callbacks. */
export function snapshotOperationMetadata(operation: OperationMetadata): OperationMetadata {
  return Object.freeze({
    name: operation.name,
    mcpExposable: operation.mcpExposable,
    summary: operation.summary,
    destructive: operation.destructive,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    tags: frozenArray(operation.tags),
    access: freezeAccessPolicy(operation.access),
    transports: frozenRecord(operation.transports),
    unknownKeyPolicy: frozenRecord(operation.unknownKeyPolicy),
    ...optionalMetadata(operation),
  });
}

function optionalMetadata(operation: OperationMetadata) {
  return {
    ...(operation.description === undefined ? {} : { description: operation.description }),
    ...(operation.discoverable === undefined ? {} : { discoverable: operation.discoverable }),
    ...(operation.mcpTool === undefined ? {} : { mcpTool: frozenRecord(operation.mcpTool) }),
    ...(operation.producibleFaults === undefined
      ? {}
      : { producibleFaults: frozenArray(operation.producibleFaults) }),
    ...(operation.parameterizedAccess === undefined
      ? {}
      : { parameterizedAccess: freezeParameterizedAccess(operation.parameterizedAccess) }),
  };
}

function frozenArray<Value>(values: ReadonlyArray<Value>): ReadonlyArray<Value> {
  return Object.isFrozen(values) ? values : Object.freeze([...values]);
}

function frozenRecord<Value extends object>(value: Value): Readonly<Value> {
  return Object.isFrozen(value) ? value : Object.freeze({ ...value });
}

function freezeAccessPolicy(policy: AccessPolicy): AccessPolicy {
  if (policy.kind === 'scoped') {
    const scopes = freezeScopeRequirement(policy.scopes);
    return Object.isFrozen(policy) && scopes === policy.scopes
      ? policy
      : Object.freeze({ kind: policy.kind, scopes });
  }
  if (policy.kind === 'scopedAlternatives') return freezeAlternatives(policy);
  if (policy.kind === 'optionalAuth') {
    const authenticatedScopes = freezeScopeRequirement(policy.authenticatedScopes);
    return Object.isFrozen(policy) && authenticatedScopes === policy.authenticatedScopes
      ? policy
      : Object.freeze({ kind: policy.kind, authenticatedScopes });
  }
  return frozenRecord(policy);
}

function freezeAlternatives(
  policy: Extract<AccessPolicy, { kind: 'scopedAlternatives' }>,
): AccessPolicy {
  const alternatives = policy.alternatives.map(freezeScopeRequirement);
  if (
    Object.isFrozen(policy) &&
    Object.isFrozen(policy.alternatives) &&
    alternatives.every((alternative, index) => alternative === policy.alternatives[index])
  )
    return policy;
  return Object.freeze({ kind: policy.kind, alternatives: frozenNonEmpty(alternatives) });
}

function freezeScopeRequirement(requirement: ScopeRequirement): ScopeRequirement {
  if (Object.isFrozen(requirement) && Object.isFrozen(requirement.scopes)) return requirement;
  return Object.freeze({ kind: requirement.kind, scopes: frozenNonEmpty(requirement.scopes) });
}

function frozenNonEmpty<Value>(values: readonly Value[]): readonly [Value, ...Value[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('expected a non-empty collection');
  return Object.freeze([first, ...rest]);
}

function freezeParameterizedAccess(hint: ParameterizedAccessHint): ParameterizedAccessHint {
  const variants = hint.variants.map((variant) => {
    const access = freezeAccessPolicy(variant.access);
    return Object.isFrozen(variant) && access === variant.access
      ? variant
      : Object.freeze({ value: variant.value, access });
  });
  if (
    Object.isFrozen(hint) &&
    Object.isFrozen(hint.variants) &&
    variants.every((variant, index) => variant === hint.variants[index])
  )
    return hint;
  return Object.freeze({
    discriminator: hint.discriminator,
    ...(hint.defaultValue === undefined ? {} : { defaultValue: hint.defaultValue }),
    variants: Object.freeze(variants),
  });
}
