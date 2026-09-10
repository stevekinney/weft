/**
 * Decode a persisted schedule record's revision-policy fields
 * (`revisionPolicy` / `pinnedRevision`, WFT-20). Split out of `schedule.ts`
 * purely to stay under this repository's 500-line-per-file ceiling — see
 * that file's own precedent (`lifecycle/start.ts`/`decode-revision.ts` for
 * WFT-17/18) — there is no behavioral reason to import this module directly
 * instead of `schedule.ts`, which composes it into `decodeScheduleState`.
 *
 * @module core/engine/validation/schedule-revision
 */

import type { ScheduleState } from '../../types.ts';
import { SCHEDULE_REVISION_POLICIES } from './schedule-options.ts';
import { rejectInvalidScheduleRecord } from './schedule-warnings.ts';

type ScheduleRevisionFields = Pick<ScheduleState, 'revisionPolicy' | 'pinnedRevision'>;

/**
 * Decode `revisionPolicy`/`pinnedRevision` from a persisted schedule record.
 * A record with NO `revisionPolicy` field predates WFT-20 and decodes as
 * `'active-at-fire'` — the same "absent means legacy, not corrupt" treatment
 * `WorkflowState.revision` got (WFT-17/18) — never rejected as malformed. An
 * explicit but unrecognized `revisionPolicy` string, or a `pinnedRevision`
 * present while `revisionPolicy !== 'pinned'` (or absent while it IS
 * `'pinned'`), both reject the whole record via
 * {@link rejectInvalidScheduleRecord} rather than silently coercing.
 */
export function decodeScheduleRevisionPolicyFields(
  decoded: Record<string, unknown>,
  scheduleId: string,
): ScheduleRevisionFields | null {
  const rawRevisionPolicy = decoded['revisionPolicy'];
  if (rawRevisionPolicy === undefined) {
    return { revisionPolicy: 'active-at-fire' };
  }
  if (!SCHEDULE_REVISION_POLICIES.has(rawRevisionPolicy as ScheduleState['revisionPolicy'])) {
    return rejectInvalidScheduleRecord(scheduleId, 'with invalid revisionPolicy');
  }
  const revisionPolicy = rawRevisionPolicy as ScheduleState['revisionPolicy'];

  const pinnedRevision = decoded['pinnedRevision'];
  const hasPinnedRevision = pinnedRevision !== undefined;
  if (revisionPolicy === 'pinned') {
    if (!hasPinnedRevision || typeof pinnedRevision !== 'string' || pinnedRevision.length === 0) {
      return rejectInvalidScheduleRecord(
        scheduleId,
        'with revisionPolicy "pinned" but a missing or invalid pinnedRevision',
      );
    }
    return { revisionPolicy, pinnedRevision };
  }

  if (hasPinnedRevision) {
    return rejectInvalidScheduleRecord(
      scheduleId,
      'with a pinnedRevision but revisionPolicy is not "pinned"',
    );
  }
  return { revisionPolicy };
}
