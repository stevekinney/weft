/**
 * Fired on the {@link Engine} when a non-backfill schedule timer is more than
 * one second late and the engine skips the missed occurrence window instead of
 * starting workflows for those ticks.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleMissedFireEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
 *   console.warn(event.scheduleId, 'missed', event.missedCount, 'scheduled ticks');
 * });
 * ```
 */
export class ScheduleMissedFireEvent extends Event {
  static readonly type = 'schedule:missed-fire' as const;
  readonly scheduleId: string;
  readonly missedCount: number;
  readonly windowStart: number;
  readonly windowEnd: number;

  constructor(scheduleId: string, missedCount: number, windowStart: number, windowEnd: number) {
    super(ScheduleMissedFireEvent.type);
    this.scheduleId = scheduleId;
    this.missedCount = missedCount;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
  }
}
