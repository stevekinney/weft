import type { TerminationReason } from '../types/history-policy.ts';

/**
 * Fired on the {@link Engine} after a workflow definition is successfully
 * registered. Same-reference idempotent registration does not emit this event.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowDefinitionRegisteredEvent, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowDefinitionRegisteredEvent.type, (event) => {
 *   console.log('registered workflow:', event.workflowType);
 * });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * ```
 */
export class WorkflowDefinitionRegisteredEvent extends Event {
  static readonly type = 'workflow:definition-registered' as const;
  readonly workflowType: string;

  constructor(workflowType: string) {
    super(WorkflowDefinitionRegisteredEvent.type);
    this.workflowType = workflowType;
  }
}

/**
 * Fired on the {@link Engine} when a new workflow execution begins. Listen via
 * `engine.addEventListener('workflow:started', handler)` and read
 * `e.workflowId`, `e.workflowType`, and `e.input` directly off the event.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowStartedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowStartedEvent.type, (event) => {
 *   console.log('started', event.workflowId, event.workflowType);
 * });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * await engine.start('ping', null);
 * ```
 */
export class WorkflowStartedEvent extends Event {
  static readonly type = 'workflow:started' as const;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: unknown;

  constructor(workflowId: string, workflowType: string, input: unknown) {
    super(WorkflowStartedEvent.type);
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.input = input;
  }
}

/**
 * Fired on the {@link Engine} when a workflow finishes successfully. Contains
 * the `result` and wall-clock `duration` in milliseconds. Read `e.workflowId`,
 * `e.result`, and `e.duration` directly off the event object.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowCompletedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
 *   console.log('completed in', event.duration, 'ms, result:', event.result);
 * });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * await (await engine.start('ping', null)).result();
 * ```
 */
export class WorkflowCompletedEvent extends Event {
  static readonly type = 'workflow:completed' as const;
  readonly workflowId: string;
  readonly result: unknown;
  readonly duration: number;

  constructor(workflowId: string, result: unknown, duration: number) {
    super(WorkflowCompletedEvent.type);
    this.workflowId = workflowId;
    this.result = result;
    this.duration = duration;
  }
}

/**
 * Fired on the {@link Engine} when a workflow terminates with an unhandled error.
 * The `error` property holds the thrown `Error` object. Listen to diagnose
 * failures without polling `handle.state()`.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowFailedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowFailedEvent.type, (event) => {
 *   console.error('workflow', event.workflowId, 'failed:', event.error.message);
 * });
 * engine.register(workflow({ name: 'boom' }).execute(async function* () { throw new Error('oops'); }));
 * await engine.start('boom', null).then(h => h.result()).catch(() => undefined);
 * ```
 */
export class WorkflowFailedEvent extends Event {
  static readonly type = 'workflow:failed' as const;
  readonly workflowId: string;
  readonly error: Error;

  constructor(workflowId: string, error: Error) {
    super(WorkflowFailedEvent.type);
    this.workflowId = workflowId;
    this.error = error;
  }
}

/**
 * Fired on the {@link Engine} when a workflow is cancelled via
 * `engine.cancel(workflowId)` or `handle.cancel()`. Contains only
 * `e.workflowId` since there is no result or error.
 *
 * @example
 * ```ts
 * import { Engine, workflow, WorkflowCancelledEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
 *   console.log('cancelled', event.workflowId);
 * });
 * engine.register(
 *   workflow({ name: 'slow' }).execute(async function* (
 *     _ctx: import('@lostgradient/weft').WorkflowContext,
 *     _input: unknown,
 *   ) {
 *     await new Promise(() => {}); // never resolves
 *   }),
 * );
 * const handle = await engine.start('slow', null);
 * await handle.cancel();
 * ```
 */
export class WorkflowCancelledEvent extends Event {
  static readonly type = 'workflow:cancelled' as const;
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(WorkflowCancelledEvent.type);
    this.workflowId = workflowId;
  }
}

/**
 * Fired on the {@link Engine} when a workflow exceeds its execution or run
 * timeout. Read `e.timeoutType` (`'execution'` or `'run'`) and `e.elapsed`
 * (milliseconds) to understand which limit was hit. `e.reason` is populated
 * only when the workflow was forced to `timed-out` by the history circuit
 * breaker (it is `undefined` for ordinary deadline timeouts), so operators
 * reading the event stream can distinguish the two.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowTimedOutEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowTimedOutEvent.type, (event) => {
 *   console.log(event.workflowId, 'timed out after', event.elapsed, 'ms (', event.timeoutType, ')');
 * });
 * ```
 */
export class WorkflowTimedOutEvent extends Event {
  static readonly type = 'workflow:timed-out' as const;
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number;
  readonly reason?: TerminationReason;

  constructor(
    workflowId: string,
    timeoutType: 'execution' | 'run',
    elapsed: number,
    reason?: TerminationReason,
  ) {
    super(WorkflowTimedOutEvent.type);
    this.workflowId = workflowId;
    this.timeoutType = timeoutType;
    this.elapsed = elapsed;
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

/**
 * The workflow lifecycle event types that terminate a workflow. Derived from
 * the terminal event classes so the set cannot drift from their declared
 * `type`s. The single source of truth for "is this event terminal?" across the
 * engine's handle iterator and both client transports' live event streams — add
 * a new terminal event class here and every consumer picks it up.
 */
export const WORKFLOW_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  WorkflowCompletedEvent.type,
  WorkflowFailedEvent.type,
  WorkflowCancelledEvent.type,
  WorkflowTimedOutEvent.type,
]);

