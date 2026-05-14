# Types Reference

Complete type reference for Weft, organized by category. All types are exported from the `weft` package entry point.

---

## Core Types

### `WorkflowId`

```ts partial
type WorkflowId = string;
```

### `WorkflowStatus`

```ts partial
type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
```

### `WorkflowState`

Persisted workflow state stored in the storage backend.

```ts partial
interface WorkflowState {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  result?: unknown;
  error?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  executionDeadline?: number;
}
```

### `WorkflowFunction`

The signature of a workflow generator function.

```ts partial
type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;
```

### `WorkflowContext`

The context object passed as the first argument to every workflow function.

```ts partial
interface WorkflowContext {
  readonly workflowId: WorkflowId;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
  readonly tenant: TenantContext | undefined;
  readonly state: WorkflowStateNamespace;
  run<TArguments extends unknown[], TResult>(
    fn: (...arguments_: TArguments) => Promise<TResult> | TResult,
    ...rest: TArguments
  ): WorkflowOperation<TResult>;
  run<TName extends keyof ActivityTypes & string>(
    name: TName,
    ...rest: ActivityArguments<ActivityTypes, TName>
  ): WorkflowOperation<ActivityResult<ActivityTypes, TName>>;
  sleep(duration: Duration): WorkflowOperation<void>;
  waitForSignal<T = unknown>(name: string): WorkflowOperation<T>;
  waitForUpdate<T = unknown>(
    name: string,
  ): WorkflowOperation<{ payload: T; respond: (result: unknown) => void }>;
  review(options: HumanReviewOptions): WorkflowOperation<HumanReviewResult>;
  startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: ChildWorkflowOptions,
  ): WorkflowOperation<TResult>;
  all(operations: WorkflowOperation<unknown>[]): WorkflowOperation<unknown[]>;
  race(operations: WorkflowOperation<unknown>[]): WorkflowOperation<unknown>;
  offload<T>(key: string, fn: () => Promise<T>): WorkflowOperation<OffloadReference>;
  stream(
    key: string,
    fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>,
  ): WorkflowOperation<StreamReference>;
  archive(key: string, data: unknown): WorkflowOperation<void>;
  setAttribute(key: string, value: SearchAttributeValue): void;
  onUpdate<TPayload = unknown>(name: string, handler: (payload: TPayload) => unknown): void;
  pipe<TResult = unknown>(
    stages: WorkflowPipeStageDefinition[],
    input: unknown,
  ): WorkflowOperation<TResult>;
  map<TItem, TResult>(
    items: readonly TItem[],
    target: ChildWorkflowTarget<TItem, TResult>,
    options?: WorkflowMapOptions,
  ): WorkflowOperation<TResult[]>;
  reduce<TItem, TAccumulator>(
    items: readonly TItem[],
    target: ChildWorkflowTarget<WorkflowReduceInput<TAccumulator, TItem>, TAccumulator>,
    initial: TAccumulator,
    options?: WorkflowReduceOptions,
  ): WorkflowOperation<TAccumulator>;
}
```

`WorkflowContext` is the normal workflow authoring surface. You do not need to cast it to `Context` to call durable operations.

### Composition Types

Types for `ctx.pipe()`, `ctx.map()`, and `ctx.reduce()` durable composition operators.

```ts partial
/** A pending durable operation result. Yield with `yield*` inside a workflow. */
type WorkflowOperation<TResult> = Generator<unknown, TResult, unknown>;

/** Accepted forms for specifying a child workflow in composition operators. */
type ChildWorkflowTarget<TInput = unknown, TOutput = unknown> =
  | string
  | WorkflowFunction<TInput, TOutput>
  | StepWorkflowFunction<TInput, TOutput>;

interface WorkflowMapOptions {
  concurrency?: number;
}

interface WorkflowReduceOptions extends Record<string, unknown> {
  idPrefix?: string;
}

type ChildWorkflowOptions = {
  id?: string;
};

interface WorkflowPipeStage<TInput = unknown, TOutput = unknown> {
  type: ChildWorkflowTarget<TInput, TOutput>;
  options?: ChildWorkflowOptions;
}

type WorkflowPipeStageDefinition<TInput = unknown, TOutput = unknown> =
  | WorkflowPipeStage<TInput, TOutput>
  | ChildWorkflowTarget<TInput, TOutput>;
```

### `WorkflowStateNamespace`

State factories exposed as `ctx.state`. Session state is checkpoint-local.
Execution, workflow, and tenant state are storage-backed and must be yielded
inside workflows.

