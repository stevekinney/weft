/**
 * Workflow execution context.
 *
 * The Context class is the `ctx` parameter passed to workflow generator functions.
 * Each durable method is a generator that yields a {@link ContextOperationRequest}
 * descriptor. The Engine feeds results back via `generator.next(result)`.
 *
 * The Context does NOT execute activities or interact with storage directly.
 *
 * @module context
 */

import type { AgentTool } from '../ai/agent.ts';
import type { BudgetOptions, BudgetState } from '../ai/budget.ts';
import { BudgetTracker } from '../ai/budget.ts';
import type { ContextStrategy } from '../ai/context-window.ts';
import type {
  DebateOptions,
  DebateResult,
  HandoffOptions,
  HandoffResult,
  SuperviseOptions,
  SuperviseResult,
} from '../ai/coordination.ts';
import type { AgentHooks } from '../ai/hooks.ts';
import type { HumanReviewOptions, HumanReviewResult } from '../ai/human-review.ts';
import type { ModelRouter } from '../ai/model-router.ts';
import type { LLMProvider } from '../ai/providers/interface.ts';
import { parseDuration } from './scheduler.ts';
import { validateAttributeType } from './search-attributes.ts';
import { isAsyncGeneratorFunction, isGeneratorFunction } from './step-context.ts';
import type {
  ActivityCallOptions,
  ActivityDefinition,
  Duration,
  SearchAttributeSchema,
  SearchAttributeValue,
  WorkflowContext,
} from './types.ts';

// ---------------------------------------------------------------------------
// Saga step — pairs an ActivityDefinition with its input for use in ctx.saga()
// ---------------------------------------------------------------------------

/**
 * A single step in a saga: an activity definition and the input to pass to it.
 *
 * `TInput` and `TOutput` are inferred from the definition when using the
 * {@link sagaStep} factory so that `compensate` receives correctly-typed
 * arguments at the definition site. At the array boundary inside `ctx.saga`,
 * types are erased to `unknown` — the implementation guarantees that the input
 * passed to `execute` and `compensate` always matches what was supplied in the
 * original step object.
 */
export interface SagaStep<TInput = unknown, TOutput = unknown> {
  definition: ActivityDefinition<TInput, TOutput>;
  input: TInput;
}

// ---------------------------------------------------------------------------
// Erased saga step used as the saga() parameter element type.
//
// TypeScript's contravariance rules mean ActivityDefinition<string, string>
// cannot be assigned to ActivityDefinition<unknown, unknown> (the execute
// parameter type `string` is narrower than `unknown`). By using rest-args
// (...args: unknown[]) for the execute and compensate signatures — the same
// technique used by ctx.run() — we satisfy assignability for any concrete
// ActivityFunction, regardless of its declared input type.
//
// The nested structure mirrors SagaStep so callers can pass
// { definition: activityDefinition, input: value } objects directly.
// ---------------------------------------------------------------------------

// Method-syntax declarations use bivariant parameter checking under
// strictFunctionTypes, which lets ActivityDefinition<string, string>.execute
// (typed as a specific arrow function) be assigned to this interface.
// This intentional use of bivariance is the correct TypeScript idiom for
// "accept any callable with this shape" — the same approach used throughout
// the standard library (e.g., Array.prototype.sort compareFn).
interface ErasedActivityDefinition {
  name: string;
  execute(...args: unknown[]): unknown;
  compensate?(...args: unknown[]): unknown;
}

interface ErasedSagaStep {
  definition: ErasedActivityDefinition;
  input: unknown;
}

// ---------------------------------------------------------------------------
// Offload reference — returned by ctx.offload(), consumed by ctx.load()
// ---------------------------------------------------------------------------

export interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}

export interface StreamReference {
  key: string;
  workflowId: string;
  chunkCount: number;
  totalSizeBytes: number;
}

export interface StreamSink {
  heartbeat(details?: unknown): void;
}

// ---------------------------------------------------------------------------
// Agent context options
// ---------------------------------------------------------------------------

export interface AgentContextOptions {
  model: string;
  prompt: string;
  provider: LLMProvider;
  tools?: AgentTool[];
  maxTurns?: number;
  systemPrompt?: string;
  budget?: BudgetOptions;
  /** Namespace for organization-level budget enforcement. */
  budgetNamespace?: string;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
}

