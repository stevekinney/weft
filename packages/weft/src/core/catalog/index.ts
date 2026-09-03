/**
 * Package-internal barrel for the durable workflow catalog (WFT-9/WFT-10,
 * extended with reference accounting and removal in WFT-12).
 *
 * Not re-exported from `src/index.ts` — `WorkflowCatalog` and its types stay
 * package-internal; `removeWorkflowRevision`/`getWorkflowRevisionDiagnostics`
 * (built on top of this module, in `core/engine/catalog-removal.ts`) are the
 * public surface instead. `core/engine/catalog-readiness.ts`,
 * `core/engine/catalog-activation.ts`, `core/engine/catalog-removal.ts`, and
 * `core/registry-snapshot.ts` are this module's consumers.
 *
 * @module core/catalog
 */

export { WorkflowCatalogActivationConflictError, WorkflowCatalogConflictError } from './errors.ts';
export {
  decrementNestedRevisionCount,
  incrementNestedRevisionCount,
  readNestedRevisionCount,
  totalWorkflowRevisionReferences,
  type WorkflowRevisionReferenceCounts,
} from './reference-counts.ts';
export { removeCatalogEntry, type WorkflowCatalogRemovalOutcome } from './removal.ts';
export { restoreWorkflowCatalog, type RestoredWorkflowCatalogState } from './storage-io.ts';
export type {
  WorkflowCatalogActivationResult,
  WorkflowCatalogActivePointer,
  WorkflowCatalogEntry,
} from './types.ts';
export { WorkflowCatalog, type ActivateCandidateOptions } from './workflow-catalog.ts';
