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
 * engine.addEventListener(ActivityStartedEvent.type, (event) => {
 *   console.log('activity started:', event.activityName, 'attempt', event.attempt);
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
 * engine.addEventListener(ActivityCompletedEvent.type, (event) => {
 *   console.log(event.activityName, 'completed in', event.duration, 'ms');
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
 * engine.addEventListener(ActivityAsyncPendingEvent.type, (event) => {
 *   console.log('awaiting external completion of', event.activityName, 'token', event.token);
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
 * engine.addEventListener(ActivityFailedEvent.type, (event) => {
 *   console.error(event.activityName, 'attempt', event.attempt, 'failed:', event.error.message);
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

/**
 * Fired on the {@link Engine} when a remote worker task result cannot be
 * durably moved from in-flight to resolved after storage retries are exhausted.
 * The durable dead-letter guard prevents reconciliation from silently
 * re-dispatching the already-completed worker attempt until an operator clears
 * the diagnostic entry.
 *
 * @example
 * ```ts
 * import { Engine, TaskResultDeadLetteredEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(TaskResultDeadLetteredEvent.type, (event) => {
 *   console.warn('task dead-lettered:', event.operationId, event.reason);
 * });
 * ```
 */
export class TaskResultDeadLetteredEvent extends Event {
  static readonly type = 'task:dead-lettered' as const;
  readonly operationId: string;
  readonly workflowId: string | undefined;
  readonly activityName: string | undefined;
  readonly queue: string | undefined;
  readonly workerId: string | undefined;
  readonly reason: 'result-resolution-storage-exhausted';
  readonly errorMessage: string;

  constructor({
    operationId,
    workflowId,
    activityName,
    queue,
    workerId,
    errorMessage,
  }: {
    operationId: string;
    workflowId?: string | undefined;
    activityName?: string | undefined;
    queue?: string | undefined;
    workerId?: string | undefined;
    errorMessage: string;
  }) {
    super(TaskResultDeadLetteredEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.queue = queue;
    this.workerId = workerId;
    this.reason = 'result-resolution-storage-exhausted';
    this.errorMessage = errorMessage;
  }
}
