import type { ModelRouter } from '../ai/model-router.ts';
import type { AlertingOptions } from '../alerting/types.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import type { CompressionAlgorithm, CompressionOptions } from './compression.ts';

// ---------------------------------------------------------------------------
// Workflow identity
// ---------------------------------------------------------------------------

export type WorkflowId = string;
export type OperationId = string;

// ---------------------------------------------------------------------------
// Workflow status state machine
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

// ---------------------------------------------------------------------------
// Workflow state persisted in storage
// ---------------------------------------------------------------------------

export interface WorkflowState {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  result?: unknown;
  error?: string;
  errorStack?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  executionDeadline?: number;
  /**
   * Optional {@link TenantContext} resolved at start time by the engine's
   * `tenantResolver`. Persisted here so it survives workflow recovery — the
   * field is only present on workflows started while a resolver was
   * configured and the resolver returned a value.
   */
  tenant?: import('./tenant.ts').TenantContext;
}

// ---------------------------------------------------------------------------
// Duration: number (milliseconds) or human-readable string
// ---------------------------------------------------------------------------

export type Duration = number | string;

// ---------------------------------------------------------------------------
// Checkpoint: snapshot of workflow at a yield* boundary
// ---------------------------------------------------------------------------

export interface Checkpoint {
  workflowId: WorkflowId;
  step: number;
  locals: Record<string, unknown>;
  accumulatedResults: Array<[number, unknown]>;
  pendingSignals: string[];
  searchAttributes: Record<string, SearchAttributeValue>;
  version: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Retry policy for activities
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

export type OperationKind = 'activity' | 'timer' | 'signal-wait' | 'child-workflow';

export interface OperationRequest {
  id: OperationId;
  workflowId: WorkflowId;
  kind: OperationKind;
  queue: string;
  activityName?: string;
  input?: unknown;
  attempt: number;
  retryPolicy: RetryPolicy;
  scheduledAt: number;
  timeout?: Duration;
  idempotencyKey?: string;
  /** Visibility timeout in milliseconds. Defaults to 30 000. */
  visibilityTimeout?: number;
}

export type OperationOutcome =
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; error: string };

// ---------------------------------------------------------------------------
// Search attributes
// ---------------------------------------------------------------------------

export type SearchAttributeValue = string | number | boolean | Date | string[];

export interface SearchAttributeDefinition {
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list';
}

export type SearchAttributeSchema = Record<string, SearchAttributeDefinition>;

// ---------------------------------------------------------------------------
// Start options for engine.start()
// ---------------------------------------------------------------------------

export interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  searchAttributes?: Record<string, SearchAttributeValue>;
}

// ---------------------------------------------------------------------------
// Serializer interface (pluggable serialization)
// ---------------------------------------------------------------------------

export interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export interface EngineOptions {
  storage?: WeftStorage;
  development?: boolean;
  serializer?: Serializer;
  /** Payload compression applied at the storage layer. */
  compression?: CompressionOptions & {
    /** Compression algorithm for agent workflow checkpoints. Default: 'brotli'. */
    agentAlgorithm?: CompressionAlgorithm;
    /** Compression threshold for agent workflow checkpoints. Default: same as main threshold. */
    agentThreshold?: number;
  };
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  /** Enable BroadcastChannel for cross-worker event coordination. Default: false. */
  broadcastEvents?: boolean;
  /**
   * Enable worker-based execution. When provided, workflows run in isolated
   * Web Workers instead of inline on the main thread. Activities are still
   * executed on the main thread via the activity registry (unless
   * `activityExecution` is also configured).
   */
  workerExecution?: {
    /** URL of the worker script (created via `createWorkerEntryUrl`). */
    workerUrl: string | URL;
    /** Maximum number of concurrent workers. Default: 4. */
    concurrency?: number;
    /** Use Bun's `smol` worker option for smaller memory footprint. */
    smol?: boolean;
  };

  /**
   * Enable worker-based activity execution. When provided, activity functions
   * run in isolated Web Workers instead of on the main thread. Activities must
   * be pre-registered in the worker via `createActivityWorkerEntryUrl`.
   */
  activityExecution?: {
    /** URL of the activity worker script (created via `createActivityWorkerEntryUrl`). */
    workerUrl: string | URL;
    /** Maximum number of concurrent activity workers. Default: 4. */
    poolSize?: number;
    /** Use Bun's `smol` worker option for smaller memory footprint. */
    smol?: boolean;
  };

  /**
   * Default model router applied to all `ctx.agent()` calls that don't
   * provide their own `modelRouter`. Per-call routers override this.
   */
  defaultModelRouter?: ModelRouter | undefined;

  /** Built-in alerting configuration. */
  alerts?: AlertingOptions;

  /**
   * Optional {@link TenantResolver} that populates `ctx.tenant` for every new
   * workflow. When set, the engine calls `resolver.resolve(workflowId, input)`
   * once at `start()` time and persists the returned context on the workflow
   * state so it survives recovery. Leave unset for single-tenant deployments.
   */
  tenantResolver?: import('./tenant.ts').TenantResolver;
}

