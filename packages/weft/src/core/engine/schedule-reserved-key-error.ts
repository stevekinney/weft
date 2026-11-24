import { WeftError } from '../weft-error.ts';

/**
 * Thrown by `pauseSchedule`, `resumeSchedule`, and `cancelSchedule` when the caller's
 * `extraConditions` or `additionalOperations` name a key under one of Weft's reserved prefixes
 * (`WEFT_RESERVED_KEY_PREFIXES`), the schedule's own key among them. Both are for the caller's own
 * keys: the schedule's own write is conditioned by the engine, a condition of the caller's on a key
 * the engine owns could never be told apart from the engine's, and an operation of the caller's on
 * one would write the engine's keys through the very transition that guards them. Nothing was
 * written.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleReservedKeyError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.pauseSchedule('daily-report', {
 *     extraConditions: [{ key: 'schedule:daily-report', expectedValue: null }],
 *   });
 * } catch (error) {
 *   if (error instanceof ScheduleReservedKeyError) console.error(error.key);
 * }
 * engine[Symbol.dispose]();
 * ```
 */
export class ScheduleReservedKeyError extends WeftError<'ScheduleReservedKeyError'> {
  readonly scheduleId: string;
  readonly key: string;

  constructor(scheduleId: string, key: string) {
    super(
      'ScheduleReservedKeyError',
      `The extraConditions or additionalOperations of a transition of schedule "${scheduleId}" ` +
        `name "${key}", which is under a key prefix Weft reserves. Use keys of your own.`,
    );
    this.scheduleId = scheduleId;
    this.key = key;
  }
}
