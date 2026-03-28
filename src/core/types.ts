import type { Storage as WeftStorage } from '../storage/interface.ts';

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

export interface WorkflowContext {
  readonly workflowId: WorkflowId;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
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