// ---------------------------------------------------------------------------
// Operation request descriptors
// ---------------------------------------------------------------------------

export type ContextOperationRequest =
  | {
      type: 'activity';
      operationId: string;
      activityName: string;
      fn: (...args: unknown[]) => unknown;
      args: unknown[];
      callerStack?: string;
      options?: Record<string, unknown>;
      /** Serialized interceptor headers (Map entries) for remote worker propagation. */
      headers?: [string, string][];
    }
  | {
      type: 'sleep';
      operationId: string;
      duration: number;
      scheduledFireAt: number;
      callerStack?: string;
    }
  | {
      type: 'wait-signal';
      operationId: string;
      signalName: string;
      callerStack?: string;
    }
  | {
      type: 'wait-update';
      operationId: string;
      updateName: string;
      callerStack?: string;
    }
  | {
      type: 'parallel';
      operationId: string;
      operations: ContextOperationRequest[];
      callerStack?: string;
    }
  | {
      type: 'race';
      operationId: string;
      operations: ContextOperationRequest[];
      callerStack?: string;
    }
  | {
      type: 'memo';
      operationId: string;
      key: string;
      fn: () => unknown;
      callerStack?: string;
    }
  | {
      type: 'child-workflow';
      operationId: string;
      workflowType: string;
      input: unknown;
      callerStack?: string;
      options?: Record<string, unknown>;
    }
  | {
      type: 'offload';
      operationId: string;
      key: string;
      fn: () => Promise<unknown>;
      callerStack?: string;
    }
  | {
      type: 'load';
      operationId: string;
      reference: OffloadReference;
      callerStack?: string;
    }
  | {
      type: 'archive';
      operationId: string;
      key: string;
      data: unknown;
      callerStack?: string;
    }
  | {
      type: 'run-all';
      operationId: string;
      branches: Record<string, [Function, ...unknown[]]>;
      callerStack?: string;
    }
  | {
      type: 'agent';
      operationId: string;
      options: AgentContextOptions;
      callerStack?: string;
    }
  | {
      type: 'stream';
      operationId: string;
      key: string;
      fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>;
      callerStack?: string;
    }
  | {
      type: 'wait-review';
      operationId: string;
      reviewOptions: HumanReviewOptions;
      callerStack?: string;
    }
  | {
      type: 'handoff';
      operationId: string;
      options: HandoffOptions;
      callerStack?: string;
    }
  | {
      type: 'debate';
      operationId: string;
      options: DebateOptions;
      callerStack?: string;
    }
  | {
      type: 'supervise';
      operationId: string;
      options: SuperviseOptions;
      callerStack?: string;
    };

// ---------------------------------------------------------------------------
// ActivityCallOptions detection
// ---------------------------------------------------------------------------

const ACTIVITY_CALL_OPTION_KEYS = new Set<string>([
  'timeout',
  'queue',
  'retry',
  'idempotencyKey',
  'sticky',
  'visibilityTimeout',
]);

/**
 * Strict subset of ACTIVITY_CALL_OPTION_KEYS that unambiguously identify an
 * ActivityCallOptions object. `timeout` is excluded because `{ timeout: 5000 }`
 * could be plain activity input. When adding a new option key, add it to both
 * sets if it should act as a discriminator.
 */
const DISCRIMINATOR_KEYS = new Set<string>([
  'queue',
  'retry',
  'idempotencyKey',
  'sticky',
  'visibilityTimeout',
]);

