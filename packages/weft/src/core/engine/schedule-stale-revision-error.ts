import { WeftError } from '../weft-error.ts';

/**
 * Thrown by `pauseSchedule`, `resumeSchedule`, `cancelSchedule`, and `updateSchedule` when the
 * caller passed `expectedRevision` and the schedule's {@link ScheduleMetadata.revision} is no
 * longer that value: the schedule changed after the caller read it. Nothing was written. Re-read
 * the schedule and decide again from `currentRevision`.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleStaleRevisionError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.pauseSchedule('daily-report', { expectedRevision: 3 });
 * } catch (error) {
 *   if (error instanceof ScheduleStaleRevisionError) {
 *     console.error(error.scheduleId, error.expectedRevision, error.currentRevision);
 *   }
 * }
 * engine[Symbol.dispose]();
 * ```
 */
export class ScheduleStaleRevisionError extends WeftError<'ScheduleStaleRevisionError'> {
  readonly scheduleId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(scheduleId: string, expectedRevision: number, currentRevision: number) {
    super(
      'ScheduleStaleRevisionError',
      `Schedule "${scheduleId}" is at revision ${currentRevision}, not the expected revision ` +
        `${expectedRevision}. It changed after it was read; read it again.`,
    );
    this.scheduleId = scheduleId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}
