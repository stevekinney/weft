/**
 * Count workflow runs pinned to an exact `(type, revision)`, split by
 * whether their status is terminal or not (WFT-17, extended WFT-21). One
 * bounded `storage.scan('wf:')` computes BOTH counts together — a single
 * top-level `wf:{id}` record is either terminal or not, so a scan that
 * already decodes and matches `(type, revision)` can classify it into
 * exactly one bucket at no extra cost, rather than paying for the same scan
 * twice from two separate call sites (`catalog-removal.ts`'s
 * `countWorkflowRevisionReferences()`, which needs both, and
 * `catalog-tombstone-recovery.ts`'s orphan sweep, which now also needs
 * both — see WFT-21's `retainedRecoveryRecords` wiring).
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

/** The two-bucket result of {@link countWorkflowStateRevisionsByStatus}. */
export type WorkflowStateRevisionStatusCounts = Readonly<{
  /** Runs with status `running`, `pending`, or `suspended`. */
  nonTerminalRuns: number;
  /** Runs with status `completed`, `failed`, `cancelled`, or `timed-out`. */
  terminalRuns: number;
}>;

/**
 * Scan `storage` for workflow states whose `type` and `revision` match
 * exactly, returning both the non-terminal and terminal counts from one
 * pass. A legacy record with no persisted `revision` never matches (a
 * defined `revision` argument cannot equal `undefined`), consistent with
 * recovery's own "a legacy record is a distinct, unresolved pin" treatment
 * — it is not silently folded into whichever revision happens to be
 * active, and it counts against neither bucket here either.
 */
export async function countWorkflowStateRevisionsByStatus(
  storage: Storage,
  type: string,
  revision: string,
): Promise<WorkflowStateRevisionStatusCounts> {
  let nonTerminalRuns = 0;
  let terminalRuns = 0;
  for await (const [key, bytes] of storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;
    const state = decodeWorkflowState(bytes);
    if (state.type !== type || state.revision !== revision) continue;
    if (isTerminalWorkflowStatus(state.status)) {
      terminalRuns += 1;
    } else {
      nonTerminalRuns += 1;
    }
  }
  return { nonTerminalRuns, terminalRuns };
}

/**
 * Count non-terminal (`running`, `pending`, or `suspended`) workflow runs
 * pinned to an exact `(type, revision)`. Thin wrapper over
 * {@link countWorkflowStateRevisionsByStatus} kept for callers (and tests)
 * that only need the non-terminal bucket — byte-identical behavior to the
 * pre-WFT-21 standalone scan this replaced.
 */
export async function countNonTerminalRunsForRevision(
  storage: Storage,
  type: string,
  revision: string,
): Promise<number> {
  const { nonTerminalRuns } = await countWorkflowStateRevisionsByStatus(storage, type, revision);
  return nonTerminalRuns;
}
