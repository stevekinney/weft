import type { DefinitionSchema, InferSchemaOutput } from './definition-schema.ts';
import { validateWorkflowOrActivityName } from './name-grammar.ts';
import type { Duration, RetryPolicy } from './retry-retention.ts';

// ---------------------------------------------------------------------------
// Activity function type
// ---------------------------------------------------------------------------

/**
 * Type signature for an activity execute function. Receives the activity
 * input and an optional {@link ActivityContext} (for heartbeating and
 * cancellation signals), and returns a value or a promise. Use this type
 * when defining the `execute` field of an {@link ActivityDefinition}.
 *
 * @example
 * ```ts
 * import type { ActivityFunction } from 'weft';
 *
 * const fetchUserFn: ActivityFunction<string, { id: string; name: string }> =
 *   async (input, ctx) => {
 *     ctx?.signal.throwIfAborted();
 *     const response = await fetch(`https://api.example.com/users/${input}`);
 *     return (await response.json()) as { id: string; name: string };
 *   };
 * void fetchUserFn;
 * ```
 */
export type ActivityFunction<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ActivityContext,
) => Promise<TOutput> | TOutput;

// ---------------------------------------------------------------------------
// Activity context passed to activity functions
// ---------------------------------------------------------------------------

/**
 * Runtime context injected as the second argument of every activity execute
 * function. Use `signal` to honour cancellation, and call `heartbeat` to
 * report progress and extend the activity's visibility timeout on long-running
 * work.
 *
 * @example
 * ```ts
 * import { activity, type ActivityContext } from 'weft';
 *
 * const processChunks = activity({
 *   name: 'processChunks',
 *   execute: async (input: unknown, ctx?: ActivityContext) => {
 *     const items = input as string[];
 *     for (const item of items) {
 *       ctx?.signal.throwIfAborted();
 *       ctx?.heartbeat({ processed: item });
 *     }
 *     return items.length;
 *   },
 * });
 * void processChunks;
 * ```
 */
export interface ActivityContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
  /**
   * Defer this activity to out-of-band completion. Calling `completeAsync()`
   * hands the work off to an external system — a webhook, a human callback, a
   * third-party async job — and suspends the workflow at this step until
   * something outside the engine resolves the activity by its task token via
   * `engine.completeAsyncActivity(token, result)` /
   * `engine.failAsyncActivity(token, error)` (or the matching
   * `client.activity.*` methods).
   *
   * The returned task token is durable and deterministic: it is announced on
   * the engine as an `activity:async-pending` event, survives engine restart,
   * and is re-minted identically when the activity replays after recovery.
   *
   * `completeAsync()` never returns normally — it throws an internal sentinel
   * that the engine recognizes to park the activity. Call it as the last
   * statement of (or `return` it from) the activity, and do not catch the
   * thrown sentinel.
   *
   * @example
   * ```ts
   * import { activity, type ActivityContext } from 'weft';
   *
   * const awaitWebhook = activity({
   *   name: 'awaitWebhook',
   *   execute: async (input: { callbackUrl: string }, ctx?: ActivityContext) => {
   *     await fetch(input.callbackUrl, { method: 'POST' });
   *     return ctx!.completeAsync();
   *   },
   * });
   * void awaitWebhook;
   * ```
   */
  completeAsync(): never;
}

// ---------------------------------------------------------------------------
// Per-invocation activity options
// ---------------------------------------------------------------------------

/**
 * Per-invocation overrides when calling an activity from a workflow via
 * `ctx.run(activity, input, options)`. Any field overrides the
 * activity's own defaults for that single call. Useful for increasing the
 * timeout on a retried call or routing to a specific queue.
 *
 * @example
 * ```ts
 * import { workflow, activity, Engine, type ActivityCallOptions, type WorkflowContext } from 'weft';
 *
 * const slowTask = activity({ name: 'slowTask', execute: async (i: unknown) => i });
 * const engine = new Engine();
 *
 * engine.register(
 *   workflow({ name: 'example' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const options: ActivityCallOptions = { timeout: '5m', queue: 'heavy' };
 *     const result = yield* ctx.run(slowTask, input, options);
 *     return result;
 *   }),
 * );
 * void engine;
 * ```
 */
export interface ActivityCallOptions {
  timeout?: Duration;
  queue?: string;
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  sticky?: boolean;
  /** Override the default visibility timeout for this invocation. */
  visibilityTimeout?: Duration;
}

/**
 * Identifies whether an activity verifier is checking a fresh result or
 * reconciling a prior keyed dispatch before redispatch.
 *
 * @example
 * ```ts
 * import type { ActivityVerificationPhase } from 'weft';
 *
 * const phase: ActivityVerificationPhase = 'pre-dispatch-reconciliation';
 * console.log(phase);
 * ```
 */
