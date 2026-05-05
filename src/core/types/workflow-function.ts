import type { ConstraintDefinition } from '../constraint.ts';
import type { DefinitionSchema } from './definition-schema.ts';
import type { RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type { WorkflowContext } from './workflow-context.ts';

// ---------------------------------------------------------------------------
// Workflow function signature
// ---------------------------------------------------------------------------

/**
 * Signature of a durable workflow generator function registered via
 * {@link Engine.register}. The engine calls it with a {@link WorkflowContext}
 * and the start `input`, then drives the generator by feeding operation
 * results back via `next`. Use `yield*` (delegated yield) when calling
 * context methods (`ctx.run(...)`, `ctx.sleep(...)`, `ctx.agent(...)`);
 * a bare `yield` will not produce the operation results expected by the
 * engine.
 *
 * @example
 * ```ts
 * import { activity, Engine, type WorkflowContext, type WorkflowFunction } from 'weft';
 *
 * const greet = activity({ name: 'greet', execute: async (input: string) => `hello ${input}` });
 *
 * const myWorkflow: WorkflowFunction<string, string> =
 *   async function* (ctx: WorkflowContext, input: string) {
 *     return yield* ctx.run(greet, input);
 *   };
 *
 * const engine = new Engine();
 * engine.register('myWorkflow', myWorkflow);
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
 * import { Engine, compileStepWorkflow, type StepWorkflowContext } from 'weft';
 *
 * async function myStepWorkflow(ctx: StepWorkflowContext, input: unknown) {
 *   const result = await ctx.step('fetchData', async () => {
 *     return { data: input };
 *   });
 *   return result;
 * }
 *
 * const engine = new Engine();
 * engine.register('stepWorkflow', compileStepWorkflow(myStepWorkflow));
 * void engine;
 * ```
 */
export interface StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;
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
 * import { Engine, compileStepWorkflow, type StepWorkflowFunction } from 'weft';
 *
 * const process: StepWorkflowFunction = async (ctx, input) => {
 *   return ctx.step('transform', () => (input as string).toUpperCase());
 * };
 *
 * const engine = new Engine();
 * engine.register('process', compileStepWorkflow(process));
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
 * import { Engine, type WorkflowOperation, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('parent', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as string[];
 *   const op: WorkflowOperation<string[]> = ctx.map(items, 'child');
 *   return yield* op;
 * });
 * engine.register('child', async function* (_ctx: WorkflowContext, s: unknown) {
 *   return String(s).toUpperCase();
 * });
 * void engine;
 * ```
 */
export type WorkflowOperation<TResult> = Generator<unknown, TResult, unknown>;

/**
 * Accepted forms for specifying a child workflow in composition operators
 * (`ctx.pipe`, `ctx.map`, `ctx.reduce`): a registered workflow name string,
 * a {@link WorkflowFunction} reference, or a {@link StepWorkflowFunction}
 * reference. The engine resolves the actual workflow type at runtime.
 * Function references must be passed to `engine.register(name, fn)` *before*
 * they appear in composition operators — passing an unregistered function
 * reference throws at runtime.
 *
 * @example
 * ```ts
 * import { Engine, type ChildWorkflowTarget, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('transform', async function* (_ctx: WorkflowContext, input: unknown) {
 *   return String(input).toUpperCase();
 * });
 *
 * const target: ChildWorkflowTarget<unknown, string> = 'transform';
 * engine.register('parent', async function* (ctx: WorkflowContext, input: unknown) {
 *   return yield* ctx.map([input], target);
 * });
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
 * workflow ID; additional fields are reserved for future fields; today the
 * engine reads only `id` from this record and ignores other keys.
 */
export type ChildWorkflowOptions = Record<string, unknown> & {
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
 * import { Engine, type WorkflowPipeStage, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('step1', async function* (_ctx: WorkflowContext, i: unknown) { return String(i); });
 * engine.register('step2', async function* (_ctx: WorkflowContext, i: unknown) { return (i as string).trim(); });
 *
 * engine.register('pipeline', async function* (ctx: WorkflowContext, input: unknown) {
 *   const stages: [WorkflowPipeStage, WorkflowPipeStage] = [
 *     { type: 'step1' },
 *     { type: 'step2', options: { id: 'trim-step' } },
 *   ];
 *   return yield* ctx.pipe(stages, input);
 * });
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
 * import { Engine, type WorkflowPipeStageDefinition, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('upper', async function* (_ctx: WorkflowContext, i: unknown) {
 *   return String(i).toUpperCase();
 * });
 * engine.register('trim', async function* (_ctx: WorkflowContext, i: unknown) {
 *   return String(i).trim();
 * });
 *
 * const stages: [WorkflowPipeStageDefinition, WorkflowPipeStageDefinition] = ['upper', 'trim'];
 * engine.register('pipeline', async function* (ctx: WorkflowContext, input: unknown) {
 *   return yield* ctx.pipe(stages, input);
 * });
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
 * import { Engine, type WorkflowMapOptions, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('processItem', async function* (_ctx: WorkflowContext, item: unknown) {
 *   return String(item).toUpperCase();
 * });
 * engine.register('batchProcess', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as string[];
 *   const options: WorkflowMapOptions = { concurrency: 3 };
 *   return yield* ctx.map(items, 'processItem', options);
 * });
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
 * import { Engine, type WorkflowReduceInput, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('sumStep', async function* (
 *   _ctx: WorkflowContext,
 *   input: WorkflowReduceInput<number, number>,
 * ) {
 *   const { accumulator, item } = input;
 *   return accumulator + item;
 * });
 *
 * engine.register('sumAll', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as number[];
 *   return yield* ctx.reduce(items, 'sumStep', 0);
 * });
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
 * import { Engine, type WorkflowReduceOptions, type WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('merge', async function* (
 *   _ctx: WorkflowContext,
 *   input: { accumulator: string[]; item: string },
 * ) {
 *   const { accumulator, item } = input;
 *   return [...accumulator, item];
 * });
 * engine.register('collect', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as string[];
 *   const opts: WorkflowReduceOptions = { idPrefix: 'collect-merge' };
 *   return yield* ctx.reduce(items, 'merge', [], opts);
 * });
 * void engine;
 * ```
 */
export interface WorkflowReduceOptions extends Record<string, unknown> {
  idPrefix?: string;
}

// Workflow registration
// ---------------------------------------------------------------------------

/**
 * Full registration descriptor used when calling `engine.register(type, registration)`.
 * Bundles the workflow handler with optional metadata: version for live
 * migration, `searchAttributes` schema for indexing, a `retention` policy,
 * domain `constraints`, and a `migrate` callback that transforms checkpoint
 * state when versions differ.
 *
 * @example
 * ```ts
 * import { activity, Engine, type WorkflowRegistration, type WorkflowContext } from 'weft';
 *
 * const noop = activity({ name: 'noop', execute: async (i: unknown) => i });
 * const registration: WorkflowRegistration = {
 *   version: '1.0.0',
 *   retention: { completed: '7d' },
 *   handler: async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* ctx.run(noop, input);
 *   },
 * };
 * const engine = new Engine();
 * engine.register('myWorkflow', registration);
 * void engine;
 * ```
 */
export interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  /** Version recorded with workflow state and used for checkpoint migration. */
  version?: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; registration validates metadata shape only. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; registration validates metadata shape only. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** Workflow generator function executed by the engine. */
  handler: WorkflowFunction<TInput, TOutput>;
  /** Optional checkpoint migration from a prior workflow version. */
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  /** Search-attribute schema used to validate indexed workflow metadata. */
  searchAttributes?: SearchAttributeSchema;
  /** Retention policy for terminal workflow records. */
  retention?: RetentionPolicy;
  /**
   * Domain constraints evaluated at every checkpoint commit. When a constraint's
   * `check` returns false, the engine dispatches a `ConstraintViolatedEvent`
   * and reacts per `onViolation` ('fail' | 'compensate' | 'warn').
   *
   * **Note**: Constraints are only evaluated when using the default inline
   * execution strategy. Workflows running in a Web Worker
   * (`workerExecution` option) will silently skip constraint evaluation.
   */
  constraints?: ConstraintDefinition[];
}
/**
 * Named workflow definition returned by {@link workflow}. The runtime object
 * carries the workflow name plus the same metadata accepted by
 * {@link WorkflowRegistration}.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowDefinition } from 'weft';
 *
 * const greet: WorkflowDefinition<string, string> = workflow(async function* greet(ctx, input: string) {
 *   return `hello ${input}`;
 * });
 * ```
 */
export interface WorkflowDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends WorkflowRegistration<TInput, TOutput> {
  name: string;
}

export interface WorkflowDefinitionOptions<
  TInput = unknown,
  TOutput = unknown,
> extends WorkflowRegistration<TInput, TOutput> {
  name: string;
}

/**
 * Create a named workflow definition.
 *
 * @example
 * ```ts
 * import { workflow } from 'weft';
 *
 * const checkout = workflow({
 *   name: 'checkout',
 *   handler: async function* checkout(ctx, input: { orderId: string }) {
 *     return input.orderId;
 *   },
 * });
 * ```
 */
export function workflow<TInput, TOutput>(
  handler: WorkflowFunction<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput>;
export function workflow<TInput, TOutput>(
  options: WorkflowDefinitionOptions<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput>;
export function workflow<TInput, TOutput>(
  input: WorkflowFunction<TInput, TOutput> | WorkflowDefinitionOptions<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  const definition =
    typeof input === 'function'
      ? ({
          name: input.name,
          handler: input,
        } satisfies WorkflowDefinition<TInput, TOutput>)
      : input;

  if (!definition.name) {
    throw new Error('workflow() requires a named function or an options object with name.');
  }

  return definition;
}
