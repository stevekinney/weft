/**
 * Bounded failure vocabulary for worker manifest validation.
 *
 * Rejections are returned rather than thrown, matching the RemoteWorker
 * protocol parser: a malformed manifest is an expected wire condition on an
 * untrusted boundary, not an exceptional one.
 *
 * `reason` is a closed union precisely so operators can count manifest
 * rejections by reason without a high-cardinality label. The human-readable
 * `message` and the `path` locating the offending field are for diagnostics
 * and must never be used as metric labels.
 *
 * @module worker/manifest/failure
 */

/**
 * Why a worker manifest was rejected.
 *
 * Closed by design — a bounded reason is safe to use as a metric label,
 * unlike the message or path that accompany it.
 *
 * @example
 * ```ts
 * import type { WorkerManifestRejectionReason } from '@lostgradient/weft';
 *
 * const counts = new Map<WorkerManifestRejectionReason, number>();
 * counts.set('unsupported_manifest_version', 1);
 * console.log(counts.get('unsupported_manifest_version'));
 * ```
 */
export type WorkerManifestRejectionReason =
  | 'not_an_object'
  | 'unsupported_manifest_version'
  | 'invalid_field'
  | 'identifier_too_long'
  | 'too_many_workflows'
  | 'too_many_activities'
  | 'too_many_capabilities'
  | 'capability_too_deep'
  | 'capability_string_too_long'
  | 'invalid_capability_value'
  | 'manifest_too_large'
  | 'duplicate_key'
  | 'invalid_json';

/**
 * A rejected worker manifest, with enough detail to fix the worker and not so
 * much that it leaks manifest content into logs.
 *
 * @example
 * ```ts
 * import { parseWorkerManifest, type ManifestValidationFailure } from '@lostgradient/weft';
 *
 * const result = parseWorkerManifest({ manifestVersion: 99 });
 * if (!result.ok) {
 *   const rejection: ManifestValidationFailure = result;
 *   console.log(rejection.reason); // 'unsupported_manifest_version'
 * }
 * ```
 */
export type ManifestValidationFailure = Readonly<{
  ok: false;
  /** Bounded rejection reason, safe as a metric label. */
  reason: WorkerManifestRejectionReason;
  /** Human-readable diagnostic. Never use as a metric label. */
  message: string;
  /** Dotted path to the offending field, when one applies. */
  path?: string;
}>;

/**
 * Build a validation failure whose message reads as one sentence about the
 * offending path — `manifest.deployment.buildId must be a non-empty string`.
 */
export function manifestFailure(
  reason: WorkerManifestRejectionReason,
  message: string,
  path?: string,
): ManifestValidationFailure {
  const described = path === undefined ? message : `${path} ${message}`;
  return path === undefined
    ? { ok: false, reason, message: described }
    : { ok: false, reason, message: described, path };
}
