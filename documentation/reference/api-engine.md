# Engine API

The `Engine` class is the central orchestrator in Weft. It manages workflow registration, execution lifecycle, signal delivery, and storage coordination. `WorkflowHandle` is the per-workflow reference returned by `engine.start()`, giving you access to results, signals, updates, and event observation.

## `Engine`

```ts partial
class Engine extends EventTarget implements Disposable, AsyncDisposable
```

### Constructor

```ts partial
new Engine(options?: Partial<EngineOptions>)
```

Creates a new engine instance. All options are optional — sensible defaults are applied when omitted.

| Option                           | Type                       | Default               | Description                                                                    |
| -------------------------------- | -------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `storage`                        | `Storage`                  | `new MemoryStorage()` | Storage backend for workflow state and checkpoints                             |
| `development`                    | `boolean`                  | `false`               | Enable development-mode checkpoint validation                                  |
| `serializer`                     | `Serializer`               | built-in codec        | Custom serialization for checkpoint data                                       |
| `retention`                      | `RetentionPolicy`          | `undefined`           | Default retention policy for completed, failed, and cancelled workflows        |
| `retentionSweepInterval`         | `Duration`                 | internal default      | Interval for automatic retention sweeps                                        |
| `retentionSweepBatchSize`        | `number`                   | internal default      | Maximum workflows considered by one retention sweep                            |
| `history`                        | `HistoryPolicy`            | `undefined`           | Lifetime history circuit-breaker and event-log compaction policy               |
| `archive`                        | `ArchiveAdapter`           | `undefined`           | Best-effort sink for event-log ranges discarded by compaction                  |
| `payloadSize`                    | `PayloadSizePolicy`        | `undefined`           | Admission-time cap for workflow inputs, signal payloads, and activity results  |
| `compression`                    | `CompressionOptions`       | `undefined`           | Enable framed storage payload compression for checkpoints and activity results |
| `checkpointHistory`              | `number`                   | `10`                  | Number of historical checkpoints to retain                                     |
| `checkpointSizeWarningThreshold` | `number`                   | `65_536`              | Byte threshold that triggers a `CheckpointSizeWarningEvent`                    |
| `maxNestingDepth`                | `number`                   | `10`                  | Maximum allowed nesting depth for child workflows                              |
| `broadcastEvents`                | `boolean`                  | `false`               | Enable `BroadcastChannel` for cross-worker event coordination                  |
| `workflowExecutionMode`          | `'inline' \| 'worker'`     | `'inline'`            | Inline or Worker workflow execution; Worker mode requires `workerExecution`    |
| `workerExecution`                | `WorkerExecutionOptions`   | `undefined`           | Configuration for offloading workflow execution to Web Workers                 |
| `activityExecution`              | `ActivityExecutionOptions` | `undefined`           | Configuration for activity execution behavior                                  |
| `alerts`                         | `AlertOptions[]`           | `undefined`           | Metric alert thresholds that fire `AlertFiredEvent` / `AlertResolvedEvent`     |
| `interceptors`                   | `readonly Interceptor[]`   | `undefined`           | Unified interceptors registered at construction                                |

```ts
import { Engine } from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

const engine = new Engine({
  storage: new SQLiteStorage('./data/weft.db'),
  development: true,
  history: { maxEvents: 100_000, retentionWindow: 10_000 },
  payloadSize: { maxBytes: 1_048_576 },
});
```

`history.maxEvents` is a circuit breaker on lifetime event-log sequence. `history.retentionWindow` is optional compaction that reclaims old event-log records behind a confirmed checkpoint and durable watermark; it does not reset the lifetime counter. `archive` receives compacted ranges after deletion commits and is best-effort only. `payloadSize.maxBytes` rejects oversized workflow inputs, signal payloads, and activity results before any storage write, measuring the codec-encoded value before storage compression.

### `register()`

```ts partial
register(definition: WorkflowDefinition | ActivityDefinition): void
```

Register a workflow or activity definition built with the chained builder API. Workflow definitions are produced by `workflow({...}).execute(handler)` and can carry execution metadata (`version`, `migrate`, retention) and catalog-neutral definition metadata (`description`, `tags`, `inputSchema`, `outputSchema`) as builder options, plus `.searchAttributes(...)` as a chained method.

The schema fields are introspection metadata. Core workflow registration validates their Standard Schema metadata shape, but workflow execution does not validate input or output from these fields unless an adapter explicitly opts into that validation.

```ts partial
import { workflow } from 'weft';

engine.register(
  workflow({ name: 'send-email' }).execute(async function* (context, input) {
    const result = yield* context.run(sendEmail, { to: input.to, body: input.body });
    return result;
  }),
);

// Or with version metadata:
engine.register(
  workflow({
    name: 'send-email',
    version: '2',
    description: 'Send a transactional email',
    tags: ['email'],
  }).execute(async function* (context, input) {
    /* ... */
  }),
);
```

