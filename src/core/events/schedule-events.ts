/**
 * Fired on the {@link Engine} each time a schedule launches an occurrence — i.e.
 * whenever a scheduled run is actually started, whether that is a fresh cadence
 * tick, a `cancel-running` replacement, or a `queue`d run draining after the
 * previous one finished. A fire means a workflow was launched: the blocked
 * policies (`skip`, and `queue` while a run is already active) intentionally do
 * **not** emit, since nothing started.
 *
 * Delivery is process-local — listen via `engine.addEventListener('schedule:fired', handler)`
 * on the live engine that owns the schedule. The durable part (the cadence) is
 * handled by the schedule itself; this event lets a consumer react to a firing
 * without polling `engine.list()` or `getSchedule()`.
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
   * The scheduled grid timestamp the occurrence was due. `undefined` for a run
   * that drained from the `queue` overlap policy: a queued occurrence is tracked
   * only as a count (`queuedRuns`), so its original due timestamp is not retained
   * and cannot be reported when the run finally launches.
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
