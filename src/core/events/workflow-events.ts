import type { TerminationReason } from '../types/history-policy.ts';

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
 * engine.addEventListener('workflow:started', (e: Event) => {
 *   const ev = e as WorkflowStartedEvent;
 *   console.log('started', ev.workflowId, ev.workflowType);
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
 * engine.addEventListener('workflow:completed', (e: Event) => {
 *   const ev = e as WorkflowCompletedEvent;
 *   console.log('completed in', ev.duration, 'ms, result:', ev.result);
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
 * engine.addEventListener('workflow:failed', (e: Event) => {
 *   const ev = e as WorkflowFailedEvent;
 *   console.error('workflow', ev.workflowId, 'failed:', ev.error.message);
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
 * engine.addEventListener('workflow:cancelled', (e: Event) => {
 *   const ev = e as WorkflowCancelledEvent;
 *   console.log('cancelled', ev.workflowId);
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
 * engine.addEventListener('workflow:timed-out', (e: Event) => {
 *   const ev = e as WorkflowTimedOutEvent;
 *   console.log(ev.workflowId, 'timed out after', ev.elapsed, 'ms (', ev.timeoutType, ')');
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
 * engine.addEventListener('workflow:resumed', (e: Event) => {
 *   const ev = e as WorkflowResumedEvent;
 *   console.log('resumed', ev.workflowId, 'from step', ev.fromStep);
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
 * engine.addEventListener('workflow:suspended', (e: Event) => {
 *   const ev = e as WorkflowSuspendedEvent;
 *   console.log('suspended', ev.workflowId);
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
 *   const skipped = event as WorkflowRecoverySkippedEvent;
 *   console.warn('skipped recovery for', skipped.workflowType);
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
