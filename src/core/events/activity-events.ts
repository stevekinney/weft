/**
 * Fired on the {@link Engine} when an activity begins execution. Use to
 * trace activity scheduling latency. Read `e.operationId`, `e.workflowId`,
 * `e.activityName`, and `e.attempt` directly off the event.
 *
 * @example
 * ```ts
 * import { Engine, ActivityStartedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:started', (e: Event) => {
 *   const ev = e as ActivityStartedEvent;
 *   console.log('activity started:', ev.activityName, 'attempt', ev.attempt);
 * });
 * ```
 */
export class ActivityStartedEvent extends Event {
  static readonly type = 'activity:started' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;

  constructor(operationId: string, workflowId: string, activityName: string, attempt: number) {
    super(ActivityStartedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.attempt = attempt;
  }
}

/**
 * Fired on the {@link Engine} when an activity execution completes successfully.
 * Read `e.operationId`, `e.workflowId`, `e.activityName`, and `e.duration`
 * (milliseconds) to observe activity latency.
 *
 * @example
 * ```ts
 * import { Engine, ActivityCompletedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:completed', (e: Event) => {
 *   const ev = e as ActivityCompletedEvent;
 *   console.log(ev.activityName, 'completed in', ev.duration, 'ms');
 * });
 * ```
 */
export class ActivityCompletedEvent extends Event {
  static readonly type = 'activity:completed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly duration: number;

  constructor(operationId: string, workflowId: string, activityName: string, duration: number) {
    super(ActivityCompletedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.duration = duration;
  }
}

/**
 * Fired on the {@link Engine} when an activity defers to out-of-band completion
 * by calling `ctx.completeAsync()` from its {@link ActivityContext}. The
 * `token` is the durable, deterministic task token an external system passes to
 * `engine.completeAsyncActivity(token, result)` /
 * `engine.failAsyncActivity(token, error)` (or the matching
 * `client.activity.*` methods) to resume the workflow. The token survives
 * engine restart, so a callback that arrives after a crash still resolves the
 * right activity.
 *
 * @example
 * ```ts
 * import { Engine, ActivityAsyncPendingEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:async-pending', (e: Event) => {
 *   const ev = e as ActivityAsyncPendingEvent;
 *   console.log('awaiting external completion of', ev.activityName, 'token', ev.token);
 * });
 * ```
 */
export class ActivityAsyncPendingEvent extends Event {
  static readonly type = 'activity:async-pending' as const;
  readonly token: string;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;

  constructor(
    token: string,
    operationId: string,
    workflowId: string,
    activityName: string,
    attempt: number,
  ) {
    super(ActivityAsyncPendingEvent.type);
    this.token = token;
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.attempt = attempt;
  }
}

/**
 * Fired on the {@link Engine} when an activity execution throws an error.
 * Check `e.attempt` to distinguish first-attempt failures from retries.
 * Read `e.error` for the thrown error object. `attempt` is 1-indexed —
 * `attempt === 1` is the first execution; `attempt > 1` indicates a retry.
 *
 * @example
 * ```ts
 * import { Engine, ActivityFailedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:failed', (e: Event) => {
 *   const ev = e as ActivityFailedEvent;
 *   console.error(ev.activityName, 'attempt', ev.attempt, 'failed:', ev.error.message);
 * });
 * ```
 */
export class ActivityFailedEvent extends Event {
  static readonly type = 'activity:failed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly error: Error;
  readonly attempt: number;

  constructor(
    operationId: string,
    workflowId: string,
    activityName: string,
    error: Error,
    attempt: number,
  ) {
    super(ActivityFailedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.error = error;
    this.attempt = attempt;
  }
}
