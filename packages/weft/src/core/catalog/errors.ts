/**
 * Error classes thrown by the durable workflow catalog (WFT-9/WFT-10) and
 * its public promotion, `engine.workflows` (WFT-11).
 *
 * `WorkflowCatalogConflictError` and `WorkflowRevisionNotInstalledError` are
 * public — part of `WeftErrorCode` and re-exported from `src/index.ts` —
 * because `engine.workflows.install()`/`activate()` can throw either of them
 * directly at a caller who holds no other way to reach the catalog.
 * `WorkflowCatalogActivationConflictError` stays internal: it is reachable
 * only through `engine.register()`'s unconditional `activateRegistered`
 * path, which every public entry point already awaits via
 * `ensureWorkflowCatalogReady` rather than calling directly, so no public
 * caller ever observes it as a typed error to catch.
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
 *
 * @example
 * ```ts
 * import { Engine, WorkflowCatalogConflictError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   throw new WorkflowCatalogConflictError('checkout', 'r1');
 * } catch (error) {
 *   if (error instanceof WorkflowCatalogConflictError) {
 *     console.error(error.workflowName, error.revision);
 *   }
 * }
 * void engine;
 * ```
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

/**
 * Thrown by `engine.workflows.activate()` when `(workflowName, revision)`
 * has never been installed — distinct from
 * `WorkflowCatalog.activateCandidate`'s own `applied: false` refusal
 * variants, which all assume the candidate IS installed and instead
 * describe why activating it was refused.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRevisionNotInstalledError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.workflows.activate('checkout', 'unknown-revision');
 * } catch (error) {
 *   if (error instanceof WorkflowRevisionNotInstalledError) {
 *     console.error(error.workflowName, error.revision);
 *   }
 * }
 * ```
 */
export class WorkflowRevisionNotInstalledError extends WeftError<'WorkflowRevisionNotInstalledError'> {
  readonly workflowName: string;
  readonly revision: string;

  constructor(workflowName: string, revision: string) {
    super(
      'WorkflowRevisionNotInstalledError',
      `Workflow "${workflowName}" has no installed revision "${revision}" — install it via ` +
        'engine.workflows.install() before activating it.',
    );
    this.workflowName = workflowName;
    this.revision = revision;
  }
}

/**
 * Thrown by
 * {@link import('./workflow-catalog.ts').WorkflowCatalog.activateCandidate}
 * when the durable active pointer for `name` names a revision whose catalog
 * entry cannot be resolved — neither this process's in-memory cache nor a
 * durable read-through finds it. This should be unreachable in practice:
 * both activation entry points (`install()`-then-activate) always durably
 * install a revision before ever pointing the active pointer at it, so a
 * durably-active revision missing its own entry is a genuine storage
 * inconsistency, not a race any caller can retry past. Fail-closed rather
 * than silently skipping the compatibility check `activateCandidate`
 * exists to enforce — see `#refuseIncompatibleCandidate`'s JSDoc. Stays
 * internal (not re-exported from `src/index.ts`) like
 * {@link WorkflowCatalogActivationConflictError}: no code path lets a public
 * caller observe it as a typed error to catch, only as a generic
 * `EngineFailure`-wrapped operation fault.
 */
export class WorkflowCatalogActiveEntryMissingError extends WeftError<'WorkflowCatalogActiveEntryMissingError'> {
  readonly workflowName: string;
  readonly revision: string;

  constructor(workflowName: string, revision: string) {
    super(
      'WorkflowCatalogActiveEntryMissingError',
      `Workflow catalog inconsistency: "${workflowName}" is durably active at revision ` +
        `"${revision}", but that revision's catalog entry cannot be resolved (neither ` +
        'in-memory nor durably). Refusing to activate a candidate without being able to check ' +
        'compatibility against the currently active revision.',
    );
    this.workflowName = workflowName;
    this.revision = revision;
  }
}