export type ActivityVerificationPhase = 'post-execution-validation' | 'pre-dispatch-reconciliation';

/**
 * Metadata passed to a Tier-0 activity verifier.
 *
 * @example
 * ```ts
 * import type { ActivityVerificationContext } from 'weft';
 *
 * function shouldQueryExternalSystem(context: ActivityVerificationContext): boolean {
 *   return context.phase === 'pre-dispatch-reconciliation';
 * }
 * ```
 */
export interface ActivityVerificationContext<TInput = unknown> {
  phase: ActivityVerificationPhase;
  workflowId: string;
  activityName: string;
  operationId: string;
  input: TInput;
  idempotencyKey?: string;
  attempt: number;
}

/**
 * Return value for activity verification. Post-execution validation uses a
 * boolean; pre-dispatch reconciliation can report whether a prior keyed side
 * effect completed, did not complete, or is indeterminate.
 *
 * @example
 * ```ts
 * import type { ActivityVerificationResult } from 'weft';
 *
 * const result: ActivityVerificationResult<string> = {
 *   status: 'completed-with-result',
 *   result: 'already-finished',
 * };
 * console.log(result.status);
 * ```
 */
export type ActivityVerificationResult<TOutput = unknown> =
  | boolean
  | 'not-completed'
  | 'completed-result-unavailable'
  | 'indeterminate'
  | { status: 'completed-with-result'; result: TOutput };

export type ActivityPostExecutionVerifier<TOutput = unknown> = {
  bivarianceHack(result: TOutput): Promise<boolean> | boolean;
}['bivarianceHack'];

export type ActivityTier0Verifier<TInput = unknown, TOutput = unknown> = {
  bivarianceHack(
    result: TOutput | undefined,
    context: ActivityVerificationContext<TInput>,
  ): Promise<ActivityVerificationResult<TOutput>> | ActivityVerificationResult<TOutput>;
}['bivarianceHack'];

export type ActivityVerifier<TInput = unknown, TOutput = unknown> =
  | ActivityPostExecutionVerifier<TOutput>
  | ActivityTier0Verifier<TInput, TOutput>;

// ---------------------------------------------------------------------------
// Activity metadata (from activity() helper)
// ---------------------------------------------------------------------------

/**
 * Full metadata for an activity, combining the execute function with optional
 * retry policy, timeout, queue routing, compensation, and idempotency. Built
 * by the {@link activity} helper which returns a value that satisfies both
 * `ActivityDefinition` and the callable function interface.
 *
 * @example
 * ```ts
 * import { activity, type ActivityDefinition } from 'weft';
 *
 * const sendEmail: ActivityDefinition<{ to: string; body: string }, void> = activity({
 *   name: 'sendEmail',
 *   timeout: '30s',
 *   retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '10s' },
 *   execute: async (input: { to: string; body: string }) => {
 *     const { to, body } = input;
 *     console.log(`Sending to ${to}: ${body}`);
 *   },
 * });
 * void sendEmail;
 * ```
 */
export interface ActivityDefinition<
  TInput = unknown,
  TOutput = unknown,
  TName extends string = string,
> {
  /** Stable activity name used for registration, dispatch, and introspection. */
  name: TName;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; registration validates metadata shape only. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; registration validates metadata shape only. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** Activity implementation called by the engine or worker. */
  execute: ActivityFunction<TInput, TOutput>;
  /**
   * Optional post-execution verifier.
   *
   * During normal post-execution validation, return `true` to confirm the
   * activity result or `false` to reject it. During pre-dispatch crash recovery
   * for keyed activities, return an explicit reconciliation state; legacy boolean
   * answers are not treated as proof of external completion.
   */
  verify?: ActivityVerifier<TInput, TOutput>;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
  /** Visibility timeout for this activity. Defaults to 30 seconds. */
  visibilityTimeout?: Duration;
  /**
   * Optional compensation function. When defined and a saga step that ran this
   * activity needs to be rolled back, the engine calls `compensate(input, output)`
   * in reverse order for every step that completed before the failure.
   * Inline cancellation-triggered compensation is best-effort and runs outside
   * the durable activity pipeline; it is not replayed after an engine restart.
   *
   * `input` is the original input passed to `execute`.
   * `output` is the value returned by `execute` for that invocation.
   */
  compensate?: (input: TInput, output: TOutput) => Promise<void> | void;
  /**
   * Optional function that returns a resource scope string for this activity.
   * Used for resource-level locking or throttling; the returned string is
   * treated as an opaque identifier by the engine.
   */
  resourceScope?: (input: TInput) => string;
  /**
   * Optional function that returns an idempotency key specific to an
   * invocation. Takes precedence over `ActivityCallOptions.idempotencyKey`.
   */
  idempotencyKey?: (input: TInput) => string;
}

