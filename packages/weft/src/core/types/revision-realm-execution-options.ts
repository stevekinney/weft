/**
 * `EngineOptions.revisionRealmExecution` (COR-249's engine integration).
 * Extracted from `options.ts` to keep that file under the repository's
 * file-size ceiling, mirroring `WorkerExecutionDisposal`'s own extraction
 * from `WorkerExecutionStrategy` for the same reason.
 *
 * @module core/types/revision-realm-execution-options
 */

import type { RevisionRealmConfig } from '../realm/revision-realm-registry.ts';

/**
 * Enable revision-realm workflow execution (COR-249's engine integration).
 * Required when `workflowExecutionMode: 'realm'`; rejected otherwise, and
 * mutually exclusive with `workerExecution`.
 *
 * Weft cannot honestly derive a per-revision Worker bootstrap URL from a
 * `registerSource()` descriptor's `location` — that field is a host loader
 * specifier, never parsed or resolved by this package (see {@link
 * import('./options.ts').EngineOptions.workerExecution}'s sibling doc and
 * {@link import('../source/types.ts').WorkflowSourceDescriptor.location}'s
 * own doc) — so the realm bootstrap for each `(name, revision)` is supplied
 * explicitly here instead, mirroring `workerExecution.workerUrl`'s own
 * explicit-URL shape.
 */
export interface RevisionRealmExecutionOptions {
  /**
   * Resolve the {@link RevisionRealmConfig} (worker URL, expected workflow
   * types, optional artifact digest, pool sizing) for one `(workflowType,
   * revision)`. Called at most once per `(workflowType, revision)` — the
   * result is cached by the underlying registry's pool, matching
   * `RevisionRealmRegistry.ensurePool`'s own "config is only consulted on
   * first creation" contract.
   *
   * Returning `undefined` refuses routing a start to that revision (the
   * workflow fails with a clear, bounded error) rather than silently
   * falling back to another execution mode.
   */
  resolveRevisionRealmConfig: (
    workflowType: string,
    revision: string,
  ) => RevisionRealmConfig | undefined;
}
