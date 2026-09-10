/**
 * Count non-terminal (`running`, `pending`, or `suspended`) workflow runs
 * pinned to an exact `(type, revision)` (WFT-17). Wired into
 * `catalog-removal.ts`'s `countWorkflowRevisionReferences()`, replacing the
 * `nonTerminalRuns: 0` stub WFT-12 left in place pending this batch (see
 * that changelog entry: "stays 0 until run-level revision pinning (WFT-17)
 * exists to count against").
 *
 * Mirrors `diagnostics/version-check.ts`'s `groupActiveWorkflowsByType()`
 * bounded-scan shape: only top-level `wf:{id}` records are workflow states
 * (`wf:{id}:ckpt`, `:offload`, `:archive`, `:timeline:`, and index keys all
 * share the `wf:` prefix but are not).
 *
 * @module core/engine/nonterminal-revision-count
 */

import type { Storage } from '../../storage/interface.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';
import { isTopLevelWorkflowStateKey } from './workflow-state-stream.ts';

/**
 * Scan `storage` for non-terminal workflow states whose `type` and
 * `revision` match exactly, returning the count. A legacy record with no
 * persisted `revision` never matches (a defined `revision` argument cannot
 * equal `undefined`), consistent with recovery's own "a legacy record is a
 * distinct, unresolved pin" treatment — it is not silently folded into
 * whichever revision happens to be active.
 */
export async function countNonTerminalRunsForRevision(
  storage: Storage,
  type: string,
  revision: string,
): Promise<number> {
  let count = 0;
  for await (const [key, bytes] of storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;
    const state = decodeWorkflowState(bytes);
    if (state.type !== type || state.revision !== revision) continue;
    if (isTerminalWorkflowStatus(state.status)) continue;
    count += 1;
  }
  return count;
}