// ---------------------------------------------------------------------------
// activity() helper — wraps a function with colocated configuration
// ---------------------------------------------------------------------------

/**
 * Callable activity value returned by {@link activity}. It carries the activity
 * metadata used for registration and can also be invoked directly in tests or
 * helper code with the same single input value passed to `ctx.run`.
 *
 * @example
 * ```ts
 * import { activity, type ActivityCallable } from 'weft';
 *
 * const normalizeEmail: ActivityCallable<string, string> = activity(async function normalizeEmail(
 *   input: string,
 * ) {
 *   return input.trim().toLowerCase();
 * });
 *
 * const normalized = await normalizeEmail(' Ada@example.com ');
 * void normalized;
 * ```
 */
export type ActivityCallable<TInput, TOutput, TName extends string = string> = ActivityDefinition<
  TInput,
  TOutput,
  TName
> & {
  readonly _types?: {
    readonly input: TInput;
    readonly output: TOutput;
  };
} & ([TInput] extends [void]
    ? (input?: TInput, context?: ActivityContext) => Promise<TOutput>
    : (input: TInput, context?: ActivityContext) => Promise<TOutput>);

/**
 * Create an activity with colocated configuration.
 * The returned value is both an ActivityDefinition and a callable function.
 *
 * @example
 * ```ts
 * import { activity } from 'weft';
 *
 * const fetchUser = activity({
 *   name: 'fetchUser',
 *   execute: async (input: unknown) => {
 *     const id = input as string;
 *     return { id, name: 'Alice' };
 *   },
 * });
 *
 * // Use in a workflow via ctx.run:
 * // const user = yield* ctx.run(fetchUser, userId);
 * void fetchUser;
 * ```
 */
export function activity<TOutput>(
  execute: () => Promise<TOutput> | TOutput,
): ActivityCallable<void, TOutput>;
export function activity<TInput, TOutput>(
  execute: ActivityFunction<TInput, TOutput>,
): ActivityCallable<TInput, TOutput>;
export function activity<const TName extends string, TOutput>(
  options: Omit<ActivityDefinition<void, TOutput, TName>, 'execute'> & {
    execute: () => Promise<TOutput> | TOutput;
  },
): ActivityCallable<void, TOutput, TName>;
export function activity<
  const TName extends string,
  TInputSchema extends DefinitionSchema<unknown, unknown>,
  TOutputSchema extends DefinitionSchema<unknown, unknown>,
>(
  options: Omit<
    ActivityDefinition<InferSchemaOutput<TInputSchema>, InferSchemaOutput<TOutputSchema>, TName>,
    'inputSchema' | 'outputSchema'
  > & {
    inputSchema: TInputSchema;
    outputSchema: TOutputSchema;
  },
): ActivityCallable<InferSchemaOutput<TInputSchema>, InferSchemaOutput<TOutputSchema>, TName>;
export function activity<
  const TName extends string,
  TInputSchema extends DefinitionSchema<unknown, unknown>,
  TOutput,
>(
  options: Omit<
    ActivityDefinition<InferSchemaOutput<TInputSchema>, TOutput, TName>,
    'inputSchema'
  > & {
    inputSchema: TInputSchema;
  },
): ActivityCallable<InferSchemaOutput<TInputSchema>, TOutput, TName>;
export function activity<const TName extends string, TInput, TOutput>(
  options: ActivityDefinition<TInput, TOutput, TName>,
): ActivityCallable<TInput, TOutput, TName>;
export function activity<TInput, TOutput, TName extends string = string>(
  input: ActivityDefinition<TInput, TOutput, TName> | ActivityFunction<TInput, TOutput>,
): ActivityCallable<TInput, TOutput, TName> {
  const options =
    typeof input === 'function'
      ? ({
          name: input.name,
          execute: input,
        } satisfies ActivityDefinition<TInput, TOutput>)
      : input;

  if (!options.name) {
    throw new Error('activity() requires a named function or an options object with name.');
  }

  validateWorkflowOrActivityName(options.name, 'activity');

  // Schema metadata is validated at registration time by the activity registry
  // (`src/core/activity-registry.ts`), not here. Holding off on construction-time
  // validation keeps the helper transport-neutral and avoids double validation.

  const fn = ((inputValue: TInput, activityContext?: ActivityContext) =>
    options.execute(inputValue, activityContext)) as ActivityCallable<TInput, TOutput, TName>;

  // Assign non-function-builtin properties from options to the function
  const { name, execute, ...rest } = options;
  Object.assign(fn, rest);

  // Set name and execute as own properties (name is non-writable on functions,
  // so we must use defineProperty)
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'execute', { value: execute, enumerable: true, configurable: true });

  return fn;
}
