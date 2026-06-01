import type {
  ActivityExecutionInterception,
  ActivityInterception,
  ChildWorkflowInterception,
  QueryInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowStartInterception,
} from './interception-contexts.ts';

// Interceptor interfaces
// ---------------------------------------------------------------------------

/**
 * Middleware interface for workflow-side interception. Each hook is optional
 * — implement only the hooks you need. Hooks are generator functions that
 * receive an interception context and a `next` callback; call `yield* next(ctx)`
 * to pass control to the next interceptor in the chain.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowInterceptor } from '@lostgradient/weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *activity(ctx, next) {
 *     console.log('activity started:', ctx.activityName);
 *     const result = yield* next(ctx);
 *     console.log('activity done:', ctx.activityName);
 *     return result;
 *   },
 * };
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * void engine;
 * void tracer;
 * ```
 */
export interface WorkflowInterceptor {
  activity?(
    interception: ActivityInterception,
    next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  sleep?(
    interception: SleepInterception,
    next: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown>;

  waitForSignal?(
    interception: SignalInterception,
    next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  workflowStart?(
    interception: WorkflowStartInterception,
    next: (interception: WorkflowStartInterception) => void,
  ): void;

  childWorkflow?(
    interception: ChildWorkflowInterception,
    next: (interception: ChildWorkflowInterception) => Promise<unknown>,
  ): Promise<unknown>;

  query?(
    interception: QueryInterception,
    next: (interception: QueryInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  signalReceived?(
    interception: SignalReceivedInterception,
    next: (interception: SignalReceivedInterception) => void,
  ): void;
}

/**
 * Internal: the canonical list of workflow-side hook names. Used by
 * {@link splitInterceptors} to route a unified `Interceptor` instance into
 * the workflow-side pipeline. Frozen so consumers (and we) cannot mutate
 * the array at runtime — the type system already marks it readonly, but
 * the runtime array would otherwise be mutable.
 *
 * Not exported from the package root: this is an implementation detail.
 * The `interceptor-types.test.ts` exhaustiveness assertions guarantee
 * this stays in sync with `WorkflowInterceptor`.
 */
export const WORKFLOW_INTERCEPTOR_HOOKS = Object.freeze([
  'activity',
  'sleep',
  'waitForSignal',
  'workflowStart',
  'childWorkflow',
  'query',
  'signalReceived',
] as const);

/**
 * Middleware interface for activity-execution interception. Runs on the
 * side that actually executes the activity function (main thread or worker).
 * Implement `execute` to add retry logging, tracing, or input/output transforms.
 *
 * @example
 * ```ts
 * import { Engine, type ActivityInterceptor } from '@lostgradient/weft';
 *
 * const logger: ActivityInterceptor = {
 *   async execute(ctx, next) {
 *     const result = await next(ctx);
 *     console.log(ctx.activityName, 'attempt', ctx.attempt, 'succeeded');
 *     return result;
 *   },
 * };
 * void logger;
 * ```
 */
export interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}

/**
 * Unified interceptor surface accepted by the engine. Implement hooks from
 * either the workflow side, the activity side, or both; each interceptor
 * participates in whichever pipeline has matching hooks.
 *
 * @example
 * ```ts
 * import { Engine, type Interceptor } from '@lostgradient/weft';
 *
 * const tracer: Interceptor = {
 *   *activity(interception, next) {
 *     return yield* next(interception);
 *   },
 *   async execute(interception, next) {
 *     return next(interception);
 *   },
 * };
 *
 * const engine = new Engine({ interceptors: [tracer] });
 * void engine;
 * ```
 */
export interface Interceptor extends WorkflowInterceptor, ActivityInterceptor {}

// ---------------------------------------------------------------------------
// Composed interceptor interfaces
// ---------------------------------------------------------------------------

/**
 * The fully-composed workflow interceptor produced by
 * {@link composeWorkflowInterceptors}. All hooks are non-optional — the
 * composition fills in pass-through implementations for any hooks not
 * provided by the individual interceptors. Used internally by the engine.
 *
 * @example
 * ```ts
 * import { composeWorkflowInterceptors, type ComposedWorkflowInterceptor } from '@lostgradient/weft';
 * import type { WorkflowInterceptor } from '@lostgradient/weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *activity(ctx, next) {
 *     console.log('activity:', ctx.activityName);
 *     return yield* next(ctx);
 *   },
 * };
 *
 * const composed: ComposedWorkflowInterceptor = composeWorkflowInterceptors([tracer]);
 * void composed;
 * ```
 */
export interface ComposedWorkflowInterceptor {
  activity(
    interception: ActivityInterception,
    execute: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  sleep(
    interception: SleepInterception,
    execute: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown>;

  waitForSignal(
    interception: SignalInterception,
    execute: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  workflowStart(
    interception: WorkflowStartInterception,
    execute: (interception: WorkflowStartInterception) => void,
  ): void;

  childWorkflow(
    interception: ChildWorkflowInterception,
    execute: (interception: ChildWorkflowInterception) => Promise<unknown>,
  ): Promise<unknown>;

  query(
    interception: QueryInterception,
    execute: (interception: QueryInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  signalReceived(
    interception: SignalReceivedInterception,
    execute: (interception: SignalReceivedInterception) => void,
  ): void;
}

/**
 * The fully-composed activity interceptor produced by
 * {@link composeActivityInterceptors}. The `execute` hook is always present.
 * Used internally by the engine to drive activity execution.
 *
 * @example
 * ```ts
 * import { composeActivityInterceptors, type ComposedActivityInterceptor } from '@lostgradient/weft';
 * import type { ActivityInterceptor } from '@lostgradient/weft';
 *
 * const logger: ActivityInterceptor = {
 *   async execute(ctx, next) {
 *     const result = await next(ctx);
 *     console.log(ctx.activityName, 'done');
 *     return result;
 *   },
 * };
 *
 * const composed: ComposedActivityInterceptor = composeActivityInterceptors([logger]);
 * void composed;
 * ```
 */
export interface ComposedActivityInterceptor {
  execute(
    interception: ActivityExecutionInterception,
    execute: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}
