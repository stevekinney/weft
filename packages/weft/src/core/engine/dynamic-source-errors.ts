/**
 * Errors raised by the dynamic workflow source pipeline (WFT-15/16):
 * {@link DynamicWorkflowSourceUnavailableError} at an execution entry point
 * — `start`, `startOrSignal`, `schedule`, `fork`, `resume`, recovery, and
 * bulk-retry — when a registered source's revision is ambiguous or its
 * load fails; {@link WorkflowSourceNotRegisteredError} by
 * `engine.resolveWorkflowSource()` / `engine.workflows.preload()` directly.
 * Split out of `errors.ts`, which is at the repository's 500-line
 * implementation-file ceiling with no headroom for two more documented
 * classes; kept alongside `lease-errors.ts` and `source/errors.ts` as this
 * file family's precedent for a domain-scoped errors module.
 *
 * @module core/engine/dynamic-source-errors
 */

import { WeftError } from '../weft-error.ts';

/**
 * Thrown by `engine.resolveWorkflowSource()` (and its
 * `engine.workflows.preload()` alias) when called against a specific
 * `(name, revision)` that `registerSource()` never recorded — a
 * programmer-error contract, not untrusted-input rejection. `revision` is
 * therefore always defined in practice.
 *
 * This is a DIFFERENT case from a workflow `type` with no eager
 * registration AND no dynamic source at all: every execution entry point
 * (`start`, `startOrSignal`, `schedule`, `fork`, `resume`, recovery,
 * bulk-retry) keeps throwing the pre-existing
 * {@link WorkflowNotRegisteredError} for that case instead, preserving the
 * fault classification and wire code callers already depended on before
 * WFT-15/16 — see `dynamic-source-execution.ts`'s
 * `resolveExecutableRegistration()`.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSourceNotRegisteredError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.resolveWorkflowSource('checkout', 'r-never-registered');
 * } catch (err) {
 *   if (err instanceof WorkflowSourceNotRegisteredError) {
 *     console.error('registerSource() it first:', err.workflowType, err.revision);
 *   }
 * }
 * ```
 */
export class WorkflowSourceNotRegisteredError extends WeftError<'WorkflowSourceNotRegisteredError'> {
  readonly workflowType: string;
  readonly revision: string | undefined;

  constructor(workflowType: string, revision?: string) {
    super(
      'WorkflowSourceNotRegisteredError',
      revision === undefined
        ? `No workflow registered with name "${workflowType}"`
        : `resolveWorkflowSource("${workflowType}", "${revision}") was called before registerSource() ` +
            'registered this exact (name, revision) — call engine.registerSource() first.',
    );
    this.workflowType = workflowType;
    this.revision = revision;
  }
}

/**
 * Thrown when a registered dynamic workflow source cannot be turned into an
 * executable registration: either its load failed (`reason: 'load-failed'`,
 * `cause` carries the underlying error) or which revision to resolve could
 * not be determined (`reason: 'ambiguous-revision'` — two or more revisions
 * are registered for `workflowType` and the catalog has no active pointer
 * naming one of them). Recovery classifies the affected type `unavailable`:
 * only its runs fail, with this error as the `system` failure cause;
 * sibling types continue.
 *
 * @example
 * ```ts
 * import { Engine, DynamicWorkflowSourceUnavailableError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.start('checkout', { orderId: 'order-1' });
 * } catch (err) {
 *   if (err instanceof DynamicWorkflowSourceUnavailableError) {
 *     console.error(err.workflowType, err.reason);
 *   }
 * }
 * ```
 */
export class DynamicWorkflowSourceUnavailableError extends WeftError<'DynamicWorkflowSourceUnavailableError'> {
  readonly workflowType: string;
  readonly revision: string | undefined;
  readonly reason: 'load-failed' | 'ambiguous-revision';
  override readonly cause: unknown;

  constructor(
    workflowType: string,
    revision: string | undefined,
    reason: 'load-failed' | 'ambiguous-revision',
    cause?: unknown,
  ) {
    super(
      'DynamicWorkflowSourceUnavailableError',
      reason === 'ambiguous-revision'
        ? `Cannot resolve dynamic workflow source "${workflowType}": multiple revisions are ` +
            'registered and none is the catalog active revision. Activate one via ' +
            'engine.workflows.activate(), or register only one revision at a time.'
        : `Dynamic workflow source "${workflowType}"${revision === undefined ? '' : ` revision "${revision}"`} failed to load: ` +
            (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
    this.workflowType = workflowType;
    this.revision = revision;
    this.reason = reason;
    this.cause = cause;
  }
}
