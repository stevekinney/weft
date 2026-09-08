/**
 * The `kind -> resolver` registry for dynamic workflow sources. A resolver's
 * only job is to turn a {@link WorkflowSourceHandle} into the raw `unknown`
 * module value its `load()` capability produces — everything downstream
 * (export lookup, definition validation, manifest building) lives in
 * `validate.ts` and is identical regardless of source kind.
 *
 * @module core/source/resolvers
 */

import type {
  WorkflowSourceDescriptor,
  WorkflowSourceHandle,
  WorkflowSourceKind,
} from './types.ts';

type SourceResolver = (handle: WorkflowSourceHandle) => Promise<unknown>;

/**
 * Resolvers by {@link WorkflowSourceKind}. `'module'` is the only entry
 * today: it simply invokes the handle's `load()` capability. A future
 * source kind registers here without touching `validate.ts` or the
 * single-flight machinery in `core/engine/source-resolution.ts`.
 */
const SOURCE_RESOLVERS: Readonly<Partial<Record<WorkflowSourceKind, SourceResolver>>> =
  Object.freeze({
    module: async (handle) => handle.load(),
  });

/** The outcome of {@link resolveSourceModule}: either the raw loaded module value, or a short-circuit rejection reason. */
export type ResolveSourceModuleResult =
  | { readonly ok: true; readonly moduleValue: unknown }
  | { readonly ok: false; readonly reason: 'unregistered-source-kind' };

/**
 * Look up the resolver registered for `descriptor.kind` and invoke it
 * against `handle` to produce the raw, untrusted module value. Returns
 * `{ ok: false, reason: 'unregistered-source-kind' }` when no resolver is
 * registered for that kind — unreachable through `workflowSource()`'s own
 * typed surface today (`WorkflowSourceKind` is the single literal
 * `'module'`), but a manually-constructed handle can still name an
 * unsupported kind, so this stays a checked, structured rejection rather
 * than an unhandled throw — the same "unreachable through the type-safe
 * surface, exists for hostile/manually-constructed input" precedent as
 * `manifest-version-unsupported` in `core/contract/compatibility.ts`.
 *
 * @example
 * ```ts
 * import { workflowSource } from '@lostgradient/weft';
 *
 * declare const loadCheckout: () => Promise<{
 *   checkout: import('@lostgradient/weft').WorkflowDefinition<unknown, unknown, 'checkout'>;
 * }>;
 * const source = workflowSource(
 *   { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
 *   loadCheckout,
 * );
 * console.log(source.descriptor.kind);
 * ```
 */
export async function resolveSourceModule(
  descriptor: WorkflowSourceDescriptor,
  handle: WorkflowSourceHandle,
): Promise<ResolveSourceModuleResult> {
  const resolver = SOURCE_RESOLVERS[descriptor.kind];
  if (resolver === undefined) {
    return { ok: false, reason: 'unregistered-source-kind' };
  }
  const moduleValue = await resolver(handle);
  return { ok: true, moduleValue };
}
