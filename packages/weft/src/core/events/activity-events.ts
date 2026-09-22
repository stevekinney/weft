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

/**
 * Fired on the {@link Engine} when `ctx.run()` durably enqueues a remote
 * activity task (COR-152) — the engine has just written the task's `queued`
 * ledger record on its own storage and is asking whichever transport is
 * currently attached (a `serve()`d server, or nothing at all) to dispatch it.
 * A `serve()` call listens for this event to attempt an immediate dispatch to
 * a connected worker; there is no requirement that anything is listening —
 * an engine with no server attached still leaves the task durably queued, and
 * the periodic reconciliation scan picks it up once a server does attach.
 *
 * This is purely a low-latency hint. Nothing about correctness depends on a
 * listener reacting to it: `RemoteActivityQueuedEvent` fires at most once per
 * fresh enqueue (never on an idempotent replay of an already-queued token),
 * and a listener that fails or is absent never blocks or fails the enqueue
 * itself.
 *
 * @example
 * ```ts
 * import { RemoteActivityQueuedEvent } from '@lostgradient/weft';
 *
 * const engineEvents = new EventTarget();
 *
 * engineEvents.addEventListener(RemoteActivityQueuedEvent.type, (event) => {
 *   const queued = event as RemoteActivityQueuedEvent;
 *   console.log('try dispatching', queued.operationId, 'on', queued.queue);
 * });
 *
 * engineEvents.dispatchEvent(new RemoteActivityQueuedEvent('order-4417', 'wf-1', 'default'));
 * ```
 */
export class RemoteActivityQueuedEvent extends Event {
  static readonly type = 'activity:remote-queued' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly queue: string;

  constructor(operationId: string, workflowId: string, queue: string) {
    super(RemoteActivityQueuedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.queue = queue;
  }
}

/**
 * Fired on the {@link Engine} when a pending async-activity token (whether
 * from `activityExecution: { mode: 'remote' }` or an application's own
 * `ctx.completeAsync()`) is discarded by terminal cleanup — the workflow it
 * belonged to reached ANY terminal state (completed, failed, cancelled,
 * timed out) while the token was still outstanding (acceptance criterion
 * 10). A `serve()`d server listens for this to best-effort request
 * cancellation of the matching durable task via the same `WeftServer.cancelTask`
 * path an operator-initiated cancellation uses — `cancelTask` itself is a
 * safe no-op for an `operationId` with no ledger record (an ordinary,
 * non-remote `ctx.completeAsync()` token), so this fires unconditionally
 * rather than needing to first determine the token's origin.
 *
 * Purely a best-effort hint, same posture as `RemoteActivityQueuedEvent`:
 * the workflow's own result waiter is already settled by terminal
 * transition machinery independent of whether anything reacts to this
 * event, and an in-flight remote attempt nothing cancels still resolves
 * eventually through the ledger's ordinary visibility-timeout/retry path.
 *
 * @example
 * ```ts
 * import { RemoteActivityCancellationRequestedEvent } from '@lostgradient/weft';
 *
 * const engineEvents = new EventTarget();
 *
 * engineEvents.addEventListener(
 *   RemoteActivityCancellationRequestedEvent.type,
 *   (event) => {
 *     const abandoned = event as RemoteActivityCancellationRequestedEvent;
 *     console.log('workflow', abandoned.workflowId, 'left', abandoned.operationId, 'outstanding');
 *   },
 * );
 *
 * engineEvents.dispatchEvent(
 *   new RemoteActivityCancellationRequestedEvent('order-4417', 'wf-1'),
 * );
 * ```
 */
export class RemoteActivityCancellationRequestedEvent extends Event {
  static readonly type = 'activity:remote-cancellation-requested' as const;
  readonly operationId: string;
  readonly workflowId: string;

  constructor(operationId: string, workflowId: string) {
    super(RemoteActivityCancellationRequestedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
  }
}