/** Detect whether a value is an {@link ActivityCallOptions} object. */
function isActivityCallOptions(value: unknown): value is ActivityCallOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!ACTIVITY_CALL_OPTION_KEYS.has(key)) {
      return false;
    }
  }
  // Require at least one discriminator key to avoid misidentifying plain data
  // objects (e.g., `{ timeout: 5000 }`) as options.
  for (const key of keys) {
    if (DISCRIMINATOR_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Context options
// ---------------------------------------------------------------------------

export interface ContextOptions {
  workflowId: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  searchAttributeSchema?: SearchAttributeSchema;
  getNow?: () => number;
  nestingDepth?: number;
  /**
   * The {@link TenantContext} resolved for this workflow, if any. Made
   * available to workflow code via `ctx.tenant`. Undefined when the engine
   * has no tenant resolver or the resolver returned `undefined`.
   */
  tenant?: import('./tenant.ts').TenantContext;
  /**
   * Reference timestamp used to compute `scheduledFireAt` for sleep operations.
   * When resuming from a checkpoint, this should be the checkpoint's `createdAt`
   * so that expired sleeps resolve immediately via the engine's fast path.
   */
  sleepReferenceTime?: number;
}

// ---------------------------------------------------------------------------
// Context class
// ---------------------------------------------------------------------------

export class Context implements WorkflowContext {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;

  #stepIndex: number;
  #accumulatedResults: Map<number, unknown>;
  #searchAttributes: Record<string, SearchAttributeValue>;
  #searchAttributeSchema: SearchAttributeSchema | undefined;
  #pendingAttributeChanges: Record<string, SearchAttributeValue>;
  #updateHandlers: Map<string, (payload: unknown) => unknown>;
  #exposedValues: Map<string, () => unknown>;
  #memoCache: Map<string, unknown>;
  #deadline: number | undefined;
  #getNow: () => number;
  #sleepReferenceTime: number | undefined;
  #explainMode: boolean;
  #budgetTracker: BudgetTracker | undefined;
  #nestingDepth: number;
  #tenant: import('./tenant.ts').TenantContext | undefined;

  #captureCallerStack(): string {
    const error = new Error();
    return error.stack ?? '';
  }

  constructor(options: ContextOptions) {
    this.workflowId = options.workflowId;
    this.workflowType = options.workflowType;
    this.startedAt = options.startedAt;
    this.signal = options.abortController.signal;

    this.#stepIndex = options.initialStep ?? 0;
    this.#accumulatedResults = options.accumulatedResults ?? new Map();
    this.#searchAttributes = options.searchAttributes ? { ...options.searchAttributes } : {};
    this.#searchAttributeSchema = options.searchAttributeSchema;
    this.#pendingAttributeChanges = {};
    this.#updateHandlers = new Map();
    this.#exposedValues = new Map();
    this.#memoCache = new Map();
    this.#deadline = options.deadline;
    this.#getNow = options.getNow ?? Date.now;
    this.#sleepReferenceTime = options.sleepReferenceTime;
    this.#explainMode = false;
    this.#budgetTracker = undefined;
    this.#nestingDepth = options.nestingDepth ?? 0;
    this.#tenant = options.tenant;
  }

  /**
   * The {@link TenantContext} this workflow is running on behalf of, if any.
   * Populated from the engine's `tenantResolver` at start time and restored
   * from the workflow state on recovery. `undefined` when the engine has no
   * resolver configured or the resolver returned `undefined`.
   */
  get tenant(): import('./tenant.ts').TenantContext | undefined {
    return this.#tenant;
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get executionTimeRemaining(): number {
    if (this.#deadline === undefined) return Infinity;
    return Math.max(0, this.#deadline - this.#getNow());
  }

  get stepIndex(): number {
    return this.#stepIndex;
  }

  get nestingDepth(): number {
    return this.#nestingDepth;
  }

  get accumulatedResults(): Map<number, unknown> {
    return this.#accumulatedResults;
  }

  get pendingAttributeChanges(): Record<string, SearchAttributeValue> {
    return this.#pendingAttributeChanges;
  }

  get exposedAccessors(): Map<string, () => unknown> {
    return this.#exposedValues;
  }

  get updateHandlers(): Map<string, (payload: unknown) => unknown> {
    return this.#updateHandlers;
  }

  get explainEnabled(): boolean {
    return this.#explainMode;
  }

  // -------------------------------------------------------------------------
  // Durable operations (generators)
  // -------------------------------------------------------------------------

  *run<TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> {
    // Extract ActivityCallOptions from the last argument when present.
    let options: ActivityCallOptions | undefined;
    if (rest.length > 0 && isActivityCallOptions(rest[rest.length - 1])) {
      options = rest.pop() as ActivityCallOptions;
    }
    const args = rest;

    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      if (this.#explainMode) {
        console.log(
          `[weft] ctx.run(${fn.name || 'anonymous'}) → Returning cached result from step ${step}`,
        );
      }
      return this.#accumulatedResults.get(step) as TResult;
    }

    const queue = options?.queue ?? 'default';

    if (this.#explainMode) {
      console.log(`[weft] ctx.run(${fn.name || 'anonymous'}, ${JSON.stringify(args)})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Dispatching activity "${fn.name || 'anonymous'}" to queue "${queue}"`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'activity',
      operationId,
      activityName: fn.name || 'anonymous',
      fn,
      args,
      callerStack,
      ...(options !== undefined ? { options: options as Record<string, unknown> } : {}),
    };

    this.#accumulatedResults.set(step, result);
    return result as TResult;
  }

  *sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) return;

    const milliseconds = parseDuration(duration);

    if (this.#explainMode) {
      console.log(`[weft] ctx.sleep(${JSON.stringify(duration)})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Scheduling timer for ${milliseconds}ms`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();

    // Use the sleep reference time (checkpoint createdAt on resume) so that
    // the engine's expired-timer fast path can detect sleeps whose original
    // deadline has already passed. Consume it on first use so that any new
    // sleeps created after the recovery point use the current time.
    const referenceTime = this.#sleepReferenceTime ?? this.#getNow();
    this.#sleepReferenceTime = undefined;

    yield {
      type: 'sleep',
      operationId,
      duration: milliseconds,
      scheduledFireAt: referenceTime + milliseconds,
      callerStack,
    };

    this.#accumulatedResults.set(step, undefined);
  }

  /**
   * Pause the workflow until an external caller delivers a signal with the
   * matching `resumeToken` as its name. Semantically identical to
   * `waitForSignal(resumeToken)` — the caller generates the token, hands it
   * to the external world, then yields. The engine persists a checkpoint and
   * releases control; when `POST /v1/workflows/:id/signal/:resumeToken`
   * arrives, the generator resumes with the signal payload.
   *
   * This primitive closes the "serverless suspension" gap vs Inngest's
   * `step.ai.infer()` and Restate's journal-based suspension. In the default
   * inline-execution mode, the engine writes a checkpoint and releases its
   * scheduling slot so the host process is free to pick up other work while
   * the workflow is parked.
   *
   * **Worker-execution caveat:** when the engine is configured with
   * `workerExecution`, the slot-release benefit does NOT apply.
   * `WorkerExecutionStrategy` keeps the dedicated Web Worker pinned to the
   * workflow id until the workflow completes, so a parked `suspendUntil`
   * still occupies its worker. Use inline mode if you need true serverless
   * suspension semantics.
   *
   * **Token collision caveat:** resume tokens share the signal namespace with
   * `waitForSignal`. Pick tokens that can't collide with named signals the
   * workflow also listens for (a UUID is safest).
   *
   * @example
   * ```ts
   * import type { Context } from 'weft';
   *
   * engine.register('await-webhook', async function* (ctx, input: { callbackUrl: string }) {
   *   const token = crypto.randomUUID();
   *   yield* (ctx as Context).run(registerCallback, { url: input.callbackUrl, token });
   *   const payload = yield* (ctx as Context).suspendUntil<{ status: string }>(token);
   *   return payload.status;
   * });
   * ```
   */
  *suspendUntil<T = unknown>(resumeToken: string): Generator<ContextOperationRequest, T, unknown> {
    return yield* this.waitForSignal<T>(resumeToken);
  }

  *waitForSignal<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as T;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.waitForSignal("${name}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Waiting for signal "${name}"`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'wait-signal',
      operationId,
      signalName: name,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  *waitForUpdate<T = unknown>(
    name: string,
  ): Generator<
    ContextOperationRequest,
    { payload: T; respond: (result: unknown) => void },
    unknown
  > {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      // Recovery path: the response was already sent in the original execution.
      // Return the cached payload with a no-op respond function.
      const cached = this.#accumulatedResults.get(step) as { payload: T };
      return { payload: cached.payload, respond: () => {} };
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.waitForUpdate("${name}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Waiting for update "${name}"`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'wait-update',
      operationId,
      updateName: name,
      callerStack,
    };

    const envelope = result as { payload: T; respond: (result: unknown) => void };

    // Store only the serializable payload in accumulatedResults (functions
    // cannot survive checkpoint serialization). On recovery, a no-op respond
    // function is provided instead.
    this.#accumulatedResults.set(step, { payload: envelope.payload });
    return envelope;
  }

  /**
   * Pause the workflow for human review. Creates a durable review request
   * in storage and blocks until a decision is submitted via
   * `engine.submitReview()`, or until the review times out / auto-decides
   * via escalation.
   */
  *humanReview(
    options: HumanReviewOptions,
  ): Generator<ContextOperationRequest, HumanReviewResult, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as HumanReviewResult;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.humanReview(${JSON.stringify(options.reviewType ?? 'general')})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Pausing for human review`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'wait-review' as const,
      operationId,
      reviewOptions: options,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as HumanReviewResult;
  }

  *all(
    operations: Generator<ContextOperationRequest, unknown, unknown>[],
  ): Generator<ContextOperationRequest, unknown[], unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as unknown[];
    }

    const subOperations: ContextOperationRequest[] = [];
    for (const generator of operations) {
      const yielded = generator.next();
      if (!yielded.done) {
        subOperations.push(yielded.value);
      }
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'parallel',
      operationId,
      operations: subOperations,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as unknown[];
  }

  *race(
    operations: Generator<ContextOperationRequest, unknown, unknown>[],
  ): Generator<ContextOperationRequest, unknown, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step);
    }

    const subOperations: ContextOperationRequest[] = [];
    for (const generator of operations) {
      const yielded = generator.next();
      if (!yielded.done) {
        subOperations.push(yielded.value);
      }
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'race',
      operationId,
      operations: subOperations,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result;
  }

  *memo<T>(key: string, fn: () => T | Promise<T>): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    // Check memo cache first (covers repeated calls within the same execution)
    if (this.#memoCache.has(key)) {
      return this.#memoCache.get(key) as T;
    }

    // Check accumulated results (recovery path from checkpoint)
    if (this.#accumulatedResults.has(step)) {
      const cached = this.#accumulatedResults.get(step) as T;
      this.#memoCache.set(key, cached);
      return cached;
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'memo',
      operationId,
      key,
      fn,
      callerStack,
    };

    this.#memoCache.set(key, result);
    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  *offload<T>(
    key: string,
    fn: () => Promise<T>,
  ): Generator<ContextOperationRequest, OffloadReference, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as OffloadReference;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.offload("${key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Offloading data for key "${key}" to external storage`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'offload' as const,
      operationId,
      key,
      fn,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as OffloadReference;
  }

  *stream(
    key: string,
    fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>,
  ): Generator<ContextOperationRequest, StreamReference, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as StreamReference;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.stream("${key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Streaming data for key "${key}" to external storage`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'stream' as const,
      operationId,
      key,
      fn,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as StreamReference;
  }

  *load<T>(reference: OffloadReference): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as T;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.load("${reference.key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Loading offloaded data for key "${reference.key}"`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'load' as const,
      operationId,
      reference,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  *archive(key: string, data: unknown): Generator<ContextOperationRequest, void, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) return;

    if (this.#explainMode) {
      console.log(`[weft] ctx.archive("${key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Archiving data for key "${key}"`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    yield {
      type: 'archive' as const,
      operationId,
      key,
      data,
      callerStack,
    };

    this.#accumulatedResults.set(step, undefined);
  }

  *runAll<T extends Record<string, [Function, ...unknown[]]>>(
    branches: T,
  ): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as Record<keyof T, unknown>;
    }

    if (this.#explainMode) {
      const branchNames = Object.keys(branches).join(', ');
      console.log(`[weft] ctx.runAll({ ${branchNames} })`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Running ${Object.keys(branches).length} named branches in parallel`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'run-all' as const,
      operationId,
      branches,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as Record<keyof T, unknown>;
  }

  /**
   * Run a sequence of activities as a saga.
   *
   * Steps run in order. When a step fails, the compensators for every
   * previously-completed step run in **reverse order** (last-completed first),
   * each receiving the original input and the output produced by `execute`.
   * The original error is re-thrown after compensation.
   *
   * The failing step's own compensator is **not** called — compensation is
   * only for steps that fully completed before the failure.
   *
   * Compensators are dispatched as durable activity operations so they are
   * checkpointed and survive engine restarts.
   *
   * @example
   * ```ts
   * const result = yield* ctx.saga([
   *   { definition: charge, input: { customerId, amount } },
   *   { definition: reserve, input: { itemId, quantity } },
   *   { definition: ship,    input: { orderId } },
   * ]);
   * ```
   */
  *saga<TFinalOutput = unknown>(
    steps: ErasedSagaStep[],
  ): Generator<ContextOperationRequest, TFinalOutput, unknown> {
    // Track completed steps so we can compensate in reverse on failure.
    const completed: Array<{
      definition: ErasedActivityDefinition;
      input: unknown;
      output: unknown;
    }> = [];

    let lastOutput: unknown;

    for (const step of steps) {
      const stepDefinition = step.definition;
      try {
        // Call execute as a method on the definition object (obj.method form)
        // so that any `this` binding is preserved. We wrap in an arrow function
        // because ctx.run() expects a plain function reference, not a bound
        // method reference, and the wrapper satisfies both concerns.
        const output = yield* this.run(
          (...args: unknown[]) => stepDefinition.execute(...args),
          step.input,
        );
        completed.push({ definition: stepDefinition, input: step.input, output });
        lastOutput = output;
      } catch (stepError) {
        // Run compensators for all completed steps in reverse order.
        // We don't let compensator failures mask the original error.
        for (let index = completed.length - 1; index >= 0; index--) {
          const completedStep = completed[index]!;
          if (completedStep.definition.compensate !== undefined) {
            const capturedInput = completedStep.input;
            const capturedOutput = completedStep.output;
            const capturedDefinition = completedStep.definition;

            // Wrap the compensator in an async arrow function so ctx.run() can
            // dispatch it as a durable activity. Calling compensate as a method
            // call (obj.method()) preserves any `this` binding and avoids the
            // unbound-method lint rule (which only flags method extractions to
            // standalone variables).
            const compensateActivity = async () =>
              capturedDefinition.compensate?.(capturedInput, capturedOutput);

            // Give the compensator a stable name for observability.
            Object.defineProperty(compensateActivity, 'name', {
              value: `compensate:${completedStep.definition.name}`,
              configurable: true,
            });

            try {
              yield* this.run(compensateActivity);
            } catch {
              // Compensator failures are intentionally swallowed so the
              // original error propagates to the caller unchanged.
            }
          }
        }

        throw stepError;
      }
    }

    return lastOutput as TFinalOutput;
  }

  *startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: Record<string, unknown>,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      if (this.#explainMode) {
        console.log(
          `[weft] ctx.startChild("${workflowType}") → Returning cached result from step ${step}`,
        );
      }
      return this.#accumulatedResults.get(step) as TResult;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.startChild("${workflowType}", ${JSON.stringify(input)})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Starting child workflow of type "${workflowType}"`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const request: ContextOperationRequest = {
      type: 'child-workflow' as const,
      operationId,
      workflowType,
      input,
      callerStack,
      ...(options !== undefined ? { options } : {}),
    };
    const result = yield request;

    this.#accumulatedResults.set(step, result);
    return result as TResult;
  }

  // -------------------------------------------------------------------------
  // Explain mode
  // -------------------------------------------------------------------------

  explain(enabled: boolean = true): void {
    this.#explainMode = enabled;
  }

  *agent(options: AgentContextOptions): Generator<ContextOperationRequest, unknown, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      if (this.#explainMode) {
        console.log(
          `[weft] ctx.agent(model="${options.model}") → Returning cached result from step ${step}`,
        );
      }
      return this.#accumulatedResults.get(step);
    }

    if (this.#explainMode) {
      const toolCount = options.tools?.length ?? 0;
      const maxTurns = options.maxTurns ?? 'default';
      console.log(`[weft] ctx.agent(model="${options.model}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Starting agent loop with ${toolCount} tool(s), maxTurns=${maxTurns}`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'agent' as const,
      operationId,
      options,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Multi-agent coordination (durable)
  // -------------------------------------------------------------------------

  /** Hand off execution to another agent, optionally forwarding conversation context. */
  *handoff(options: HandoffOptions): Generator<ContextOperationRequest, HandoffResult, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as HandoffResult;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.handoff("${options.agent.name}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(
        `  → Handing off to agent "${options.agent.name}" with context=${options.forwardContext ?? 'none'}`,
      );
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'handoff' as const,
      operationId,
      options,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as HandoffResult;
  }

  /** Run an adversarial multi-agent debate as a durable operation. */
  *debate(options: DebateOptions): Generator<ContextOperationRequest, DebateResult, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as DebateResult;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.debate("${options.topic}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Running ${options.rounds} debate rounds`);
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'debate' as const,
      operationId,
      options,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as DebateResult;
  }

  /** Run supervised parallel multi-agent execution with synthesis as a durable operation. */
  *supervise(
    options: SuperviseOptions,
  ): Generator<ContextOperationRequest, SuperviseResult, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as SuperviseResult;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.supervise("${options.strategy}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(
        `  → Running ${options.workers.length} workers with "${options.strategy}" strategy`,
      );
    }

    const operationId = crypto.randomUUID();
    const callerStack = this.#captureCallerStack();
    const result = yield {
      type: 'supervise' as const,
      operationId,
      options,
      callerStack,
    };

    this.#accumulatedResults.set(step, result);
    return result as SuperviseResult;
  }

  // -------------------------------------------------------------------------
  // Budget tracking
  // -------------------------------------------------------------------------

  setBudget(options: BudgetOptions): void {
    this.#budgetTracker = new BudgetTracker(options);
  }

  budgetRemaining(): BudgetState | undefined {
    return this.#budgetTracker?.budgetRemaining();
  }

  budgetProjection():
    | { estimatedTurnsRemaining: number; estimatedCostAtCompletion: number }
    | undefined {
    return this.#budgetTracker?.budgetProjection();
  }

  // -------------------------------------------------------------------------
  // Synchronous operations (non-yielding)
  // -------------------------------------------------------------------------

  setAttribute(key: string, value: SearchAttributeValue): void {
    this.#validateAttribute(key, value);
    this.#searchAttributes[key] = value;
    this.#pendingAttributeChanges[key] = value;
  }

  setAttributes(attributes: Record<string, SearchAttributeValue>): void {
    // Validate all keys and types before mutating to ensure atomicity
    for (const [key, value] of Object.entries(attributes)) {
      this.#validateAttribute(key, value);
    }
    for (const [key, value] of Object.entries(attributes)) {
      this.#searchAttributes[key] = value;
      this.#pendingAttributeChanges[key] = value;
    }
  }

  #validateAttribute(key: string, value: SearchAttributeValue): void {
    if (this.#searchAttributeSchema) {
      if (!(key in this.#searchAttributeSchema)) {
        throw new Error(
          `Unknown search attribute "${key}". Registered attributes: ${Object.keys(this.#searchAttributeSchema).join(', ')}`,
        );
      }
      validateAttributeType(key, value, this.#searchAttributeSchema[key]!);
    }
  }

  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined {
    return this.#searchAttributes[key] as T | undefined;
  }

  getAttributes(): Readonly<Record<string, SearchAttributeValue>> {
    return { ...this.#searchAttributes };
  }

  onUpdate(name: string, handler: (payload: unknown) => unknown): void {
    // Reject generator functions at registration time — they cannot yield
    // inside an update handler.
    if (isGeneratorFunction(handler) || isAsyncGeneratorFunction(handler)) {
      throw new TypeError(
        `Update handler "${name}" cannot be a generator function. ` +
          `Use a plain function — update handlers run synchronously at checkpoint boundaries and cannot yield.`,
      );
    }
    this.#updateHandlers.set(name, handler);
  }

  expose(accessors: Record<string, () => unknown>): void {
    for (const [key, accessor] of Object.entries(accessors)) {
      this.#exposedValues.set(key, accessor);
    }
  }

  streamUrl(reference: StreamReference): string {
    return `/v1/workflows/${encodeURIComponent(reference.workflowId)}/streams/${encodeURIComponent(reference.key)}`;
  }
}