### `getWorkflowDefinition()`

```ts partial
getWorkflowDefinition(type: string): RegisteredWorkflowDefinition | undefined
```

Return read-only metadata for one registered workflow type. Workflows registered without explicit version, tags, or schemas default to version `1`, empty tags, and no schemas.

### `listWorkflowDefinitions()`

```ts partial
listWorkflowDefinitions(): RegisteredWorkflowDefinition[]
```

Return read-only metadata for all registered workflow types.

### `getActivityDefinition()`

```ts partial
getActivityDefinition(name: string): ActivityMetadata | undefined
```

Return read-only metadata for one registered activity name.

### `listActivityDefinitions()`

```ts partial
listActivityDefinitions(): ActivityMetadata[]
```

Return read-only metadata for all registered activity names. Activity definition introspection is name-based, so aliases are reported separately even when they point at the same function.

### `start()`

```ts partial
async start<TName extends keyof WorkflowRegistry & string>(
  type: TName,
  input: WorkflowInput<WorkflowRegistry, TName>,
  options?: StartOptions,
): Promise<WorkflowHandle<WorkflowOutput<WorkflowRegistry, TName>>>
```

Start a new workflow execution. Names declared in the augmentable `WorkflowRegistry` get typed input and typed `handle.result()` output. When a workflow registry is present, TypeScript rejects names outside that registry; use `workflow()` definitions with `Engine.create({ workflows })` or `engine.withWorkflow()` to add names explicitly. Throws if `type` is not registered or a workflow with the given `id` already exists.

| Parameter | Type           | Description                                 |
| --------- | -------------- | ------------------------------------------- |
| `type`    | `string`       | Name of the registered workflow             |
| `input`   | `unknown`      | Input data passed to the workflow generator |
| `options` | `StartOptions` | Optional start configuration                |

```ts partial
const handle = await engine.start('send-email', {
  to: 'user@example.com',
  body: 'Hello!',
});
```

### `signal()`

```ts partial
async signal(workflowId: string, name: SignalDefinition): Promise<void>
async signal<TInput>(workflowId: string, name: SignalDefinition<TInput>, payload: TInput): Promise<void>
async signal(workflowId: string, name: string, payload?: unknown): Promise<void>
```

Deliver a named signal to a running workflow. If the workflow is currently waiting for this signal via `context.waitForSignal()`, it resumes immediately. Otherwise the signal is persisted and consumed when the workflow next waits for it.

```ts partial
const approval = signal<{ approved: boolean }>('approval');
await engine.signal(handle.id, approval, { approved: true });
```

### `update()`

```ts partial
async update(
  workflowId: string,
  name: UpdateDefinition<TInput, TOutput> | string,
  payload?: unknown,
  options?: { timeout?: number },
): Promise<unknown>
```

Send a synchronous update to a running workflow and wait for the handler's return value. If the workflow has registered an `onUpdate` handler for `name`, the handler runs immediately and its return value is sent back. Falls back to the `UpdateCoordinator` with polling if no active handler is found. Default timeout is 5000ms.

```ts partial
const getProgress = update<void, number>('getProgress');
const count = await engine.update(handle.id, getProgress);
```

### `cancel()`

```ts partial
async cancel(workflowId: string): Promise<void>
```

Cancel a running workflow. Aborts the workflow's `AbortController`, cleans up the generator, updates the persisted state to `'cancelled'`, and rejects the result promise.

### `list()`

```ts partial
async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>>
```

List workflows with optional filtering and pagination. Scans all persisted workflow state and applies filters in memory.

```ts partial
const running = await engine.list({ status: 'running', limit: 20 });
```

### `getHandle()`

```ts partial
getHandle(workflowId: string): WorkflowHandle
```

Retrieve a `WorkflowHandle` for an existing workflow by ID. Uses a `WeakRef` cache internally — if the handle has been garbage collected, a new one is created. If the workflow is still running, the result promise chains off the existing resolver. If the workflow has already completed or failed, the result is loaded from storage.

### `addInterceptor()`

```ts partial
addInterceptor(interceptor: Interceptor): void
```

Register a unified interceptor. It participates in the workflow and/or activity pipeline based on which hooks it implements. See the [Interceptors reference](./api-interceptors.md) for details.

### `storage` (getter)

```ts partial
get storage(): Storage
```

Direct access to the underlying storage backend. Primarily useful for `TestEngine` and debugging.

### `scheduler` (getter)

```ts partial
get scheduler(): Scheduler
```

Direct access to the underlying scheduler. Primarily useful for `TestEngine` and debugging.

### Disposal

