// Interception contexts (what each hook receives)
// ---------------------------------------------------------------------------

/**
 * Context object passed to workflow interceptors when an activity is scheduled.
 * Read-only snapshot of the activity call — modify via the `next` callback.
 *
 * @example
 * ```ts
 * import { Engine, type ActivityInterception } from 'weft';
 * import type { WorkflowInterceptor } from 'weft';
 *
 * const loggingInterceptor: WorkflowInterceptor = {
 *   *activity(ctx: ActivityInterception, next) {
 *     console.log('activity:', ctx.activityName, 'attempt:', ctx.attempt);
 *     return yield* next(ctx);
 *   },
 * };
 * // const engine = new Engine(); engine.addInterceptor(loggingInterceptor);
 * void loggingInterceptor;
 * ```
 */
export interface ActivityInterception {
  workflowId: string;
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `sleep` hook. Contains the
 * workflow ID, the requested sleep duration in milliseconds, and the outgoing
 * headers map. Modify headers inside the hook to propagate trace context.
 *
 * @example
 * ```ts
 * import { Engine, type SleepInterception } from 'weft';
 * import type { WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *sleep(ctx: SleepInterception, next) {
 *     console.log('sleep', ctx.duration, 'ms for', ctx.workflowId);
 *     return yield* next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface SleepInterception {
  workflowId: string;
  duration: number;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `waitForSignal` hook.
 * Contains the workflow ID, signal name, optional payload, and outgoing headers.
 *
 * @example
 * ```ts
 * import { type SignalInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *waitForSignal(ctx: SignalInterception, next) {
 *     console.log('waiting for signal', ctx.signalName);
 *     return yield* next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface SignalInterception {
  workflowId: string;
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `workflowStart` hook when
 * a new workflow begins executing. Useful for injecting trace headers or
 * enforcing policies at start time.
 *
 * @example
 * ```ts
 * import { type WorkflowStartInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   workflowStart(ctx: WorkflowStartInterception, next) {
 *     ctx.headers.set('x-trace-id', crypto.randomUUID());
 *     next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
}

/**
 * Context object passed to an {@link ActivityInterceptor}'s `execute` hook
 * during activity execution. Provides the activity name, input, attempt count,
 * headers, and optional cancellation signal for remote-worker execution.
 *
 * @example
 * ```ts
 * import { type ActivityExecutionInterception, type ActivityInterceptor } from 'weft';
 *
 * const logger: ActivityInterceptor = {
 *   async execute(ctx: ActivityExecutionInterception, next) {
 *     console.log('executing', ctx.activityName, 'attempt', ctx.attempt);
 *     const result = await next(ctx);
 *     return result;
 *   },
 * };
 * void logger;
 * ```
 */
export interface ActivityExecutionInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
  /** Operation identifier, available when executing on a remote worker. */
  operationId?: string;
  /** Abort signal for cancellation, available when executing on a remote worker. */
  signal?: AbortSignal;
}

/**
 * Context object passed to a workflow interceptor's `childWorkflow` hook when
 * a workflow spawns a child via `ctx.pipe`, `ctx.map`, or `ctx.reduce`.
 * Includes both the child's own headers and the parent's headers for trace
 * span linking.
 *
 * @example
 * ```ts
 * import { type ChildWorkflowInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   async childWorkflow(ctx: ChildWorkflowInterception, next) {
 *     console.log('spawning child', ctx.childWorkflowId, 'type:', ctx.workflowType);
 *     return next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface ChildWorkflowInterception {
  workflowId: string;
  childWorkflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
  /** Headers from the parent workflow, used for span link creation. */
  parentHeaders: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `query` hook when a
 * query is evaluated. Modify `headers` to propagate trace context; read
 * `queryName` for logging.
 *
 * @example
 * ```ts
 * import { type QueryInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *query(ctx: QueryInterception, next) {
 *     console.log('query:', ctx.queryName);
 *     return yield* next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface QueryInterception {
  queryName: string;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `signalReceived` hook
 * when an inbound signal arrives at the workflow. Allows interceptors to
 * inspect or modify the payload before the workflow handler processes it.
 *
 * @example
 * ```ts
 * import { type SignalReceivedInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   signalReceived(ctx: SignalReceivedInterception, next) {
 *     console.log('signal received:', ctx.signalName, 'for', ctx.workflowId);
 *     next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface SignalReceivedInterception {
  workflowId: string;
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}
