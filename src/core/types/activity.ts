import type { ActivityVerifier } from './activity-verification.ts';
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
 * import type { ActivityFunction } from '@lostgradient/weft';
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
 * import { activity, type ActivityContext } from '@lostgradient/weft';
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
  /**
   * Durable token for the workflow run that launched this activity. It changes
   * when a stable workflow id is replaced with `onTerminalConflict: 'start-new'`
   * and stays stable for recovery of the same run.
   */
  workflowExecutionToken?: string;
  /**
   * Token for this specific activity dispatch attempt. It changes on retry and
   * can be copied into external writes to reject stale late completions.
   */
  activityAttemptToken?: string;
  heartbeat(details?: unknown): void;
  /**
   * The heartbeat payload recorded by the PREVIOUS attempt of this activity, or
   * `undefined` if there is none. This is the resumable-batch pattern: a
   * long-running activity that calls `ctx.heartbeat({ done: n })` to record its
   * progress can read `ctx.lastHeartbeatDetails` on a retry and skip the work it
   * already finished, instead of re-running from the start and producing
   * duplicate side effects.
   *
   * It is `undefined` on the first attempt, after an engine restart (the value is
   * held in engine memory, never checkpointed), and for worker-executed
   * activities (which run their function out of process and never observe this).
   * Because it is non-durable, treat it as a best-effort optimization: a correct
   * activity must still produce the right result when `lastHeartbeatDetails` is
   * `undefined`. For a durability guarantee, persist progress in workflow state
   * (e.g. one `ctx.run` per batch with an `idempotencyKey`) instead.
   *
   * Only top-level `ctx.run` activities retry, so this is only ever populated
   * there. An activity called inside `ctx.all` / `ctx.race` does not retry, so its
   * `lastHeartbeatDetails` is always `undefined`.
   *
   * @example
   * ```ts
   * import { activity, type ActivityContext } from '@lostgradient/weft';
   *
   * function resumeFrom(details: unknown): number {
   *   return typeof details === 'object' && details !== null && 'done' in details &&
   *     typeof (details as { done: unknown }).done === 'number'
   *     ? (details as { done: number }).done
   *     : 0;
   * }
   *
   * const postBatches = activity({
   *   name: 'postBatches',
   *   execute: async (batches: string[][], ctx?: ActivityContext) => {
   *     let done = resumeFrom(ctx?.lastHeartbeatDetails);
   *     for (; done < batches.length; done += 1) {
   *       await postBatch(batches[done]!);
   *       ctx?.heartbeat({ done: done + 1 });
   *     }
   *     return { posted: done };
   *   },
   * });
   * declare function postBatch(batch: string[]): Promise<void>;
   * void postBatches;
   * ```
   */
  lastHeartbeatDetails?: unknown;
  /**
   * Defer this activity to out-of-band completion. Calling `completeAsync()`
   * hands the work off to an external system — a webhook, a human callback, a
   * third-party async job — and suspends the workflow at this step until
   * something outside the engine resolves the activity by its task token via
   * `engine.completeAsyncActivity(token, result)` /
   * `engine.failAsyncActivity(token, error)` (or the matching
   * `client.activity.*` methods).
   *
   * The durable task token is announced on the engine as an
   * `activity:async-pending` event (listen for it to receive the token).
   * The token is deterministic and survives engine restart: it is re-minted
   * identically when the activity replays after recovery.
   *
   * Security: the token is a deterministic identifier, NOT a secret. When the
   * completion endpoint is reachable by untrusted callers, anyone who can infer
   * a workflow id can forge this activity's result or error. Treat the completed
   * value as hostile external input (validate it as you would a signal payload),
   * and gate the mutating surface with `serve({ auth })` if completions must not
   * be anonymous.
   *
   * `completeAsync()` never returns normally — it throws an internal sentinel
   * that the engine recognizes to park the activity. Call it as the last
   * statement of (or `return` it from) the activity, and do not catch the
   * thrown sentinel.
   *
   * @example
   * ```ts
   * import { activity, type ActivityContext } from '@lostgradient/weft';
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
 * import { workflow, activity, Engine, type ActivityCallOptions, type WorkflowContext } from '@lostgradient/weft';
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
  /**
   * Total wall-clock budget for this activity across ALL retry attempts and the
   * backoff waits between them — close to Temporal's `scheduleToCloseTimeout`.
   * Unlike `timeout` (a per-attempt cap, reset on every attempt), this budget is
   * measured from the first dispatch and is not reset between attempts. When the
   * budget bars the next attempt, the activity fails with an
   * {@link ActivityScheduleToCloseTimeoutError} (a `timeout` failure category).
   *
   * Enforcement is at the **retry decision point**, not by waiting out the clock:
   * the activity fails when the next retry's backoff would start it at or after the
   * deadline (or when an attempt has already overrun the budget), rather than
   * parking for a backoff that is already doomed. So a retry whose backoff would
   * overshoot the budget is skipped immediately even though the actual elapsed time
   * is still under the budget — the error reports the actual elapsed time and the
   * projected next-dispatch that triggered the decision.
   *
   * It has **no effect unless a retry policy is configured** — a non-retried
   * activity fails on its first error before the budget is ever consulted. Use
   * `timeout` to bound a single attempt. It also applies to top-level `ctx.run`
   * activities only; an activity inside `ctx.all` / `ctx.race` does not retry, so
   * this budget never engages there.
   */
  scheduleToCloseTimeout?: Duration;
}

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
 * import { activity, type ActivityDefinition } from '@lostgradient/weft';
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
   * Optional verifier, invoked in two phases (see
   * `ActivityVerificationContext.phase`).
   *
   * During normal post-execution validation, return `true` to confirm the
   * activity result or `false` to reject it. During pre-dispatch crash recovery
   * for keyed activities, return an explicit reconciliation state. A boolean is
   * the post-execution result shape, not a Tier-0 reconciliation state, so a
   * boolean returned during pre-dispatch reconciliation fails closed rather than
   * being treated as proof of external completion.
   */
  verify?: ActivityVerifier<TInput, TOutput>;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
  /** Visibility timeout for this activity. Defaults to 30 seconds. */
  visibilityTimeout?: Duration;
  /**
   * Total wall-clock budget across all retry attempts and their backoff waits,
   * measured from the first dispatch. The per-call {@link ActivityCallOptions.scheduleToCloseTimeout}
   * overrides this default. Enforced at the retry decision point (the activity
   * fails when the next retry would start at or after the deadline, not by waiting
   * out the clock), so it only engages for a retried, top-level `ctx.run` activity.
   * See the per-call option for the full contract.
   */
  scheduleToCloseTimeout?: Duration;
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
 * import { activity, type ActivityCallable } from '@lostgradient/weft';
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
 * import { activity } from '@lostgradient/weft';
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
