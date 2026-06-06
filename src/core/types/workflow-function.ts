import { validateWorkflowOrActivityName } from './name-grammar.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type { ActivityMap, QueryMap, SignalMap, UpdateMap } from './workflow-builder-helpers.ts';
import { WorkflowBuilderImpl, type WorkflowBuilderOptions } from './workflow-builder-runtime.ts';
import type { InitialBuilderState, WorkflowBuilder } from './workflow-builder.ts';
import type { WorkflowContext } from './workflow-context.ts';

export { WorkflowBuilderError, type WorkflowBuilderOptions } from './workflow-builder-runtime.ts';
export type { WorkflowDefinition } from './workflow-definition.ts';

// ---------------------------------------------------------------------------
// Workflow function signature
// ---------------------------------------------------------------------------

/**
 * Signature of a durable workflow generator function registered via
 * {@link Engine.register}. The engine calls it with a {@link WorkflowContext}
 * and the start `input`, then drives the generator by feeding operation
 * results back via `next`. Use `yield*` (delegated yield) when calling
 * context methods (`ctx.run(...)`, `ctx.sleep(...)`, `ctx.review(...)`);
 * a bare `yield` will not produce the operation results expected by the
 * engine.
 *
 * @example
 * ```ts
 * import { workflow, activity, Engine, type WorkflowContext, type WorkflowFunction } from '@lostgradient/weft';
 *
 * const greet = activity({ name: 'greet', execute: async (input: string) => `hello ${input}` });
 *
 * const myWorkflow: WorkflowFunction<string, string> =
 *   async function* (ctx: WorkflowContext, input: string) {
 *     return yield* ctx.run(greet, input);
 *   };
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'myWorkflow' }).execute(myWorkflow));
 * void engine;
 * ```
 */
export type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;

// ---------------------------------------------------------------------------
// Step-based workflow types (progressive disclosure API)
// ---------------------------------------------------------------------------

/**
 * Simplified context for step-based ("progressive disclosure") workflows.
 * Instead of yielding operations via a generator, write a plain `async`
 * function and call `ctx.step(name, fn)` for each durable step. Compile the
 * function to a generator via {@link compileStepWorkflow}.
 *
 * @example
 * ```ts
 * import { workflow, Engine, compileStepWorkflow, type StepWorkflowContext } from '@lostgradient/weft';
 *
 * async function myStepWorkflow(ctx: StepWorkflowContext, input: unknown) {
 *   const result = await ctx.step('fetchData', async () => {
 *     return { data: input };
 *   });
 *   return result;
 * }
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'stepWorkflow' }).execute(compileStepWorkflow(myStepWorkflow)));
 * void engine;
 * ```
 */
export interface StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;
  /**
   * Run `fn` as a durable step. Each call routes through the same machinery as
   * `ctx.run(...)`: the engine assigns a positional replay slot, persists the
   * result to the checkpoint, and on crash recovery returns the stored result
   * without re-running `fn`. `name` is the durable activity label (timeline and
   * diagnostics only) — replay is keyed by position, not by name.
   *
   * Because durability is positional, you must `await` each step before
   * starting the next: steps must be queued in a deterministic order so the
   * original run and a recovered run agree on which slot is which. Firing steps
   * concurrently (so a continuation enqueues further steps in completion order)
   * can return a wrong cached value after a crash. For parallelism, durable
   * timers, or signals, use the generator API instead.
   */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Type alias for a plain async function that uses {@link StepWorkflowContext}
 * instead of a generator. Use with {@link compileStepWorkflow} to register
 * it on the engine. This is the "progressive disclosure" API for users who
 * prefer async/await over generator syntax.
 *
 * @example
 * ```ts
 * import { workflow, Engine, compileStepWorkflow, type StepWorkflowFunction } from '@lostgradient/weft';
 *
 * const process: StepWorkflowFunction = async (ctx, input) => {
 *   return ctx.step('transform', () => (input as string).toUpperCase());
 * };
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'process' }).execute(compileStepWorkflow(process)));
 * void engine;
 * ```
 */
export type StepWorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: StepWorkflowContext,
  input: TInput,
) => Promise<TOutput>;

