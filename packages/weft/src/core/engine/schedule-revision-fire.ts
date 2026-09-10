/**
 * The pinned-vs-active-at-fire branch point for a scheduled occurrence
 * (WFT-20), split into its own tiny module so `schedule-run.ts` — a
 * deliberately small, purpose-built module — has one obvious call site
 * instead of inlining the branch.
 *
 * @module core/engine/schedule-revision-fire
 */

import type { ScheduleState } from '../types.ts';

/**
 * The revision override `startScheduledRun` should pass to
 * `ScheduleCallbacks.startWorkflow` for this occurrence: `state.pinnedRevision`
 * when `state.revisionPolicy === 'pinned'`, else `undefined` (an
 * `'active-at-fire'` schedule resolves whatever revision is active at fire
 * time, unchanged from pre-WFT-20 behavior).
 */
export function buildPinnedRevisionOverride(state: ScheduleState): string | undefined {
  return state.revisionPolicy === 'pinned' ? state.pinnedRevision : undefined;
}