/**
 * Fired whenever a workflow resumes execution — after a signal, update, sleep,
 * activity completion, or process restart recovery.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowResumedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowResumedEvent.type, (event) => {
 *   console.log('resumed', event.workflowId, 'from step', event.fromStep);
 * });
 * ```
 */
export class WorkflowResumedEvent extends Event {
  static readonly type = 'workflow:resumed' as const;
  readonly workflowId: string;
  readonly fromStep: number;

  constructor(workflowId: string, fromStep: number) {
    super(WorkflowResumedEvent.type);
    this.workflowId = workflowId;
    this.fromStep = fromStep;
  }
}

/**
 * Fired when a running workflow is explicitly suspended via
 * `handle.suspend()` / `engine.suspend(id)`. Suspension is a non-terminal pause:
 * the workflow keeps its checkpoint and is later resumable. This event is
 * intentionally NOT in {@link WORKFLOW_TERMINAL_EVENT_TYPES} — a suspended
 * workflow has not ended, and `handle.result()` stays pending.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSuspendedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowSuspendedEvent.type, (event) => {
 *   console.log('suspended', event.workflowId);
 * });
 * ```
 */
export class WorkflowSuspendedEvent extends Event {
  static readonly type = 'workflow:suspended' as const;
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(WorkflowSuspendedEvent.type);
    this.workflowId = workflowId;
  }
}

/**
 * Reason carried by {@link WorkflowRecoverySkippedEvent}.
 *
 * @example
 * ```ts
 * import type { WorkflowRecoverySkippedReason } from '@lostgradient/weft';
 *
 * const reason: WorkflowRecoverySkippedReason = 'type-not-registered';
 * void reason;
 * ```
 */
export type WorkflowRecoverySkippedReason = 'type-not-registered';

/**
 * Fired during acknowledged recovery when a running workflow is intentionally
 * skipped because its workflow type is not registered on this engine. This
 * event is only emitted when `recoverAll({ acknowledgeUnknownWorkflowTypes:
 * true })` is used.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowRecoverySkippedEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowRecoverySkippedEvent.type, (event) => {
 *   console.warn('skipped recovery for', event.workflowType);
 * });
 * ```
 */
export class WorkflowRecoverySkippedEvent extends Event {
  static readonly type = 'workflow:recovery-skipped' as const;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly reason: WorkflowRecoverySkippedReason;

  constructor(workflowId: string, workflowType: string, reason: WorkflowRecoverySkippedReason) {
    super(WorkflowRecoverySkippedEvent.type);
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.reason = reason;
  }
}

/**
 * The lifecycle stage a {@link WorkflowTeardownEvent} reports for a workflow's
 * definition-level `finalizer` (issue #446):
 *
 * - `'completed'`: the finalizer succeeded — the external resource recorded via
 *   `ctx.setFinalizerState` has been torn down.
 * - `'failed'`: a single attempt failed; the engine backs off and re-fires unless the
 *   dead-letter horizon is reached. Per-attempt observability — fires on every retry.
 * - `'dead-lettered'`: the retry horizon was reached without success; the external
 *   resource may be leaked. The durable record is `KEYS.teardownDeadLetter`, which
 *   survives purge so the leak is auditable after the workflow record is gone.
 *
 * @example
 * ```ts
 * import type { WorkflowTeardownStatus } from '@lostgradient/weft';
 *
 * const status: WorkflowTeardownStatus = 'dead-lettered';
 * void status;
 * ```
 */
export type WorkflowTeardownStatus = 'completed' | 'failed' | 'dead-lettered';

/**
 * Fired on the {@link Engine} as a workflow's definition-level `finalizer` progresses
 * through teardown after a `cancelled`/`timed-out` terminal (issue #446). One event
 * type carries the stage in `status`; `attempts` is the attempt count; `error` is the
 * failure message on `'failed'`/`'dead-lettered'` (absent on `'completed'`). The schema is
 * stable and compact, and `status` is low-cardinality; `workflowId`/`workflowType` are
 * naturally high-cardinality identifiers. Keep `'failed'` listeners side-effect-light —
 * they fire on every retry.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowTeardownEvent } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.addEventListener(WorkflowTeardownEvent.type, (event) => {
 *   if (event.status === 'dead-lettered') {
 *     console.error('LEAKED resource: teardown for', event.workflowId, 'gave up after', event.attempts);
 *   } else {
 *     console.log('teardown', event.status, 'for', event.workflowId, 'attempt', event.attempts);
 *   }
 * });
 * ```
 */
export class WorkflowTeardownEvent extends Event {
  static readonly type = 'workflow:teardown' as const;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowTeardownStatus;
  readonly attempts: number;
  readonly error: string | undefined;

  constructor(
    workflowId: string,
    workflowType: string,
    status: WorkflowTeardownStatus,
    attempts: number,
    error?: string,
  ) {
    super(WorkflowTeardownEvent.type);
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.status = status;
    this.attempts = attempts;
    this.error = error;
  }
}
