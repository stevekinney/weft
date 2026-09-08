/**
 * Rejection vocabulary and the public error thrown by dynamic workflow
 * source validation (WFT-13/14).
 *
 * @module core/source/errors
 */

import type { WorkflowCompatibilityReason } from '../contract/compatibility.ts';
import { WeftError } from '../weft-error.ts';

/**
 * One bounded, machine-readable reason a resolved workflow source was
 * rejected — either a structural problem discovered before a manifest could
 * even be built (`unregistered-source-kind`, `missing-export`,
 * `ambiguous-export`, `invalid-definition`, `manifest-build-failed`), or one
 * of {@link WorkflowCompatibilityReason}'s five reasons, reused verbatim once
 * a manifest was built successfully and compared against the descriptor's
 * expectations.
 *
 * @example
 * ```ts
 * import type { WorkflowSourceRejectionReason } from '@lostgradient/weft';
 *
 * const reasons: WorkflowSourceRejectionReason[] = ['missing-export', 'name-mismatch'];
 * console.log(reasons.join(', '));
 * ```
 */
export type WorkflowSourceRejectionReason =
  | 'unregistered-source-kind'
  | 'missing-export'
  | 'ambiguous-export'
  | 'invalid-definition'
  | 'manifest-build-failed'
  | WorkflowCompatibilityReason;

/**
 * Thrown by `resolveWorkflowSource()` when a loaded workflow source fails
 * validation: a structural problem (missing/ambiguous export, an
 * export that is not a builder-produced `WorkflowDefinition`, a contract
 * exceeding a hostile-input limit) or a `checkWorkflowCompatibility`
 * mismatch against the descriptor's expected `name`/`revision`/
 * `workflowVersion`/`contractHash`. Carries every applicable
 * {@link WorkflowSourceRejectionReason}, never just the first one found.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSourceValidationError } from '@lostgradient/weft';
 *
 * declare const engine: Engine;
 * try {
 *   await engine.resolveWorkflowSource('checkout', 'r1');
 * } catch (error) {
 *   if (error instanceof WorkflowSourceValidationError) {
 *     console.error(error.workflowName, error.revision, error.reasons);
 *   }
 * }
 * ```
 */
export class WorkflowSourceValidationError extends WeftError<'WorkflowSourceValidationError'> {
  readonly workflowName: string;
  readonly revision: string;
  readonly reasons: readonly WorkflowSourceRejectionReason[];

  constructor(
    workflowName: string,
    revision: string,
    reasons: readonly WorkflowSourceRejectionReason[],
  ) {
    super(
      'WorkflowSourceValidationError',
      `Dynamic workflow source "${workflowName}" revision "${revision}" failed validation: ` +
        reasons.join(', '),
    );
    this.workflowName = workflowName;
    this.revision = revision;
    this.reasons = reasons;
  }
}
