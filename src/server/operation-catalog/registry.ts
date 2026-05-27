import { z } from 'zod';

import type { AuthorizationScope } from '../authorization-scope.ts';
import type { AccessPolicy, ScopeRequirement } from '../authorization.ts';
import { UNSAFE_PROTOTYPE_KEYS } from './pipeline-helpers.ts';
import {
  type ErasedOperation,
  type OperationRegistry,
  type RegistrableOperation,
  validateOperationName,
} from './types.ts';

/**
 * Recursively freeze an `AccessPolicy`. The scope-bearing variants nest
 * `ScopeRequirement` objects whose `scopes` arrays are themselves mutable.
 */
function freezeAccessPolicy(policy: AccessPolicy): AccessPolicy {
  if (policy.kind === 'scoped') {
    return Object.freeze({
      kind: 'scoped',
      scopes: freezeScopeRequirement(policy.scopes),
    }) as AccessPolicy;
  }
  if (policy.kind === 'scopedAlternatives') {
    return Object.freeze({
      kind: 'scopedAlternatives',
      alternatives: Object.freeze(policy.alternatives.map(freezeScopeRequirement)) as [
        ScopeRequirement,
        ...ScopeRequirement[],
      ],
    }) as AccessPolicy;
  }
  if (policy.kind === 'optionalAuth') {
    return Object.freeze({
      kind: 'optionalAuth',
      authenticatedScopes: freezeScopeRequirement(policy.authenticatedScopes),
    }) as AccessPolicy;
  }
  return Object.freeze({ ...policy });
}

function freezeScopeRequirement(requirement: ScopeRequirement): ScopeRequirement {
  const scopes = Object.freeze([...requirement.scopes]) as [
    AuthorizationScope,
    ...AuthorizationScope[],
  ];
  return Object.freeze({
    kind: requirement.kind,
    scopes,
  }) as ScopeRequirement;
}

function objectInputSchema(operation: RegistrableOperation): z.ZodObject {
  if (!(operation.inputSchema instanceof z.ZodObject)) {
    throw new Error(
      `operation "${operation.name}" inputSchema must be a z.ZodObject (got ${operation.inputSchema.constructor.name}); wrappers like .optional() / transforms hide the top-level shape from the unknown-key policy check`,
    );
  }
  return operation.inputSchema;
}

function assertSafeDeclaredKeys(operation: RegistrableOperation): void {
  const inputSchema = objectInputSchema(operation);
  const declaredKeys = Object.keys(inputSchema.shape);
  const unsafeDeclared = declaredKeys.filter((key) => UNSAFE_PROTOTYPE_KEYS.has(key));
  if (unsafeDeclared.length > 0) {
    throw new Error(
      `operation "${operation.name}" inputSchema declares unsafe top-level keys: ${unsafeDeclared.join(', ')}. Names that match a prototype-pollution vector (__proto__, constructor, prototype) are forbidden as schema keys.`,
    );
  }
}

/**
 * Mirror the `OperationDefinition` discriminated union at runtime:
 * `kind: 'stream'` and `kind: 'subscription'` MUST carry an `eventSchema`,
 * and `kind: 'unary'` (or absent) MUST NOT. The TypeScript discriminated
 * union enforces this for callers using `defineOperation`, but
 * `createOperationRegistry` accepts any `RegistrableOperation`-shaped
 * value — including hand-rolled object literals constructed in test
 * fixtures or third-party adapters that bypass `defineOperation`. Without
 * this assertion a malformed registry would produce a runtime
 * `EngineFailure` only on the first request, not at registry assembly.
 */
function assertKindAndEventSchemaAgree(operation: RegistrableOperation): void {
  const kind = operation.kind ?? 'unary';
  if (kind === 'unary') {
    if (operation.eventSchema !== undefined) {
      throw new Error(
        `operation "${operation.name}" has kind: 'unary' (or unset) but declares an eventSchema. eventSchema is reserved for kind: 'stream' or kind: 'subscription'.`,
      );
    }
    return;
  }
  if (operation.eventSchema === undefined) {
    throw new Error(
      `operation "${operation.name}" has kind: '${kind}' but no eventSchema. Stream and subscription operations must declare an eventSchema so the dispatcher can validate each yielded element.`,
    );
  }
}

/**
 * Mirror the required `destructive` field at runtime. The TypeScript type
 * forces every `defineOperation` caller to declare it, but
 * `createOperationRegistry` accepts any `RegistrableOperation`-shaped value —
 * including hand-rolled object literals from test fixtures or third-party
 * adapters that bypass `defineOperation`. A missing or non-boolean
 * `destructive` would let an operation slip past the explicit-declaration
 * quality floor that the CLI confirmation gate, dashboard bulk-action
 * confirmations, and MCP exposure all depend on. Reject at assembly so the
 * error points at the registry, not at the first request.
 */
function assertDestructiveDeclared(operation: RegistrableOperation): void {
  if (typeof operation.destructive !== 'boolean') {
    throw new Error(
      `operation "${operation.name}" must declare an explicit boolean "destructive" flag (got ${typeof operation.destructive}). Every operation has to state whether it irreversibly mutates state — there is no implicit default. Mark cancel/purge/bulk-delete/raw-storage-write style operations true and read-only operations false.`,
    );
  }
}

function assertMcpMetadataAgrees(operation: RegistrableOperation): void {
  if (!operation.mcpExposable) return;
  if (operation.mcpTool === undefined) {
    throw new Error(
      `operation "${operation.name}" is mcpExposable but does not declare mcpTool.workflowType metadata`,
    );
  }
}

function freezeOperation(operation: RegistrableOperation): ErasedOperation {
  return Object.freeze({
    ...operation,
    tags: Object.freeze([...operation.tags]),
    ...(operation.producibleFaults === undefined
      ? {}
      : { producibleFaults: Object.freeze([...operation.producibleFaults]) }),
    access: freezeAccessPolicy(operation.access),
    ...(operation.mcpTool === undefined
      ? {}
      : { mcpTool: Object.freeze({ workflowType: operation.mcpTool.workflowType }) }),
    transports: Object.freeze({ ...operation.transports }),
    unknownKeyPolicy: Object.freeze({ ...operation.unknownKeyPolicy }),
  }) as ErasedOperation;
}

/**
 * Build an immutable registry. Throws on duplicate names, invalid names,
 * non-object input schemas, and unsafe top-level schema keys.
 */
export function createOperationRegistry(
  operations: ReadonlyArray<RegistrableOperation>,
): OperationRegistry {
  const byName = new Map<string, ErasedOperation>();
  for (const operation of operations) {
    if (byName.has(operation.name)) {
      throw new Error(`duplicate operation name in registry: ${operation.name}`);
    }
    validateOperationName(operation.name);
    assertSafeDeclaredKeys(operation);
    assertKindAndEventSchemaAgree(operation);
    assertDestructiveDeclared(operation);
    assertMcpMetadataAgrees(operation);
    byName.set(operation.name, freezeOperation(operation));
  }
  const ordered = Object.freeze([...byName.values()]);
  return {
    get(name) {
      return byName.get(name);
    },
    list() {
      return ordered;
    },
  };
}
