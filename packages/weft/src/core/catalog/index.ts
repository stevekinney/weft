/**
 * Barrel for the durable workflow catalog (WFT-9/WFT-10).
 *
 * `WorkflowCatalog` itself and `WorkflowCatalogEntry` (which can carry a
 * live `RegisteredWorkflowDefinition` function reference) stay
 * package-internal — `core/engine/catalog-readiness.ts` and
 * `core/registry-snapshot.ts` are their only consumers. As of WFT-11,
 * `WorkflowCatalogConflictError`, `WorkflowRevisionNotInstalledError`,
 * `WorkflowCatalogActivationResult`, `WorkflowCatalogActivePointer`, and
 * `WorkflowRevisionRecord` ARE re-exported from `src/index.ts` — the public
 * promotion `engine.workflows` (`core/engine/engine-workflows-namespace.ts`)
 * throws and returns these directly.
 *
 * @module core/catalog
 */

export {
  WorkflowCatalogActivationConflictError,
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
} from './errors.ts';
export { restoreWorkflowCatalog, type RestoredWorkflowCatalogState } from './storage-io.ts';
export type {
  WorkflowCatalogActivationResult,
  WorkflowCatalogActivePointer,
  WorkflowCatalogEntry,
  WorkflowRevisionRecord,
} from './types.ts';
export { WorkflowCatalog, type ActivateCandidateOptions } from './workflow-catalog.ts';
