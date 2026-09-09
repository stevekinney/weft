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
 * Drop a decoded `revision` that is not a non-empty, bounded string — mirrors
 * `validation.ts`'s parent-lineage tampering-defense pattern. `revision` is
 * engine-derived (never user-supplied at the API surface), so an invalid
 * value here indicates storage corruption or tampering rather than ordinary
 * bad input; absence after this normalization is the same "legacy,
 * pre-this-field record" signal a genuinely missing `revision` carries, so
 * recovery classification treats both alike.
 */
export function sanitizeDecodedRevision(state: WorkflowState): void {
  if (state.revision === undefined) {
    return;
  }
  if (
    typeof state.revision !== 'string' ||
    state.revision.length === 0 ||
    state.revision.length > MAX_WORKFLOW_REVISION_LENGTH
  ) {
    console.warn(
      `[weft] Decoded workflow state for "${state.id}" has an invalid revision field; ` +
        'dropping it and treating the record as pre-revision-pinning. This usually indicates ' +
        'corruption or tampering of the storage record.',
    );
    delete state.revision;
  }
}
