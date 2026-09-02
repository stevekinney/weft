/**
 * Bounded failure vocabulary for workflow revision manifest validation.
 *
 * Mirrors `src/worker/manifest/failure.ts`: rejections are returned rather
 * than thrown, `reason` is a closed union safe to use as a metric label, and
 * `message`/`path` are diagnostics only.
 *
 * @module core/contract/failure
 */

/**
 * Why an untrusted {@link WorkflowRevisionManifest} was rejected.
 *
 * @example
 * ```ts
 * import type { WorkflowRevisionManifestRejectionReason } from '@lostgradient/weft';
 *
 * const counts = new Map<WorkflowRevisionManifestRejectionReason, number>();
 * counts.set('contract-hash-mismatch', 1);
 * console.log(counts.get('contract-hash-mismatch'));
 * ```
 */
export type WorkflowRevisionManifestRejectionReason =
  | 'manifest-version-unsupported'
  | 'contract-hash-mismatch'
  | 'not-an-object'
  | 'invalid-field'
  | 'identifier-too-long'
  | 'too-many-entries'
  | 'manifest-too-large';

/**
 * A rejected workflow revision manifest, with enough detail to fix the
 * caller's input and not so much that it leaks contract content into logs.
 *
 * @example
 * ```ts
 * import { parseWorkflowRevisionManifest, type WorkflowRevisionManifestValidationFailure } from '@lostgradient/weft';
 *
 * const result = await parseWorkflowRevisionManifest({ manifestVersion: 99 });
 * if (!result.ok) {
 *   const rejection: WorkflowRevisionManifestValidationFailure = result;
 *   console.log(rejection.reason); // 'manifest-version-unsupported'
 * }
 * ```
 */
export type WorkflowRevisionManifestValidationFailure = Readonly<{
  ok: false;
  /** Bounded rejection reason, safe as a metric label. */
  reason: WorkflowRevisionManifestRejectionReason;
  /** Human-readable diagnostic. Never use as a metric label. */
  message: string;
  /** Dotted path to the offending field, when one applies. */
  path?: string;
}>;

/**
 * Build a validation failure whose message reads as one sentence about the
 * offending path — `manifest.contract.workflowVersion must be a non-empty
 * string`.
 *
 * @example
 * ```ts
 * import { workflowRevisionManifestFailure } from '@lostgradient/weft';
 *
 * const failure = workflowRevisionManifestFailure(
 *   'invalid-field',
 *   'must be a non-empty string',
 *   'manifest.name',
 * );
 * console.log(failure.message);
 * ```
 */
export function workflowRevisionManifestFailure(
  reason: WorkflowRevisionManifestRejectionReason,
  message: string,
  path?: string,
): WorkflowRevisionManifestValidationFailure {
  const described = path === undefined ? message : `${path} ${message}`;
  return path === undefined
    ? { ok: false, reason, message: described }
    : { ok: false, reason, message: described, path };
}
