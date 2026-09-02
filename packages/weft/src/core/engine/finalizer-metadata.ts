/**
 * Project a registration's stored definition-level finalizer onto the
 * public, schema-only shape {@link RegisteredWorkflowDefinition.finalizer}
 * exposes — split out of `construction.ts` so `copyWorkflowDefinition` stays
 * under the repository's per-function complexity ceiling.
 *
 * @module core/engine/finalizer-metadata
 */

import type { AnyActivityDefinition, DefinitionSchema } from '../types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';

/**
 * `RegistrationEntry.finalizer` is typed as the narrow `AnyActivityDefinition`
 * (name + callable signature only), but the real activity object stored
 * there (built by the `activity()` helper) always carries `inputSchema`/
 * `outputSchema` as own properties too — the same structural gap
 * `WorkflowContractActivitySource` documents in `core/contract/types.ts`.
 */
type FinalizerSchemaSource = {
  readonly name: string;
  readonly inputSchema?: DefinitionSchema;
  readonly outputSchema?: DefinitionSchema;
};

/**
 * Convert a stored `RegistrationEntry.finalizer` (when present) to a
 * directly spreadable `{ finalizer: {...} } | {}` carrying the narrower
 * schema-only shape `RegisteredWorkflowDefinition.finalizer` exposes — never
 * the finalizer's `execute` handler, matching this interface's read-only
 * introspection contract (the workflow's own handler is likewise never
 * exposed). Returning the already-branched spread target (rather than
 * `finalizer | undefined`, which would push a `=== undefined` ternary back
 * onto the caller) keeps `copyWorkflowDefinition` under the repository's
 * per-function complexity ceiling.
 */
export function copyFinalizerMetadata(
  finalizer: AnyActivityDefinition | undefined,
): Partial<Pick<RegisteredWorkflowDefinition, 'finalizer'>> {
  if (finalizer === undefined) return {};
  const source = finalizer as FinalizerSchemaSource;
  return {
    finalizer: {
      name: source.name,
      ...(source.inputSchema === undefined ? {} : { inputSchema: source.inputSchema }),
      ...(source.outputSchema === undefined ? {} : { outputSchema: source.outputSchema }),
    },
  };
}