```ts partial
[Symbol.dispose](): void
[Symbol.asyncDispose](): Promise<void>
```

Clean up all engine resources — aborts the scheduler, clears active generators, handles, resolvers, signal waiters, sleep resolvers, and closes the `BroadcastChannel` if active. Supports both `using` and `await using` syntax.

```ts partial
{
  using engine = new Engine();
  // engine is disposed when this block exits
}
```

---

## `WorkflowHandle`

```ts partial
class WorkflowHandle extends EventTarget implements AsyncDisposable
```

A lightweight handle to an individual workflow execution. Returned by `engine.start()` and `engine.getHandle()`.

### `id`

```ts partial
readonly id: string
```

The workflow's unique identifier.

### `result()`

```ts partial
async result(): Promise<unknown>
```

Await the workflow's final result. Resolves when the workflow completes, rejects if it fails or is cancelled.

```ts partial
const handle = await engine.start('process-order', order);
const receipt = await handle.result();
```

### `signal()`

```ts partial
async signal(name: string, payload?: unknown): Promise<void>
```

Shorthand for `engine.signal(handle.id, name, payload)`.

### `cancel()`

```ts partial
async cancel(): Promise<void>
```

Shorthand for `engine.cancel(handle.id)`.

### `update()`

```ts partial
async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>
```

Shorthand for `engine.update(handle.id, name, payload, options)`.

### `[Symbol.asyncIterator]()`

```ts partial
async *[Symbol.asyncIterator](): AsyncIterableIterator<Event>
```

Iterate over workflow lifecycle events as they happen. Yields events for `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`, `activity:started`, `activity:completed`, `signal:received`, `update:received`, and `update:completed`. The iterator completes when a terminal event (`completed`, `failed`, `cancelled`) fires.

```ts partial
for await (const event of handle) {
  console.log(event.type);
}
```

### `[Symbol.observable]()`

Returns an observable-compatible object with a `subscribe` method for frameworks that use the TC39 Observable proposal.

### `[Symbol.asyncDispose]()`

```ts partial
async [Symbol.asyncDispose](): Promise<void>
```

No-op disposal — handles are lightweight and do not hold expensive resources.

---

## Types

### `EngineOptions`

```ts partial
interface EngineOptions {
  storage?: Storage;
  development?: boolean;
  serializer?: Serializer;
  retention?: RetentionPolicy;
  retentionSweepInterval?: Duration;
  retentionSweepBatchSize?: number;
  history?: HistoryPolicy;
  archive?: ArchiveAdapter;
  payloadSize?: PayloadSizePolicy;
  compression?: CompressionOptions;
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  broadcastEvents?: boolean;
  workflowExecutionMode?: 'inline' | 'worker';
  workerExecution?: WorkerExecutionOptions;
  activityExecution?: ActivityExecutionOptions;
  alerts?: AlertOptions[];
  interceptors?: readonly Interceptor[];
}
```

See [Configuration](./configuration.md) for defaults and Worker execution hardening options. `interceptors` is equivalent to registering each entry with `addInterceptor()` during construction. Explicit `workflowExecutionMode: 'worker'` is the untrusted workflow posture; inline execution remains available for trusted deployments.

### `StartOptions`

```ts partial
interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  searchAttributes?: Record<string, SearchAttributeValue>;
}
```

| Field              | Type                                   | Description                                                                                                                 |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `string`                               | Explicit workflow ID. Auto-generated UUID if omitted.                                                                       |
| `idempotencyKey`   | `string`                               | Deduplication key for at-most-once starts                                                                                   |
| `executionTimeout` | `Duration`                             | Maximum wall-clock time before automatic cancellation. Accepts milliseconds or human-readable strings like `'30s'`, `'5m'`. |
| `searchAttributes` | `Record<string, SearchAttributeValue>` | Initial search attributes for the workflow                                                                                  |

### `ListFilter`

```ts partial
interface ListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  attributes?: AttributeFilter[];
  limit?: number;
  offset?: number;
}
```

### `PaginatedResult<T>`

```ts
interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```

### `WorkflowSummary`

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

### `WorkflowStatus`

```ts partial
type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
```

### `WorkflowFunction`

```ts partial
type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;
```

See also `StepWorkflowFunction` in [types.md](./types.md) — the step-based variant that the engine auto-compiles to the generator form.

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

`inputSchema` and `outputSchema` use [Standard Schema](https://standardschema.dev/) or [Standard JSON Schema](https://standardschema.dev/json-schema) compatible metadata. They are stored for introspection and adapter-level discovery; the engine does not enforce them during local execution.

### `Duration`

```ts partial
type Duration = number | string;
```

Milliseconds as a number, or a human-readable string like `'1s'`, `'5m'`, `'2h'`.
