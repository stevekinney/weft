import { WeftError } from '../weft-error.ts';

/**
 * Thrown by `skipNextScheduleOccurrence` and `unskipScheduleOccurrence` when the caller named an
 * `occurrence` that is not an upcoming run of the schedule (COR-1985, COR-2018): a fire passed it,
 * or it is a time the cadence starts no run at (a wake-up that starts nothing, a time off the
 * cadence). Nothing was written. Read the schedule again and choose from `nextOccurrence` on, the
 * schedule's next real run as it stands now.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleOccurrenceNotNextError, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'report' }).execute(async function* () { return 'ok'; }));
 * await engine.schedule('report', null, '0 9 * * *', { id: 'daily-report' });
 * try {
 *   await engine.skipNextScheduleOccurrence('daily-report', { occurrence: 0 });
 * } catch (error) {
 *   if (error instanceof ScheduleOccurrenceNotNextError) {
 *     console.error(error.scheduleId, error.occurrence, error.nextOccurrence);
 *   }
 * }
 * engine[Symbol.dispose]();
 * ```
 */
export class ScheduleOccurrenceNotNextError extends WeftError<'ScheduleOccurrenceNotNextError'> {
  /** The id of the schedule the skip, or its undoing, was for. */
  readonly scheduleId: string;
  /** The occurrence the caller named, in milliseconds since the epoch. */
  readonly occurrence: number;
  /** The schedule's next real run now, the first that can be skipped, in milliseconds since the epoch. */
  readonly nextOccurrence: number;

  constructor(scheduleId: string, occurrence: number, nextOccurrence: number) {
    super(
      'ScheduleOccurrenceNotNextError',
      `Schedule "${scheduleId}" has no upcoming run at ${occurrence}; its next run is at ` +
        `${nextOccurrence}. The occurrence changed after it was read; read it again.`,
    );
    this.scheduleId = scheduleId;
    this.occurrence = occurrence;
    this.nextOccurrence = nextOccurrence;
  }
}