```ts partial
interface WorkflowStateNamespace {
  session<T>(key: string, options?: { initial?: T }): WorkflowSessionState<T>;
  execution<T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T>;
  workflow<T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T>;
  tenant<T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T>;
}
```

### `WorkflowAtomicStateOptions<T>`

Options accepted by the storage-backed `ctx.state.execution`,
`ctx.state.workflow`, and `ctx.state.tenant` factories.

```ts partial
type WorkflowAtomicStateOptions<T> = {
  initial?: T;
  maxRetries?: number;
};
```

### `WorkflowSessionState<T>`

Checkpoint-local state slot returned by `ctx.state.session(key, options?)`.
Checkpointed with the workflow and private to that workflow instance.

```ts partial
interface WorkflowSessionState<T> {
  get(): T | undefined;
  set(value: T): T;
  update(updater: (current: T | undefined) => T): T;
  delete(): void;
  increment(this: WorkflowSessionState<number>, amount?: number): number;
  decrement(this: WorkflowSessionState<number>, amount?: number): number;
  merge<TObject extends Record<string, unknown>>(
    this: WorkflowSessionState<TObject>,
    patch: Partial<TObject>,
  ): TObject;
  append<TItem>(this: WorkflowSessionState<TItem[]>, item: TItem): TItem[];
  removeFirst<TItem>(this: WorkflowSessionState<TItem[]>): TItem | undefined;
  removeLast<TItem>(this: WorkflowSessionState<TItem[]>): TItem | undefined;
  run<TResult>(
    fn: (input: unknown) => Promise<TResult> | TResult,
    input?: unknown,
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
}
```

### `DefinitionSchema`

```ts partial
type DefinitionSchema<Input = unknown, Output = Input> =
  | StandardSchemaV1<Input, Output>
  | StandardJSONSchemaV1<Input, Output>;
```

