/**
 * Barrel for the durable workflow catalog (WFT-9/WFT-10, extended with
 * reference accounting and removal in WFT-12).
 *
 * `WorkflowCatalog` itself and `WorkflowCatalogEntry` (which can carry a
 * live `RegisteredWorkflowDefinition` function reference) stay
 * package-internal — `core/engine/catalog-readiness.ts`,
 * `core/engine/catalog-activation.ts`, `core/engine/catalog-removal.ts`, and
 * `core/registry-snapshot.ts` are their consumers. Two different public
 * surfaces are built on top: WFT-11's `engine.workflows`
 * (`core/engine/engine-workflows-namespace.ts`), which is why
 * `WorkflowCatalogConflictError`, `WorkflowRevisionNotInstalledError`,
 * `WorkflowCatalogActivationResult`, `WorkflowCatalogActivePointer`, and
 * `WorkflowRevisionRecord` ARE re-exported from `src/index.ts`; and WFT-12's
 * `removeWorkflowRevision`/`getWorkflowRevisionDiagnostics`
 * (`core/engine/catalog-removal.ts`).
 *
 * @module core/catalog
 */

export {
  WorkflowCatalogActivationConflictError,
  WorkflowCatalogActiveEntryMissingError,
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
} from './errors.ts';
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
  WorkflowRevisionRecord,
} from './types.ts';
export { WorkflowCatalog, type ActivateCandidateOptions } from './workflow-catalog.ts';
