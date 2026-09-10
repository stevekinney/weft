/**
 * Count durable `TeardownDeadLetterRecord`s pinned to an exact
 * `(type, revision)` (WFT-21). Wired into `catalog-removal.ts`'s
 * `countWorkflowRevisionReferences()`, contributing one of the two
 * components of `retainedRecoveryRecords` — the other being terminal,
 * unpurged `WorkflowState`s (see
 * {@link import('./nonterminal-revision-count.ts').countWorkflowStateRevisionsByStatus}'s
 * `terminalRuns`).
 *
 * A dead letter is deliberately excluded from the workflow purge delete-set
 * (leak evidence, per `termination/finalizer-claim.ts`'s
 * `KEYS.teardownDeadLetter` doc) and so, unlike a terminal `WorkflowState`,
 * is NEVER auto-released by purge or retention — a revision that ever
 * dead-lettered stays permanently non-removable until a future
 * acknowledge/clear API exists (not built this batch).
 *
 * Mirrors `pinned-schedule-revision-count.ts`'s bounded-scan shape and doc
 * style.
 *
 * @module core/engine/retained-recovery-record-count
 */

import { KEYS, type Storage } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';

/**
 * Scan `storage` for `TeardownDeadLetterRecord`s whose `type` and
 * `revision` match exactly, returning the count. A record with
 * `revision === undefined` (written before this field existed, or for a
 * legacy run with no persisted `WorkflowState.revision`) never matches a
 * defined `revision` argument — it never counts against any specific
 * revision, mirroring `nonTerminalRuns`' own legacy-record precedent.
 */
export async function countTeardownDeadLettersForRevision(
  storage: Storage,
  type: string,
  revision: string,
): Promise<number> {
  let count = 0;
  for await (const [, bytes] of storage.scan(KEYS.teardownDeadLetterPrefix())) {
    let decoded: unknown;
    try {
      decoded = decode(bytes);
    } catch {
      continue;
    }
    if (!isRecord(decoded)) continue;
    if (decoded['type'] !== type || decoded['revision'] !== revision) continue;
    count += 1;
  }
  return count;
}