Schema metadata accepted by workflow and activity definitions. [Standard Schema](https://standardschema.dev/) validation and [Standard JSON Schema](https://standardschema.dev/json-schema) conversion are separate capabilities; a definition can provide either one or both.

Core workflow and activity registration validates the Standard Schema metadata shape and stores these fields for introspection. Runtime input or output validation happens only in adapters that explicitly consume the metadata.

Weft exports the small Standard Schema helper surfaces from `weft/json-schema` so diagnostics and generated declaration files stay self-contained without crowding the workflow-authoring entrypoint: `StandardTypedV1Properties`, `StandardTypedV1Types`, `StandardSchemaV1Properties`, `StandardSchemaV1Result`, `StandardSchemaV1SuccessResult`, `StandardSchemaV1FailureResult`, `StandardSchemaV1Issue`, `StandardSchemaV1PathSegment`, `StandardSchemaV1Options`, `StandardJSONSchemaV1Properties`, `StandardJSONSchemaV1Converter`, `StandardJSONSchemaV1Target`, and `StandardJSONSchemaV1Options`.

### `WorkflowAtomicState<T>`

Storage-backed durable state returned by `ctx.state.execution`,
`ctx.state.workflow`, and `ctx.state.tenant`.

```ts partial
interface WorkflowAtomicState<T> {
  get(): WorkflowOperation<T | undefined>;
  set(value: T): WorkflowOperation<T>;
  update(updater: (current: T | undefined) => T): WorkflowOperation<T>;
  delete(): WorkflowOperation<void>;
  increment(this: WorkflowAtomicState<number>, amount?: number): WorkflowOperation<number>;
  decrement(this: WorkflowAtomicState<number>, amount?: number): WorkflowOperation<number>;
  merge<TObject extends Record<string, unknown>>(
    this: WorkflowAtomicState<TObject>,
    patch: Partial<TObject>,
  ): WorkflowOperation<TObject>;
  append<TItem>(this: WorkflowAtomicState<TItem[]>, item: TItem): WorkflowOperation<TItem[]>;
  removeFirst<TItem>(this: WorkflowAtomicState<TItem[]>): WorkflowOperation<TItem | undefined>;
  removeLast<TItem>(this: WorkflowAtomicState<TItem[]>): WorkflowOperation<TItem | undefined>;
  addEventListener(type: 'change' | 'conflict' | 'exhausted', listener: EventListener): void;
  removeEventListener(type: 'change' | 'conflict' | 'exhausted', listener: EventListener): void;
}
```

### `WorkflowRegistration`

```ts partial
interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  version?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  handler: WorkflowFunction<TInput, TOutput>;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
}
```

### `RegisteredWorkflowDefinition`

Read-only metadata returned by engine workflow-definition introspection.

```ts partial
interface RegisteredWorkflowDefinition<TInput = unknown, TOutput = unknown> {
  type: string;
  version: string;
  tags: ReadonlyArray<string>;
  description?: string;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
}
```

### `WorkflowRegistry` and `ActivityTypes`

Module-augmentation interfaces for typed workflow starts and activity runs. `ActivityTypes` is the augmentation target for activities; `ActivityRegistry` remains the runtime registration class.

```ts partial
interface WorkflowRegistry {}
interface ActivityTypes {}
```

```ts
import 'weft';

interface TypedWelcomeInput {
  name: string;
}

interface TypedWelcomeOutput {
  greeting: string;
}

interface TypedFormatGreetingInput {
  name: string;
}

declare module 'weft' {
  interface WorkflowRegistry {
    typedWelcome: { input: TypedWelcomeInput; output: TypedWelcomeOutput };
  }

  interface ActivityTypes {
    typedFormatGreeting: (input: TypedFormatGreetingInput) => Promise<string>;
  }
}
```

### `ReviewStatus`

```ts partial
type ReviewStatus = 'pending' | 'completed';
```

### `ReviewListFilter`

Optional filter accepted by `engine.listReviews(filter?)` and the `/v1/reviews` transport surface.

```ts partial
interface ReviewListFilter {
  status?: ReviewStatus;
  workflowId?: string;
  reviewType?: string;
}
```

### `ReviewListEntry`

Discriminated union returned by `engine.listReviews(filter?)`.

```ts partial
type ReviewListEntry = PendingReviewEntry | CompletedReviewEntry;

interface PendingReviewEntry extends ReviewRequest {
  status: 'pending';
}

interface CompletedReviewEntry extends ReviewDecision {
  status: 'completed';
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  allowPartial: boolean;
  timeout?: number;
  webhookUrl?: string;
  createdAt: number;
}
```

Completed review entries include the original request metadata above plus the
persisted reviewer decision.

### `Duration`

A number (milliseconds) or a human-readable string like `'5s'`, `'2m'`, `'1h'`.

```ts partial
type Duration = number | string;
```

### `Checkpoint`

Snapshot of workflow state at a `yield*` boundary.

```ts partial
interface Checkpoint {
  workflowId: WorkflowId;
  step: number;
  locals: Record<string, unknown>;
  pendingSignals: string[];
  searchAttributes: Record<string, SearchAttributeValue>;
  version: string;
  createdAt: number;
}
```

### `RetryPolicy`

```ts partial
interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}
```

See [Configuration](./configuration.md) for default values.

### `ActivityFunction`

```ts partial
type ActivityFunction<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ActivityContext,
) => Promise<TOutput> | TOutput;
```

### `ActivityContext`

```ts partial
interface ActivityContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
}
```

### `ActivityDefinition`

```ts partial
interface ActivityDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  execute: ActivityFunction<TInput, TOutput>;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
}
```

`inputSchema` and `outputSchema` are definition metadata, not automatic execution validators.

### `ActivityMetadata`

Name-based metadata stored by `ActivityRegistry` and returned from engine activity introspection.

```ts partial
interface ActivityMetadata {
  name: string;
  queue: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema;
  outputSchema?: DefinitionSchema;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}
```

Returned activity metadata is name-based. Aliases are reported separately even when they point at the same function.

### `ActivityRegistrationOptions`

Explicit metadata overrides for `engine.registerActivity()` and `ActivityRegistry.register()`.

```ts partial
interface ActivityRegistrationOptions {
  queue?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema;
  outputSchema?: DefinitionSchema;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}
```

### `ActivityCallOptions`

Per-invocation options when calling an activity from a workflow.

```ts partial
interface ActivityCallOptions {
  timeout?: Duration;
  queue?: string;
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  sticky?: boolean;
}
```

### `EngineOptions`

```ts partial
interface EngineOptions {
  storage?: Storage;
  development?: boolean;
  serializer?: Serializer;
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  broadcastEvents?: boolean;
  tenantResolver?: TenantResolver;
  quotas?: TenantQuotaOptions;
  retention?: RetentionPolicy;
  compression?: boolean;
  workerExecution?: WorkerExecutionOptions;
  activityExecution?: ActivityExecutionOptions;
  alerts?: AlertOptions[];
}
```

See [Configuration](./configuration.md) for detailed field descriptions and defaults.

### `StartOptions`

```ts partial
interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  searchAttributes?: Record<string, SearchAttributeValue>;
}
```

### `Serializer`

Pluggable serialization interface.

```ts partial
interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}
```

### `SearchAttributeValue`

```ts partial
type SearchAttributeValue = string | number | boolean | Date | string[];
```

### `SearchAttributeSchema`

```ts partial
type SearchAttributeSchema = Record<string, SearchAttributeDefinition>;

type SearchAttributeDefinition =
  | { type: 'string'; format?: string }
  | { type: 'number' | 'integer' }
  | { type: 'boolean' }
  | { type: 'array'; items?: { type: 'string'; format?: string } };
```

### `ListFilter`

```ts partial
interface ListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  attributes?: AttributeFilter[];
  limit?: number;
  offset?: number;
}

interface AttributeFilter {
  key: string;
  value?: SearchAttributeValue;
  gt?: SearchAttributeValue;
  lt?: SearchAttributeValue;
  gte?: SearchAttributeValue;
  lte?: SearchAttributeValue;
}
```

### `PaginatedResult`

```ts partial
interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```

### `WorkflowSummary`

Returned by `engine.list()`.

```ts partial
interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  version: string;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
}
```

---

## Event Types

### `WeftEventMap`

Maps event type strings to their corresponding event classes.

```ts partial
interface WeftEventMap {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
  'storage:size-reported': StorageSizeReportedEvent;
  'alert:fired': AlertFiredEvent;
  'alert:resolved': AlertResolvedEvent;
  'constraint:violated': ConstraintViolatedEvent;
}
```

### `TypedEventTarget`

A type-safe overlay for `EventTarget` that narrows listener signatures based on event type.

```ts partial
interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}
```

---

## Context Types

### `ContextOperationRequest`

Discriminated union of all operation descriptors yielded by `Context` methods. The engine inspects the `type` field to decide what to execute.

```ts partial
type ContextOperationRequest =
  | {
      type: 'activity';
      operationId: string;
      activityName: string;
      fn?: (input: unknown, context?: unknown) => unknown;
      input: unknown;
      callerStack?: string;
      options?: Record<string, unknown>;
    }
  | { type: 'sleep'; operationId: string; duration: number; scheduledFireAt: number }
  | { type: 'wait-signal'; operationId: string; signalName: string }
  | { type: 'wait-update'; operationId: string; updateName: string }
  | { type: 'parallel'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'race'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'memo'; operationId: string; key: string; fn: () => unknown }
  | {
      type: 'child-workflow';
      operationId: string;
      workflowType: string;
      input: unknown;
      options?: Record<string, unknown>;
    }
  | { type: 'offload'; operationId: string; key: string; fn: () => Promise<unknown> }
  | { type: 'load'; operationId: string; reference: OffloadReference }
  | { type: 'archive'; operationId: string; key: string; data: unknown }
  | {
      type: 'run-all';
      operationId: string;
      branches: Record<string, [Function] | [Function, unknown]>;
    }
  | { type: 'wait-review'; operationId: string; options: HumanReviewOptions };
```

### `ContextOptions`

Options passed to construct a `Context` instance (internal).

```ts partial
interface ContextOptions {
  workflowId: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  getNow?: () => number;
}
```

### `OffloadReference`

Returned by `ctx.offload()`, consumed by `ctx.load()`.

```ts partial
interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}
```

---

## Interceptor Types

### `WorkflowInterceptor`

```ts partial
interface WorkflowInterceptor {
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
}
```

### `ActivityInterceptor`

```ts partial
interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}
```

### `WorkflowStartInterception`

```ts partial
interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
}
```

### `ActivityInterception`

```ts partial
interface ActivityInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}
```

### `SleepInterception`

```ts partial
interface SleepInterception {
  duration: number;
  headers: Map<string, string>;
}
```

### `SignalInterception`

```ts partial
interface SignalInterception {
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}
```

### `ActivityExecutionInterception`

```ts partial
interface ActivityExecutionInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}
```

---

## Storage Types

### `Storage`

KV-oriented storage interface. All storage adapters (`MemoryStorage`, `BunSQLiteStorage`) implement this.

```ts partial
interface Storage extends Disposable {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

### `BatchOperation`

```ts partial
type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };
```

### `ScanOptions`

```ts partial
interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}
```

---

## Server Types

### `ServeOptions`

```ts partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
}
```

### `WeftServer`

```ts partial
interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): Promise<void>;
}
```

---

## Testing Types

### `MockHandle`

```ts partial
interface MockHandle<TInput, TResult> {
  readonly calls: ReadonlyArray<MockCall<TInput, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TInput, TResult> | undefined;
  mockImplementation(implementation: (input: TInput) => TResult | Promise<TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TInput, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TInput, TResult>;
  resetCalls(): void;
  restore(): void;
}
```

### `MockCall`

```ts partial
interface MockCall<TInput, TResult> {
  readonly input: TInput;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}
```

---
