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
// validators from the same module surface.
export { isValidOperationName, validateOperationName } from './operation-catalog.ts';

/**
 * Input shape for `defineOperation`. Mirrors `OperationDefinition` but
 * makes `tags` optional (default `[]`) so individual operation modules
 * stay terse.
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
 * (so registration-time errors point at the offending source line, not the
 * eventual registry assembly) and returns a fully-typed
 * `OperationDefinition<Input, Output>` — caller-side `Input`/`Output`
 * types flow through to `authorize` / `invoke` without an `as` cast.
 */
export function defineOperation<Input, Output>(
  input: OperationDefinitionInput<Input, Output>,
): OperationDefinition<Input, Output> {
  validateOperationName(input.name);
  return {
    name: input.name,
    summary: input.summary,
    // Shallow-copy the tags array so a later mutation of the caller's array
    // can't change a registered operation's metadata (defensive against
    // external aliasing).
    tags: [...(input.tags ?? [])],
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    access: input.access,
    transports: input.transports,
    unknownKeyPolicy: input.unknownKeyPolicy,
    ...(input.authorize === undefined ? {} : { authorize: input.authorize }),
    invoke: input.invoke,
  };
}
