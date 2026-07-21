/**
 * Fired on the {@link Engine} each time a schedule launches an occurrence — i.e.
 * whenever a scheduled run is actually started, whether that is a fresh cadence
 * tick, a `cancel-running` replacement, or a `queue`d run draining after the
 * previous one finished. A fire means a workflow was launched: the blocked
 * policies (`skip`, and `queue` while a run is already active) intentionally do
 * **not** emit, since nothing started.
 *
 * Delivery is process-local and best-effort — listen via
 * `engine.addEventListener('schedule:fired', handler)` on the live engine that
 * owns the schedule. The durable part (the cadence, and the launched run itself)
 * is handled by the schedule; the event is dispatched synchronously right after
 * the run's durable start commits, so a crash in that narrow window — start
 * committed, dispatch not yet reached — can drop the notification without
 * affecting the run. Treat it as a reaction signal, not a durable record. This
 * lets a consumer react to a firing without polling `engine.list()` or
 * `getSchedule()`.
 *
 * @example
 * ```ts
 * import { workflow, Engine, ScheduleFiredEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('schedule:fired', (e: Event) => {
 *   const ev = e as ScheduleFiredEvent;
 *   console.log('schedule', ev.scheduleId, 'launched run', ev.workflowId);
 * });
 * engine.register(workflow({ name: 'tick' }).execute(async function* () { return 'ok'; }));
 * await engine.schedule('tick', null, { every: '1h' });
 * ```
 */
export class ScheduleFiredEvent extends Event {
  static readonly type = 'schedule:fired' as const;
  /** The schedule whose occurrence fired. */
  readonly scheduleId: string;
  /** The workflow run this occurrence launched. */
  readonly workflowId: string;
  /** Wall-clock time the run was launched, from the engine's injected clock. */
  readonly firedAt: number;
  /**
   * The scheduled grid timestamp the occurrence was due. Queue overlap retains
   * this timestamp on the durable queue entry and reports it when the run drains.
   * It is undefined only when an internal caller did not supply an occurrence.
   */
  readonly occurrence: number | undefined;

  constructor(scheduleId: string, workflowId: string, firedAt: number, occurrence?: number) {
    super(ScheduleFiredEvent.type);
    this.scheduleId = scheduleId;
    this.workflowId = workflowId;
    this.firedAt = firedAt;
    this.occurrence = occurrence;
  }
}

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