// ---------------------------------------------------------------------------
// Activity function type
// ---------------------------------------------------------------------------

export type ActivityFunction<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ActivityContext,
) => Promise<TOutput> | TOutput;

// ---------------------------------------------------------------------------
// Activity context passed to activity functions
// ---------------------------------------------------------------------------

export interface ActivityContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
}

// ---------------------------------------------------------------------------
// Per-invocation activity options
// ---------------------------------------------------------------------------

export interface ActivityCallOptions {
  timeout?: Duration;
  queue?: string;
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  sticky?: boolean;
  /** Override the default visibility timeout for this invocation. */
  visibilityTimeout?: Duration;
}

// ---------------------------------------------------------------------------
// Activity metadata (from activity() helper)
// ---------------------------------------------------------------------------

export interface ActivityDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  execute: ActivityFunction<TInput, TOutput>;
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
// Timer entry for scheduler
// ---------------------------------------------------------------------------

export interface TimerEntry {
  id: string;
  workflowId: WorkflowId;
  fireAt: number;
  kind: 'sleep' | 'visibility-timeout' | 'execution-deadline';
}

// ---------------------------------------------------------------------------
// Worker message protocol (postMessage between main thread and Web Workers)
// ---------------------------------------------------------------------------

export type WorkerInboundMessage =
  | {
      type: 'run';
      workflowId: WorkflowId;
      workflowType: string;
      checkpoint: ArrayBuffer;
      input: unknown;
      deadline?: number;
      headers?: [string, string][];
      /**
       * Resolved tenant context for this workflow run, forwarded across the
       * `postMessage` boundary. The `attributes` values MUST be
       * structured-clone safe — functions, class instances, and DOM nodes
       * will crash the transfer with `DataCloneError`. Stick to plain
       * objects, arrays, strings, numbers, booleans, and null.
       */
      tenant?: import('./tenant.ts').TenantContext;
    }
  | {
      type: 'resume';
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationResult: OperationOutcome;
    }
  | { type: 'cancel'; workflowId: WorkflowId };

export type WorkerOutboundMessage =
  | {
      type: 'checkpoint';
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationRequest: OperationRequest;
    }
  | { type: 'completed'; workflowId: WorkflowId; result: unknown }
  | { type: 'failed'; workflowId: WorkflowId; error: string; errorStack?: string };

// ---------------------------------------------------------------------------
// Workflow function signature
// ---------------------------------------------------------------------------

export type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;

// ---------------------------------------------------------------------------
// Step-based workflow types (progressive disclosure API)
// ---------------------------------------------------------------------------

export interface StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

export type StepWorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: StepWorkflowContext,
  input: TInput,
) => Promise<TOutput>;

// ---------------------------------------------------------------------------
// Forward-declared WorkflowContext interface (full implementation in context.ts)
// ---------------------------------------------------------------------------

