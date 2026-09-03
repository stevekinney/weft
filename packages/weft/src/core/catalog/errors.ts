/**
 * Error classes thrown by the durable workflow catalog (WFT-9/WFT-10).
 *
 * Both errors carry internal codes deliberately absent from the public
 * `WeftErrorCode` union — the catalog is package-internal (`core/catalog/**`
 * is not re-exported from `src/index.ts`), so its error classes follow the
 * same "internal code, not registered in `publicWeftErrorCodeMap`" pattern
 * `AtomicStateConflictError`'s sibling internal errors use elsewhere in the
 * engine.
 *
 * @module core/catalog/errors
 */

import { WeftError } from '../weft-error.ts';

/**
 * Thrown by {@link import('./workflow-catalog.ts').WorkflowCatalog.install}
 * when a caller attempts to install a `(name, revision)` pair that already
 * has a durably- or in-memory-installed entry with different manifest bytes.
 * A byte-identical reinstall for the same key is a no-op, not an error — see
 * `install()`'s JSDoc.
 */
export class WorkflowCatalogConflictError extends WeftError<'WorkflowCatalogConflictError'> {
  readonly workflowName: string;
  readonly revision: string;

  constructor(workflowName: string, revision: string) {
    super(
      'WorkflowCatalogConflictError',
      `Workflow catalog entry "${workflowName}" revision "${revision}" is already installed with ` +
        'different contract metadata. A revision identity must be immutable once installed — ' +
        'register a workflow whose contract content differs under a new revision instead of ' +
        'reusing this one.',
    );
    this.workflowName = workflowName;
    this.revision = revision;
  }
}

/**
 * Thrown by
 * {@link import('./workflow-catalog.ts').WorkflowCatalog.activateRegistered}
 * after its bounded 5-attempt CAS retry loop exhausts without successfully
 * committing the active pointer — mirrors `AtomicStateConflictError`'s
 * exhaustion contract.
 */
export class WorkflowCatalogActivationConflictError extends WeftError<'WorkflowCatalogActivationConflictError'> {
  readonly workflowName: string;
  readonly attempts: number;

  constructor(workflowName: string, attempts: number) {
    super(
      'WorkflowCatalogActivationConflictError',
      `Workflow catalog activation conflict: failed to activate "${workflowName}" after ` +
        `${String(attempts)} attempts due to sustained concurrent writers.`,
    );
    this.workflowName = workflowName;
    this.attempts = attempts;
  }
}
