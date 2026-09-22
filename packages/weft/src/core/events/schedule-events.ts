import type { ScheduleOverlapPolicy } from '../types/schedules.ts';

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

/**
 * Fired on the {@link Engine} at the top of every schedule occurrence, before
 * the overlap policy decides whether to start, queue, cancel-and-replace, or
 * drop the tick. Exactly one of these precedes every {@link ScheduleFiredEvent}
 * and every {@link ScheduleSkippedEvent}; a backfilled window emits one per
 * processed occurrence.
 *
 * This is the observation point a consumer needs to distinguish "the schedule
 * is ticking and choosing not to run" from "the schedule stopped ticking" —
 * `schedule:fired` alone cannot tell those apart, because the blocked overlap
 * policies deliberately do not emit it.
 *
 * Delivery is process-local and best-effort, on the live engine that owns the
 * schedule, with the same durability caveat as {@link ScheduleFiredEvent}:
 * treat it as a reaction signal, not a durable record.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleAttemptedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(ScheduleAttemptedEvent.type, (event) => {
 *   console.log('schedule', event.scheduleId, 'ticked at', event.occurrence);
 * });
 * ```
 */
export class ScheduleAttemptedEvent extends Event {
  static readonly type = 'schedule:attempted' as const;
  /** The schedule whose occurrence is being attempted. */
  readonly scheduleId: string;
  /** Wall-clock time of the attempt, from the engine's injected clock. */
  readonly attemptedAt: number;
  /**
   * The scheduled grid timestamp the occurrence was due. Undefined only when an
   * internal caller applied an occurrence without supplying one, matching
   * {@link ScheduleFiredEvent.occurrence}.
   */
  readonly occurrence: number | undefined;

  constructor(scheduleId: string, attemptedAt: number, occurrence?: number) {
    super(ScheduleAttemptedEvent.type);
    this.scheduleId = scheduleId;
    this.attemptedAt = attemptedAt;
    this.occurrence = occurrence;
  }
}

/**
 * Fired on the {@link Engine} when an occurrence is dropped because the
 * schedule's overlap policy blocks it and a prior run still occupies the slot.
 * Today that is exactly `overlap: 'skip'` — `'queue'` buffers the occurrence
 * and `'cancel-running'` replaces the active run, so neither drops anything,
 * and `'allow'` never reaches the blocked path at all.
 *
 * Distinct from {@link ScheduleMissedFireEvent}, which reports occurrences the
 * engine never evaluated because its timer ran late. A skip is a decision taken
 * on a tick that was observed; a missed fire is a window that was not.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleSkippedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(ScheduleSkippedEvent.type, (event) => {
 *   console.warn(event.scheduleId, 'skipped, blocked by run', event.blockingWorkflowId);
 * });
 * ```
 */
export class ScheduleSkippedEvent extends Event {
  static readonly type = 'schedule:skipped' as const;
  /** The schedule whose occurrence was dropped. */
  readonly scheduleId: string;
  /** Wall-clock time of the skip, from the engine's injected clock. */
  readonly skippedAt: number;
  /** The scheduled grid timestamp the dropped occurrence was due. */
  readonly occurrence: number | undefined;
  /**
   * The still-active run that occupied the slot. Undefined only when the
   * schedule state carries no current workflow id, which a blocked occurrence
   * should not reach — carried as optional rather than asserted so an
   * observation event can never throw on a malformed state.
   */
  readonly blockingWorkflowId: string | undefined;
  /** The overlap policy that produced the decision. */
  readonly policy: ScheduleOverlapPolicy;

  constructor(
    scheduleId: string,
    skippedAt: number,
    policy: ScheduleOverlapPolicy,
    occurrence?: number,
    blockingWorkflowId?: string,
  ) {
    super(ScheduleSkippedEvent.type);
    this.scheduleId = scheduleId;
    this.skippedAt = skippedAt;
    this.policy = policy;
    this.occurrence = occurrence;
    this.blockingWorkflowId = blockingWorkflowId;
  }
}
