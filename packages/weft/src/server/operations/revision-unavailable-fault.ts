/**
 * Shared typed-fault mapping for {@link WorkflowRevisionUnavailableError}
 * (WFT-21) — extracted out of `schedule-faults.ts` so `fork-workflow.ts`
 * can reuse it instead of duplicating an equivalent check inline, which
 * would trip the repository's jscpd duplicate-code audit on two
 * near-identical fault-mapping functions.
 *
 * @module server/operations/revision-unavailable-fault
 */

import { WorkflowRevisionUnavailableError } from '../../core/engine/revision-errors.ts';
import type { OperationFault } from '../operation-fault.ts';

/**
 * A commit lost its revision-availability fence (an explicit revision was
 * concurrently removed, or — for an eager type — does not exactly match
 * what this process has registered). A structured, typed check rather than
 * substring matching, since the message text varies by
 * `WorkflowRevisionUnavailableError.reason`. `undefined` when `error` is
 * not this error class, so the caller falls through to its own
 * message-based classification.
 */
export function mapRevisionUnavailableToFault(error: unknown): OperationFault | undefined {
  if (!(error instanceof WorkflowRevisionUnavailableError)) {
    return undefined;
  }
  return {
    code: 'Conflict',
    message: error.message,
    // `error.reason`/`workflowType`/`revision` are already folded into
    // `message` by the error's own constructor; `OperationFault`'s
    // `Conflict.data.reason` is a caller-facing free-text summary, not a
    // structured enum slot for this specific error class. `weftCode`
    // recovers the originating typed error (WFT-21, Codex review round 4,
    // P2), matching the other typed fork/catalog Conflict mappings in
    // `workflow-catalog-operation-helpers.ts` and `fork-workflow.ts`.
    data: { reason: error.reason, weftCode: error.code },
  };
}
