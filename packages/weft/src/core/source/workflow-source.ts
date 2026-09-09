/**
 * `workflowSource()` — the typed factory pairing a serializable
 * {@link WorkflowSourceDescriptor} with a host-side loader capability.
 *
 * @module core/source/workflow-source
 */

import type {
  InputOf,
  IsAny,
  ModuleWorkflowDefinition,
  NameOf,
  OutputOf,
  ServicesOf,
  WorkflowSourceDescriptorInput,
  WorkflowSourceHandle,
  WorkflowSourceKind,
} from './types.ts';

const DEFAULT_WORKFLOW_SOURCE_KIND: WorkflowSourceKind = 'module';

/**
 * Build a typed {@link WorkflowSourceHandle} from a `descriptor` and a
 * `loader` capability. The loader is stored on the returned handle
 * unchanged (identity, not wrapped) and is never invoked by this function —
 * `workflowSource()` is pure construction, matching `engine.registerSource()`'s
 * own "records a candidate, never imports" contract one level up.
 *
 * `loader` must be a literal `() => import('./x.ts')` (or an equivalent
 * statically-typed async function) for `TInput`/`TOutput`/`TName`/`TServices`
 * to infer from the module's real export types. A dynamic import
 * (`() => import(pathVariable)`, typed `Promise<any>`) is rejected at the
 * type level via `descriptor`'s `IsAny<TModule> extends true ? never : ...`
 * guard — see `workflow-source.test-d.ts`.
 *
 * `descriptor.location` is carried verbatim into the returned handle and
 * never read, parsed, or concatenated by this function or any other
 * `core/source/**` module — there is no timestamp-query-string or
 * cache-busting mechanism anywhere in this package; single-flight
 * deduplication in `resolveWorkflowSource` is keyed by `(name, revision)`,
 * not by `location`.
 *
 * @example
 * ```ts
 * import { workflowSource } from '@lostgradient/weft';
 *
 * declare const loadCheckout: () => Promise<{
 *   checkout: import('@lostgradient/weft').WorkflowDefinition<{ orderId: string }, { shipped: boolean }, 'checkout'>;
 * }>;
 * const source = workflowSource(
 *   { name: 'checkout', location: './workflows/checkout.ts', exportName: 'checkout', revision: 'r1' },
 *   loadCheckout,
 * );
 * console.log(source.descriptor.kind);
 * ```
 */
export function workflowSource<
  TModule extends Record<string, unknown>,
  TExportName extends keyof TModule & string,
>(
  descriptor: IsAny<TModule> extends true ? never : WorkflowSourceDescriptorInput<TExportName>,
  loader: () => Promise<TModule>,
): WorkflowSourceHandle<
  InputOf<ModuleWorkflowDefinition<TModule, TExportName>>,
  OutputOf<ModuleWorkflowDefinition<TModule, TExportName>>,
  NameOf<ModuleWorkflowDefinition<TModule, TExportName>>,
  ServicesOf<ModuleWorkflowDefinition<TModule, TExportName>>
> {
  const input = descriptor;
  return Object.freeze({
    descriptor: Object.freeze({
      kind: input.kind ?? DEFAULT_WORKFLOW_SOURCE_KIND,
      name: input.name,
      location: input.location,
      exportName: input.exportName,
      revision: input.revision,
      ...(input.workflowVersion === undefined ? {} : { workflowVersion: input.workflowVersion }),
      ...(input.contractHash === undefined ? {} : { contractHash: input.contractHash }),
    }),
    load: loader,
  });
}