/**
 * Returned by composition operators on {@link WorkflowContext} and durable
 * operation methods on {@link Context} (run, sleep, race, offload, etc.).
 * Use `yield*` to consume it inside a workflow generator function; the result
 * type is `TResult`.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowOperation, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'parent' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const items = input as string[];
 *     const op: WorkflowOperation<string[]> = ctx.map(items, 'child');
 *     return yield* op;
 *   }),
 * );
 * engine.register(
 *   workflow({ name: 'child' }).execute(async function* (_ctx: WorkflowContext, s: unknown) {
 *     return String(s).toUpperCase();
 *   }),
 * );
 * void engine;
 * ```
 */
export type WorkflowOperation<TResult> = Generator<unknown, TResult, unknown>;

/**
 * Accepted forms for specifying a child workflow in composition operators
 * (`ctx.pipe`, `ctx.map`, `ctx.reduce`): a registered workflow name string,
 * a {@link WorkflowFunction} reference, or a {@link StepWorkflowFunction}
 * reference. The engine resolves the actual workflow type at runtime.
 *
 * Prefer the workflow name string. Identity-based lookup of a function
 * reference only succeeds if the engine's `workflowTypesByHandler` map
 * contains the exact function passed in — but the builder API wraps the
 * user-supplied `fn` inside `workflow({ name }).execute(fn)` before storing
 * it on the definition, so the registered handler is not the same reference
 * as `fn`. Passing the bare `fn` to a composition operator after registering
 * via the builder will throw at runtime as an unregistered function. Use
 * the workflow name string (`ctx.pipe(['stage-one', 'stage-two'], input)`)
 * or the `definition.handler` of an already-built workflow definition.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type ChildWorkflowTarget, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'transform' }).execute(async function* (_ctx: WorkflowContext, input: unknown) {
 *     return String(input).toUpperCase();
 *   }),
 * );
 *
 * const target: ChildWorkflowTarget<unknown, string> = 'transform';
 * engine.register(
 *   workflow({ name: 'parent' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* ctx.map([input], target);
 *   }),
 * );
 * void engine;
 * ```
 */
export type ChildWorkflowTarget<TInput = unknown, TOutput = unknown> =
  | string
  | WorkflowFunction<TInput, TOutput>
  | StepWorkflowFunction<TInput, TOutput>;

/**
 * Options passed to child workflow invocations within `ctx.pipe`, `ctx.map`,
 * or `ctx.reduce`. Currently accepts an optional `id` to control the child
 * workflow ID.
 */
export type ChildWorkflowOptions = {
  id?: string;
};

/**
 * A single stage in a `ctx.pipe(stages, input)` composition chain. Pairs a
 * {@link ChildWorkflowTarget} with optional {@link ChildWorkflowOptions} such
 * as a custom child workflow ID. Use the object form when you need to pass
 * per-stage options; otherwise a bare {@link ChildWorkflowTarget} also works.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowPipeStage, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'step1' }).execute(async function* (_ctx: WorkflowContext, i: unknown) { return String(i); }));
 * engine.register(workflow({ name: 'step2' }).execute(async function* (_ctx: WorkflowContext, i: unknown) { return (i as string).trim(); }));
 *
 * engine.register(
 *   workflow({ name: 'pipeline' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const stages: [WorkflowPipeStage, WorkflowPipeStage] = [
 *       { type: 'step1' },
 *       { type: 'step2', options: { id: 'trim-step' } },
 *     ];
 *     return yield* ctx.pipe(stages, input);
 *   }),
 * );
 * void engine;
 * ```
 */
export interface WorkflowPipeStage<TInput = unknown, TOutput = unknown> {
  type: ChildWorkflowTarget<TInput, TOutput>;
  options?: ChildWorkflowOptions;
}

/**
 * Union of the two accepted formats for each stage passed to `ctx.pipe`:
 * either a full {@link WorkflowPipeStage} object with a `type` and optional
 * `options`, or a bare {@link ChildWorkflowTarget} (a string name or function
 * reference). The engine normalises both forms before executing.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowPipeStageDefinition, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'upper' }).execute(async function* (_ctx: WorkflowContext, i: unknown) {
 *     return String(i).toUpperCase();
 *   }),
 * );
 * engine.register(
 *   workflow({ name: 'trim' }).execute(async function* (_ctx: WorkflowContext, i: unknown) {
 *     return String(i).trim();
 *   }),
 * );
 *
 * const stages: [WorkflowPipeStageDefinition, WorkflowPipeStageDefinition] = ['upper', 'trim'];
 * engine.register(
 *   workflow({ name: 'pipeline' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* ctx.pipe(stages, input);
 *   }),
 * );
 * void engine;
 * ```
 */
