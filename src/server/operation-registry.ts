/**
 * Operation-name validation and the typed `defineOperation` builder.
 *
 * The full list of runtime operations (workflow start/signal/update/query,
 * schedules, reviews, attributes, etc.) is populated incrementally by the
 * transport-adapter phases (Phases 9-13). This module supplies:
 *
 *   - `validateOperationName` / `isValidOperationName` — the regex that
 *     `OpenRPC` discovery and the JSON-RPC dispatcher both enforce.
 *     Operation names must follow `weft.<segment>(.<segment>)+` with
 *     lowercase ASCII segments. The form is single-source-of-truth here.
 *
 *   - `defineOperation` — a fully-typed builder that returns a concrete
 *     `OperationDefinition<Input, Output>`. Use this when authoring
 *     individual operations so the `Input`/`Output` types flow through
 *     `authorize` and `invoke` without the `as unknown as ErasedOperation`
 *     cast required at the registry boundary.
 */

import type { z } from 'zod';

import type { AuthorizationScope } from './authorization-scope.ts';
import type { AccessPolicy, ScopeRequirement } from './authorization.ts';
import {
  validateOperationName,
  type OperationDefinition,
  type TransportAvailability,
  type UnknownKeyPolicy,
} from './operation-catalog.ts';
import type { FaultCode } from './operation-fault.ts';

// Re-exported so callers that import the typed builder also get the name
// validators from the same module surface. Both import paths are
// supported, but the canonical source of truth is `operation-catalog.ts`
// — prefer importing from there for validator-only use, and from this
// module when also using `defineOperation`.
export { isValidOperationName, validateOperationName } from './operation-catalog.ts';

/**
 * Input shape for `defineOperation`. Mirrors `OperationDefinition` but
 * makes `tags` optional (default `[]`) so individual operation modules
 * stay terse.
 *
 * `authorize` is optional. When absent, the operation's `access` policy
 * is the sole authorization gate — `invoke` runs as soon as the policy
 * passes. When present, BOTH `access` AND `authorize` must permit the
 * call: the policy runs first, then the parameter-aware hook.
 */
type OperationDefinitionInputBase<Input, Output> = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly mcpTool?: OperationDefinition<Input, Output>['mcpTool'];
  readonly summary: string;
  readonly tags?: ReadonlyArray<string>;
  /**
   * Whether invoking this operation irreversibly mutates state. Required —
   * there is deliberately no default, so every operation author must make
   * the call explicitly. See {@link OperationDefinition} for the contract
   * and the consumers that read it.
   */
  readonly destructive: boolean;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly access: AccessPolicy;
  readonly producibleFaults?: ReadonlyArray<FaultCode>;
  readonly discoverable?: boolean;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: OperationDefinition<Input, Output>['authorize'];
  readonly invoke: OperationDefinition<Input, Output>['invoke'];
};

/**
 * Discriminated input for `defineOperation`, mirroring the discriminated
 * union on `OperationDefinition`. Streaming and subscription kinds REQUIRE
 * `eventSchema`; unary kinds forbid it. The compiler rejects shapes that
 * don't satisfy this constraint, eliminating the runtime EngineFailure
 * that would otherwise fire when a streaming operation tries to validate
 * elements without a schema.
 */
export type OperationDefinitionInput<Input, Output> =
  | (OperationDefinitionInputBase<Input, Output> & {
      readonly kind?: 'unary';
      readonly eventSchema?: never;
    })
  | (OperationDefinitionInputBase<Input, Output> & {
      readonly kind: 'stream';
      readonly eventSchema: z.ZodType;
    })
  | (OperationDefinitionInputBase<Input, Output> & {
      readonly kind: 'subscription';
      readonly eventSchema: z.ZodType;
    });