/**
 * The minimal context contract that every workflow function receives. For
 * most operations — `run`, `sleep`, `waitForSignal`, `setAttribute`,
 * `stream`, `suspendUntil`, `agent`, and the multi-agent primitives — cast
 * to the concrete `Context` class from `src/core/context.ts`:
 *
 * ```ts
 * import type { Context } from 'weft';
 *
 * engine.register('example', async function* (ctx) {
 *   const result = yield* (ctx as Context).run(myActivity, input);
 *   yield* (ctx as Context).suspendUntil('resume-token');
 * });
 * ```
 *
 * `tenant` is surfaced directly on this interface (not via the cast) because
 * reading it is a common lightweight path that doesn't need the full method
 * surface.
 */
export interface WorkflowContext {
  readonly workflowId: WorkflowId;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
  /**
   * The {@link import('./tenant.ts').TenantContext} this workflow is running
   * on behalf of, populated from the engine's `tenantResolver` at start time
   * and restored from persisted state on recovery. `undefined` when the
   * engine has no resolver configured or the resolver returned `undefined`.
   *
   * Declared as `T | undefined` rather than `tenant?: T` so the field is
   * always present on the type — the `Context` class implementation has a
   * getter that returns `undefined` when absent, and under
   * `exactOptionalPropertyTypes` the optional-key form would be a stricter
   * contract that the getter can't satisfy.
   */
  readonly tenant: import('./tenant.ts').TenantContext | undefined;
}

// ---------------------------------------------------------------------------
// Workflow registration
// ---------------------------------------------------------------------------

export interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  version?: string;
  handler: WorkflowFunction<TInput, TOutput>;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
}

// ---------------------------------------------------------------------------
// Workflow registry for typed Engine<TRegistry>
// ---------------------------------------------------------------------------

export type WorkflowRegistry = Record<string, { input: unknown; output: unknown }>;

// ---------------------------------------------------------------------------
// List/filter options
// ---------------------------------------------------------------------------

export interface ListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  attributes?: AttributeFilter[];
  limit?: number;
  offset?: number;
}

export interface AttributeFilter {
  key: string;
  value?: SearchAttributeValue;
  gt?: SearchAttributeValue;
  lt?: SearchAttributeValue;
  gte?: SearchAttributeValue;
  lte?: SearchAttributeValue;
}

// ---------------------------------------------------------------------------
// Paginated result
// ---------------------------------------------------------------------------

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Workflow summary (returned by list)
// ---------------------------------------------------------------------------

export interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  version: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Workflow event (returned by engine.getEvents)
// ---------------------------------------------------------------------------

export interface WorkflowEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Review decision types (for engine.submitReview)
// ---------------------------------------------------------------------------

export type ReviewDecision = 'approved' | 'rejected' | 'needs-changes';

export interface SubmitReviewOptions {
  decision: ReviewDecision;
  reviewer: string;
  feedback?: string;
  /** Per-section decisions for partial approval workflows. */
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  /** When provided, enables O(1) direct key lookup instead of scanning. */
  workflowId?: string;
}

// ---------------------------------------------------------------------------
// Coordinated update result (for engine.submitCoordinatedUpdate)
// ---------------------------------------------------------------------------

export interface CoordinatedUpdateResult {
  updateId: string;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoff: 1000,
  backoffMultiplier: 2,
  maxBackoff: 30_000,
};

export const DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD = 65_536; // 64KB
export const DEFAULT_MAX_NESTING_DEPTH = 10;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// activity() helper — wraps a function with colocated configuration
// ---------------------------------------------------------------------------

/**
 * Create an activity with colocated configuration.
 * The returned value is both an ActivityDefinition and a callable function.
 */
export function activity<TInput, TOutput>(
  options: ActivityDefinition<TInput, TOutput>,
): ActivityDefinition<TInput, TOutput> & ((...args: [TInput]) => Promise<TOutput>) {
  const fn = ((...args: [TInput]) => options.execute(...args)) as (
    ...args: [TInput]
  ) => Promise<TOutput>;

  // Assign non-function-builtin properties from options to the function
  const { name, execute, ...rest } = options;
  Object.assign(fn, rest);

  // Set name and execute as own properties (name is non-writable on functions,
  // so we must use defineProperty)
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'execute', { value: execute, enumerable: true, configurable: true });

  return fn as ActivityDefinition<TInput, TOutput> & ((...args: [TInput]) => Promise<TOutput>);
}
