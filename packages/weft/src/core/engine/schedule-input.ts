import type { ScheduleTransitionOptions } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { withoutSkip } from './schedule-controls.ts';
import { getNextScheduleOccurrence } from './schedule-occurrence.ts';
import { runScheduleTransition } from './schedule-state-operations.ts';
import { scheduleTransitionWriteOptions } from './schedules.ts';
import { writeScheduleState } from './storage-io.ts';
import {
  assertCallerOwnedTransitionKeys,
  coerceExpectedScheduleRevision,
  coerceScheduleId,
} from './validation/schedule.ts';

/** Replace future input and status atomically, defaulting to a paused schedule. */
export async function replaceScheduleInput(
  internals: EngineInternals,
  scheduleId: string,
  input: unknown,
  options: ScheduleTransitionOptions & { expectedRevision: number; status?: 'active' | 'paused' },
): Promise<void> {
  const id = coerceScheduleId(scheduleId, 'scheduleId');
  const revision = coerceExpectedScheduleRevision(options.expectedRevision);
  if (revision === undefined)
    throw new TypeError('Schedule input replacement requires expectedRevision');
  if (options.status !== undefined && options.status !== 'active' && options.status !== 'paused')
    throw new TypeError('Schedule input replacement status must be active or paused');
  const snapshot = structuredClone(input);
  const { onExtraConditionsLost, ...serializableOptions } = options;
  const transition = {
    ...structuredClone(serializableOptions),
    ...(onExtraConditionsLost === undefined ? {} : { onExtraConditionsLost }),
  };
  assertCallerOwnedTransitionKeys(id, transition);
  await runScheduleTransition(internals, id, revision, async (state, readConditions) => {
    if (state.status === 'cancelled')
      throw new Error('Cancelled schedule input cannot be replaced');
    await writeScheduleState(
      internals,
      {
        ...withoutSkip(state),
        input: snapshot,
        status: transition.status ?? 'paused',
        nextFireAt:
          transition.status === 'active'
            ? getNextScheduleOccurrence(state, internals.options.getNow())
            : state.nextFireAt,
        revision: state.revision + 1,
        updatedAt: internals.options.getNow(),
        queuedRuns: [],
      },
      {
        includeTimer: transition.status === 'active',
        replaceTimerFrom: state,
        ...scheduleTransitionWriteOptions(transition, readConditions),
      },
    );
  });
}
