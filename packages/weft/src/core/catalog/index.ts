/**
 * Package-internal barrel for the durable workflow catalog (WFT-9/WFT-10).
 *
 * Not re-exported from `src/index.ts` — `WorkflowCatalog` and its types stay
 * package-internal, consistent with "no public engine operations yet"
 * (WFT-11's job). `core/engine/catalog-readiness.ts` and
 * `core/registry-snapshot.ts` are this module's only consumers.
 *
 * @module core/catalog
 */

export { WorkflowCatalogActivationConflictError, WorkflowCatalogConflictError } from './errors.ts';
export { restoreWorkflowCatalog, type RestoredWorkflowCatalogState } from './storage-io.ts';
export type {
  WorkflowCatalogActivationResult,
  WorkflowCatalogActivePointer,
  WorkflowCatalogEntry,
} from './types.ts';
export { WorkflowCatalog, type ActivateCandidateOptions } from './workflow-catalog.ts';
