/**
 * Decoded-`revision` sanitization for {@link import('./validation.ts').decodeWorkflowState}.
 * Split out of `validation.ts`, which has no headroom under the repository's
 * 500-line implementation-file ceiling.
 *
 * @module core/engine/decode-revision
 */

import type { WorkflowState } from '../types.ts';

/**
 * Upper bound on a decoded {@link WorkflowState.revision}, in characters. A
 * content-derived revision (`deriveWorkflowRevision`) is a `sha256:`-prefixed
 * 64-character hex digest (~71 characters); an explicit `workflowSource()`
 * revision is caller-chosen. Generous enough for either, bounded so a
 * corrupted or tampered storage record cannot smuggle an unbounded string
 * through decode.
 */
const MAX_WORKFLOW_REVISION_LENGTH = 512;

/**
 * Prefix for the deterministic marker {@link sanitizeDecodedRevision}
 * substitutes for a PRESENT-but-malformed decoded `revision`. Not a
 * `deriveWorkflowRevision()`-shaped value (that's always `sha256:`-prefixed)
 * and not a value any real caller would plausibly choose for
 * `workflowSource()`'s free-form `revision` — a caller would have to
 * deliberately name their own revision after another workflow's corruption
 * marker for a collision to occur, which is outside this function's threat
 * model (storage corruption or tampering, not adversarial `workflowSource()`
 * registration).
 */
const CORRUPTED_WORKFLOW_REVISION_PREFIX = 'weft:corrupted-revision:';

/**
 * Normalize a decoded `revision` that is present but not a non-empty,
 * bounded string.
 *
 * Deliberately NEVER drops a present-but-malformed value to `undefined` —
 * `revision` is engine-derived (never user-supplied at the API surface), so
 * an invalid value here indicates storage corruption or tampering, and
 * `undefined` is the SAME signal a genuinely missing `revision` carries
 * (a legitimate pre-revision-pinning record). Recovery treats an
 * `undefined` pin as unambiguous for an eager type or a dynamic source with
 * at most one registered candidate — silently executing that sole
 * candidate against a checkpoint whose true originating revision is
 * actually unknown, rather than rejecting the damaged identity. Instead,
 * a malformed value is replaced with a deterministic, distinctly-prefixed
 * marker derived from the workflow id: still a valid, bounded `string`, but
 * virtually guaranteed not to match any real registered candidate, so the
 * ordinary `resolveExecutableRegistrationForRevision()` "not-registered"
 * path rejects it explicitly (an `unavailable` recovery outcome, isolated
 * to that one run) instead of silently downgrading it to "legacy."
 *
 * Only a genuinely absent `revision` (never persisted at all) returns
 * early, unchanged, above.
 */
export function sanitizeDecodedRevision(state: WorkflowState): void {
  if (state.revision === undefined) {
    return;
  }
  if (
    typeof state.revision === 'string' &&
    state.revision.length > 0 &&
    state.revision.length <= MAX_WORKFLOW_REVISION_LENGTH
  ) {
    return;
  }
  console.warn(
    `[weft] Decoded workflow state for "${state.id}" has a malformed revision field; ` +
      'replacing it with a corruption marker so recovery rejects it explicitly as an ' +
      'unavailable pin, rather than silently treating this run as pre-revision-pinning. ' +
      'This usually indicates corruption or tampering of the storage record.',
  );
  state.revision = `${CORRUPTED_WORKFLOW_REVISION_PREFIX}${state.id}`.slice(
    0,
    MAX_WORKFLOW_REVISION_LENGTH,
  );
}