/**
 * Typed builder for a single operation. Validates the name at construction
 * — registration-time errors then point at the offending source line, not
 * at the eventual registry assembly. Defensively shallow-copies every
 * mutable container in the input (`tags`, `access`, `transports`,
 * `unknownKeyPolicy`) so that a caller mutating their original references
 * after this call cannot change the returned definition. The registry
 * deep-freezes these again at insertion as defense in depth.
 *
 * Returns a fully-typed `OperationDefinition<Input, Output>` so caller-
 * side `Input`/`Output` types flow through to `authorize` / `invoke`
 * without an `as` cast.
 *
 * Note: the registry re-validates `name` at assembly time. The
 * duplication is deliberate — the registry accepts any
 * `RegistrableOperation` (including hand-rolled object literals), and
 * the assembly check is the trust boundary that OpenRPC discovery and
 * JSON-RPC dispatch rely on.
 */
export function defineOperation<Input, Output>(
  input: OperationDefinitionInput<Input, Output>,
): OperationDefinition<Input, Output> {
  validateOperationName(input.name);
  // The discriminated union on the input forces `eventSchema` to match
  // `kind`. We construct the same shape on the output: streaming /
  // subscription branches carry `eventSchema`, unary does not. The
  // explicit branching is what TypeScript needs to narrow the assembled
  // object literal against the union variants.
  const baseFields = {
    name: input.name,
    mcpExposable: input.mcpExposable,
    ...(input.mcpTool === undefined
      ? {}
      : { mcpTool: { workflowType: input.mcpTool.workflowType } }),
    summary: input.summary,
    tags: [...(input.tags ?? [])],
    destructive: input.destructive,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    ...(input.producibleFaults === undefined
      ? {}
      : { producibleFaults: [...input.producibleFaults] }),
    ...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
    // Deep-copy `access` so `scoped` and `optionalAuth` variants don't
    // leak aliasing through their nested `ScopeRequirement` object and
    // `scopes` array. Without this, a caller mutating the nested scope
    // list between `defineOperation` returning and the registry running
    // `freezeAccessPolicy` could silently change the operation's
    // authorization requirements — the JSDoc's isolation promise must
    // hold from the moment the builder returns.
    access: copyAccessPolicy(input.access),
    transports: { ...input.transports },
    unknownKeyPolicy: { ...input.unknownKeyPolicy },
    ...(input.authorize === undefined ? {} : { authorize: input.authorize }),
    invoke: input.invoke,
  };
  if (input.kind === 'stream') {
    return { ...baseFields, kind: 'stream', eventSchema: input.eventSchema };
  }
  if (input.kind === 'subscription') {
    return { ...baseFields, kind: 'subscription', eventSchema: input.eventSchema };
  }
  return {
    ...baseFields,
  };
}

/**
 * Deep-copy an `AccessPolicy`. For scope-bearing variants, copies every
 * nested `ScopeRequirement` object AND its `scopes` array.
 * Mirrors `freezeAccessPolicy` in `operation-catalog.ts` but returns
 * mutable structures (the registry applies the freeze at insertion).
 */
function copyAccessPolicy(policy: AccessPolicy): AccessPolicy {
  if (policy.kind === 'scoped') {
    return {
      kind: 'scoped',
      scopes: copyScopeRequirement(policy.scopes),
    };
  }
  if (policy.kind === 'scopedAlternatives') {
    return {
      kind: 'scopedAlternatives',
      alternatives: policy.alternatives.map(copyScopeRequirement) as [
        ScopeRequirement,
        ...ScopeRequirement[],
      ],
    };
  }
  if (policy.kind === 'optionalAuth') {
    return {
      kind: 'optionalAuth',
      authenticatedScopes: copyScopeRequirement(policy.authenticatedScopes),
    };
  }
  return { ...policy };
}

function copyScopeRequirement(requirement: ScopeRequirement): ScopeRequirement {
  return {
    kind: requirement.kind,
    scopes: [...requirement.scopes] as [AuthorizationScope, ...AuthorizationScope[]],
  };
}
