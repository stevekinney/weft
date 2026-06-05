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
| `resolveWorkflowServices`        | `WorkflowServicesResolver` | `undefined`           | Rebuild per-run inline `ctx.services` during fresh-process recovery            |
| `activityExecution`              | `ActivityExecutionOptions` | `undefined`           | Configuration for activity execution behavior                                  |
| `alerts`                         | `AlertOptions[]`           | `undefined`           | Metric alert thresholds that fire `AlertFiredEvent` / `AlertResolvedEvent`     |
| `interceptors`                   | `readonly Interceptor[]`   | `undefined`           | Unified interceptors registered at construction                                |

```ts
import { Engine } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

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
import { workflow } from '@lostgradient/weft';

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

Pass `options.idempotencyKey` for at-most-once starts: the first call commits the workflow and a durable key→id mapping in one compare-and-swap, and every later call with the same key returns a handle to that run instead of starting a second (even after it reaches a terminal state). Concurrent same-key callers converge on one run. The mapping is independent of `id`, so you may supply both. Idempotent start requires a storage backend with `conditionalBatch` and throws if it is absent.

`options.services` is inline-only host data exposed as `ctx.services`. It is never checkpointed. When recovering a workflow that was launched with services in a fresh process, configure `EngineOptions.resolveWorkflowServices` to rebuild the value before the generator advances. Passing `services` in Worker execution mode throws at start because the value cannot cross to a Worker.

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

### `startOrSignal()`

```ts partial
async startOrSignal<TName extends keyof WorkflowRegistry & string>(
  type: TName,
  input: WorkflowInput<WorkflowRegistry, TName>,
  signal: StartOrSignalSignal,
  options?: StartOptions,
): Promise<WorkflowHandle<WorkflowOutput<WorkflowRegistry, TName>>>
```

Atomically start a workflow or signal it if it already exists (signal-with-start). When the target is absent, the workflow record and the first signal commit in one batch and the freshly-launched run consumes the signal on its first drive. When the target is **non-terminal** — running, pending, or suspended — the signal is delivered through the normal signal path. When the target is **terminal**, this throws `StartOrSignalConflictError`: a finished run cannot be signalled and is not silently replaced.

Pass `options.idempotencyKey` to deduplicate independent callers such as retried webhooks. Concurrent callers converge on one workflow and one delivered signal: the signal id derives from the idempotency key when `signal.signalId` is omitted, so callers that share only the key still converge. Supply either `signal.signalId` or `options.idempotencyKey` — one of the two is required for convergence. Requires a storage backend with `conditionalBatch`.

| Parameter | Type                  | Description                                           |
| --------- | --------------------- | ----------------------------------------------------- |
| `type`    | `string`              | Name of the registered workflow                       |
| `input`   | `unknown`             | Input data passed to the workflow generator           |
| `signal`  | `StartOrSignalSignal` | The signal `name`, optional `payload`, and `signalId` |
| `options` | `StartOptions`        | Optional start configuration                          |

```ts partial
const handle = await engine.startOrSignal(
  'order',
  { orderId: 'order-42' },
  { name: 'payment', payload: { status: 'succeeded' } },
  { idempotencyKey: 'webhook-order-42' },
);
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

### `getOffload()`

```ts partial
async getOffload(workflowId: string, key: string): Promise<unknown>
```

Read a value previously written by `ctx.offload(key, ...)` for a workflow. This is the external reader for offloaded artifacts after `handle.result()` resolves. The public TypeScript return is `unknown` because Weft does not know your artifact type; handle `null` as the runtime "not found or swept" value.

```ts partial
const report = await engine.getOffload(handle.id, 'report');
```

Offloaded values survive normal completion and application failure so consumers can inspect them after the workflow reaches a terminal result. They are swept when a workflow is terminated, cancelled, or timed out. The method returns the decoded value, or `null` when no value is stored under that key.

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

### `schedule()`

```ts partial
schedule<TInput>(definition: ScheduleDefinition<TInput>): Promise<ScheduleHandle>;
schedule(
  type: string,
  input: unknown,
  spec: string | ScheduleSpec,
  options?: ScheduleOptions,
): Promise<ScheduleHandle>;
```

Register a recurring schedule that starts a workflow on a cron expression or fixed interval, returning a `ScheduleHandle` for pausing, resuming, updating, or cancelling it. Call it either with a `ScheduleDefinition` object (`{ workflow, cron | every, input, overlapPolicy? }`) or positionally with a workflow type, input, and a cron string or `ScheduleSpec`. The `ScheduleOptions.overlap` policy governs what happens when a tick fires while the previous run is still in flight. A _suspended_ previous run counts as in flight: it still holds the schedule slot, so under a non-`allow` policy (`skip`/`queue`/`cancel-running`) the next tick does not start a second run until the suspended run is resumed to completion or cancelled. The `ScheduleDefinition`, `ScheduleSpec`, and `ScheduleOptions` types carry JSDoc describing the spec formats (`{ cron }` vs `{ every }`) and the overlap values.

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

### `suspend()`

```ts partial
async suspend(): Promise<void>
```

Shorthand for `engine.suspend(handle.id)`. Pauses the workflow without terminating it — it moves to the non-terminal `'suspended'` status, keeps its checkpoint, and stops driving without aborting. Unlike `cancel()`, it does not run cancel handlers and does not settle `result()`. Resume it later with `resume()`. Inline execution mode only.

### `resume()`

```ts partial
async resume(): Promise<void>
```

Shorthand for `engine.resume(handle.id)`. Re-drives the workflow from its persisted checkpoint — after a `suspend()`, or after a process restart left it `'running'`. `result()` on this handle resolves when the resumed run completes.

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
  resolveWorkflowServices?: WorkflowServicesResolver;
  activityExecution?: ActivityExecutionOptions;
  alerts?: AlertOptions[];
  interceptors?: readonly Interceptor[];
}
```

See [Configuration](./configuration.md) for defaults and Worker execution hardening options. `interceptors` is equivalent to registering each entry with `addInterceptor()` during construction. Explicit `workflowExecutionMode: 'worker'` is the untrusted workflow posture; inline execution remains available for trusted deployments. `resolveWorkflowServices` is consulted only for recovered inline workflows that were originally launched with `StartOptions.services`.

### `StartOptions`

```ts partial
interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  startAt?: number;
  startAfter?: Duration;
  tags?: string[];
  searchAttributes?: Record<string, SearchAttributeValue>;
  services?: unknown;
}
```

| Field              | Type                                   | Description                                                                                                                 |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `string`                               | Explicit workflow ID. Auto-generated UUID if omitted.                                                                       |
| `idempotencyKey`   | `string`                               | Deduplication key for at-most-once starts                                                                                   |
| `executionTimeout` | `Duration`                             | Maximum wall-clock time before automatic cancellation. Accepts milliseconds or human-readable strings like `'30s'`, `'5m'`. |
| `startAt`          | `number`                               | Unix timestamp in milliseconds for a delayed start.                                                                         |
| `startAfter`       | `Duration`                             | Delay before starting the workflow.                                                                                         |
| `tags`             | `string[]`                             | Initial tags for workflow visibility.                                                                                       |
| `searchAttributes` | `Record<string, SearchAttributeValue>` | Initial search attributes for the workflow.                                                                                 |
| `services`         | `unknown`                              | Non-serialized per-run inline capabilities exposed as `ctx.services`; recovered by `EngineOptions.resolveWorkflowServices`. |

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
type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'suspended';
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
