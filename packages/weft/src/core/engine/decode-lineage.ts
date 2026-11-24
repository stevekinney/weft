/**
 * Decoded parent- and restart-lineage sanitization for
 * {@link import('./validation.ts').decodeWorkflowState}. Split out of
 * `validation.ts`, which has no headroom under the repository's 500-line
 * implementation-file ceiling, like `decode-revision.ts`.
 *
 * @module core/engine/decode-lineage
 */
import { isRecord } from '../debug-output.ts';
import type { WorkflowState } from '../types.ts';
import { isDecodableWorkflowId } from '../workflow-identifiers.ts';

export function sanitizeDecodedParentLineage(state: WorkflowState): void {
  // Decode-facing check (WFT-95 review) — see the `executionStateOwnerId`
  // comment above `decodeWorkflowState`; a pre-WFT-95 parent id of `.`/`..`
  // must survive decode instead of severing the parent lineage (and, via the
  // `parentWorkflowId === undefined` check below, the execution token too).
  if (state.parentWorkflowId !== undefined && !isDecodableWorkflowId(state.parentWorkflowId)) {
    delete state.parentWorkflowId;
  }
  if (
    typeof state.parentWorkflowExecutionToken !== 'string' ||
    state.parentWorkflowExecutionToken.length === 0 ||
    state.parentWorkflowId === undefined
  ) {
    delete state.parentWorkflowExecutionToken;
  }
}

export function sanitizeDecodedRestartLineage(state: WorkflowState): void {
  const restartedFrom = state.restartedFrom;
  if (!isRecord(restartedFrom)) {
    delete state.restartedFrom;
    return;
  }
  // Decode-facing check (WFT-95 review) — same reasoning as
  // `sanitizeDecodedParentLineage`: a pre-WFT-95 `restartedFrom.workflowId`
  // of `.`/`..` must remain decodable rather than dropping the whole
  // restart-lineage record.
  const restartWorkflowId = restartedFrom['workflowId'];
  if (typeof restartWorkflowId !== 'string' || !isDecodableWorkflowId(restartWorkflowId)) {
    delete state.restartedFrom;
    return;
  }
  const workflowExecutionToken = restartedFrom['workflowExecutionToken'];
  const replacedAt = restartedFrom['replacedAt'];
  if (
    (workflowExecutionToken !== undefined &&
      (typeof workflowExecutionToken !== 'string' || workflowExecutionToken.length === 0)) ||
    typeof replacedAt !== 'number' ||
    !Number.isSafeInteger(replacedAt) ||
    replacedAt < 0
  ) {
    delete state.restartedFrom;
  }
}
