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

import type { AccessPolicy } from './authorization.ts';
import {
  validateOperationName,
  type OperationDefinition,
  type TransportAvailability,
  type UnknownKeyPolicy,
} from './operation-catalog.ts';

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
export type OperationDefinitionInput<Input, Output> = {
  readonly name: string;
  readonly summary: string;
  readonly tags?: ReadonlyArray<string>;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: OperationDefinition<Input, Output>['authorize'];
  readonly invoke: OperationDefinition<Input, Output>['invoke'];
};

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
  return {
    name: input.name,
    summary: input.summary,
    tags: [...(input.tags ?? [])],
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    // Shallow-copy each policy container. `access`'s nested
    // `ScopeRequirement.scopes` array is left to the registry's
    // `freezeAccessPolicy` to deep-handle — a builder-side recursive
    // copy would duplicate that work.
    access: { ...input.access },
    transports: { ...input.transports },
    unknownKeyPolicy: { ...input.unknownKeyPolicy },
    ...(input.authorize === undefined ? {} : { authorize: input.authorize }),
    invoke: input.invoke,
  };
}