export type WorkflowPipeStageDefinition<TInput = unknown, TOutput = unknown> =
  | WorkflowPipeStage<TInput, TOutput>
  | ChildWorkflowTarget<TInput, TOutput>;

/**
 * Options for `ctx.map(items, workflowType, options)`. Controls the maximum
 * number of child workflows that run simultaneously. Defaults to running all
 * items in parallel when `concurrency` is not set.
 * The actual fan-out is also bounded by `EngineOptions.maxNestingDepth`
 * (default 10) — passing a `concurrency` higher than the remaining nesting
 * budget will surface a runtime error, not silently throttle.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowMapOptions, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'processItem' }).execute(async function* (_ctx: WorkflowContext, item: unknown) {
 *     return String(item).toUpperCase();
 *   }),
 * );
 * engine.register(
 *   workflow({ name: 'batchProcess' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const items = input as string[];
 *     const options: WorkflowMapOptions = { concurrency: 3 };
 *     return yield* ctx.map(items, 'processItem', options);
 *   }),
 * );
 * void engine;
 * ```
 */
export interface WorkflowMapOptions {
  concurrency?: number;
}

/**
 * Input shape passed to each child workflow invocation within `ctx.reduce`.
 * Contains the running `accumulator`, the current `item`, and its zero-based
 * `index`. The child workflow's return value becomes the next accumulator.
 *
 * @example
 * ```ts
 * import { Engine, workflow, type WorkflowReduceInput, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'sumStep' }).execute(async function* (
 *     _ctx: WorkflowContext,
 *     input: WorkflowReduceInput<number, number>,
 *   ) {
 *     const { accumulator, item } = input;
 *     return accumulator + item;
 *   }),
 * );
 *
 * engine.register(
 *   workflow({ name: 'sumAll' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const items = input as number[];
 *     return yield* ctx.reduce(items, 'sumStep', 0);
 *   }),
 * );
 * void engine;
 * ```
 */
export interface WorkflowReduceInput<TAccumulator, TItem> {
  accumulator: TAccumulator;
  item: TItem;
  index: number;
}

/**
 * Options for `ctx.reduce(items, workflowType, initialValue, options)`.
 * Supply `idPrefix` to give each generated child workflow ID a deterministic
 * prefix, which helps with idempotency and debugging.
 *
 * @example
 * ```ts
 * import { Engine, workflow, type WorkflowReduceOptions, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'merge' }).execute(async function* (
 *     _ctx: WorkflowContext,
 *     input: { accumulator: string[]; item: string },
 *   ) {
 *     const { accumulator, item } = input;
 *     return [...accumulator, item];
 *   }),
 * );
 * engine.register(
 *   workflow({ name: 'collect' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const items = input as string[];
 *     const opts: WorkflowReduceOptions = { idPrefix: 'collect-merge' };
 *     return yield* ctx.reduce(items, 'merge', [], opts);
 *   }),
 * );
 * void engine;
 * ```
 */
export interface WorkflowReduceOptions extends Record<string, unknown> {
  idPrefix?: string;
}

/**
 * Create a workflow via the chained builder API.
 *
 * @example
 * ```ts
 * import { workflow, signal } from '@lostgradient/weft';
 *
 * const welcome = workflow({ name: 'welcome' })
 *   .activities({
 *     formatGreeting: async ({ name }: { name: string }) => `Hello, ${name}!`,
 *   })
 *   .signals({ approve: signal<{ approverId: string }>('approve') })
 *   .execute(async function* (ctx, input: { name: string }) {
 *     const greeting = yield* ctx.run('formatGreeting', input);
 *     const { approverId } = yield* ctx.waitForSignal('approve');
 *     return { greeting, approverId };
 *   });
 * void welcome;
 * ```
 */
export function workflow<const TName extends string>(
  options: WorkflowBuilderOptions<TName>,
): WorkflowBuilder<TName, {}, {}, {}, {}, {}, InitialBuilderState> {
  if (!options.name) {
    throw new Error('workflow() requires an options object with a name.');
  }
  validateWorkflowOrActivityName(options.name, 'workflow');

  const builder = new WorkflowBuilderImpl(options);
  // The class implements the structural shape `WorkflowBuilder` describes; the
  // assertion is the cast boundary that lets the runtime class satisfy the
  // phantom-flag-typed interface without leaking the implementation type.
  return builder as unknown as WorkflowBuilder<
    TName,
    ActivityMap,
    SignalMap,
    UpdateMap,
    QueryMap,
    SearchAttributeSchema,
    InitialBuilderState
  >;
}
