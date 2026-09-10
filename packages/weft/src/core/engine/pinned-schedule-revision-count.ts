/**
 * Count schedules pinned to an exact `(type, revision)` (WFT-20). Wired into
 * `catalog-removal.ts`'s `countWorkflowRevisionReferences()`, replacing the
 * `pinnedSchedules: 0` stub WFT-12 left in place pending this batch (see
 * that field's own doc comment: "always 0 until WFT-20").
 *
 * Mirrors `nonterminal-revision-count.ts`'s bounded-scan shape exactly: only
 * top-level `schedule:{id}` records are schedule states — `schedule:{id}:*`
 * suffix keys (timer index, run metadata) share the `schedule:` prefix but
 * are not, the same skip `listSchedules`/`recoverOrphanedScheduleTimers`
 * already apply.
 *
 * @module core/engine/pinned-schedule-revision-count
 */

import type { Storage } from '../../storage/interface.ts';
import { decodeScheduleState } from './validation/schedule.ts';

/**
 * Scan `storage` for schedules whose `workflowType` and `pinnedRevision`
 * match exactly, returning the count. Only `revisionPolicy: 'pinned'`
 * schedules ever count — an `'active-at-fire'` schedule against the same
 * `(type, revision)` never blocks removal, since it resolves whatever is
 * active at each future fire regardless of what is being removed now. A
 * `'cancelled'` pinned schedule is excluded too: it will never fire again,
 * so it must not block removal of the revision it once pinned. A `'paused'`
 * pinned schedule still counts — it can be resumed and fire again later.
 */
export async function countPinnedSchedulesForRevision(
  storage: Storage,
  type: string,
  revision: string,
): Promise<number> {
  let count = 0;
  for await (const [key, bytes] of storage.scan('schedule:')) {
    const suffix = key.slice('schedule:'.length);
    if (suffix.includes(':')) continue;
    const state = decodeScheduleState(bytes);
    if (!state) continue;
    if (state.workflowType !== type) continue;
    if (state.revisionPolicy !== 'pinned' || state.pinnedRevision !== revision) continue;
    if (state.status === 'cancelled') continue;
    count += 1;
  }
  return count;
}
