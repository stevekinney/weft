# Engine API

The `Engine` class is the central orchestrator in Weft. It manages workflow registration, execution lifecycle, signal delivery, and storage coordination. `WorkflowHandle` is the per-workflow reference returned by `engine.start()`, giving you access to results, signals, updates, and event observation.

For public error-code routing across engine operations, see the source-complete [Error Codes](./api-errors.md) reference.

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

### `create()`

```ts partial
static create<
  TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition> = {},
  TActivityDefinitions extends Record<string, AnyActivityDefinition> = {},
>(
  options: EngineCreateOptions<TWorkflowDefinitions, TActivityDefinitions>,
): Promise<
  Engine<
    EngineCreateWorkflowRegistry<TWorkflowDefinitions>,
    InferActivityEntries<TActivityDefinitions>
  >
>
```

Construct an engine, register any `activities` first, register every workflow in the `workflows` map, then run recovery by default. Pass `recover: false` for tests, `ScopedStorage` isolation, or explicit operator inspection. Map keys are validated against each definition's runtime `name` so an accidentally mismatched key fails during startup.

By default the durable-timer polling loop starts whenever recovery runs (`recover !== false`), so `ctx.sleep(...)` and `engine.schedule(...)` timers fire in a long-lived in-process host. The `startScheduler` option decouples that from recovery: it controls _whether timers fire_, not _who drives `recoverAll`_. A host that owns its own recovery — passing `recover: false` so it can capture the recovered handles from its own `recoverAll()` — can still arm the poller with `startScheduler: true`. Conversely, `startScheduler: false` keeps the poller stopped even when recovery runs, for engines that tick the scheduler deterministically.

The `schedulerPollIntervalMs` option sets how often that poller scans for expired timers, defaulting to `DEFAULT_POLL_INTERVAL_MS` (1000ms). It is primarily a test seam: a regression test that asserts `startScheduler` armed (or did not arm) the poller can drop the interval to ~10ms instead of waiting a full real poll cycle, since the poll loop runs on a real `setInterval` rather than a macrotask.

TypeScript treats `Engine.create({ workflows: {} })` the same as omitting `workflows`: both return the default-registry engine type. A non-empty map narrows the returned engine type to those workflow definitions, so `engine.start(...)` autocompletes their names and checks their input/output types.

### `register()`

```ts partial
register(definition: WorkflowDefinition | ActivityDefinition): void
```

Register a workflow or activity definition built with the chained builder API. Workflow definitions are produced by `workflow({...}).execute(handler)` and can carry execution metadata (`version`, retention) and catalog-neutral definition metadata (`description`, `tags`, `inputSchema`, `outputSchema`) as builder options, plus `.searchAttributes(...)` as a chained method.

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

Return read-only metadata for one registered workflow type. Workflows registered without explicit version, tags, concurrency, or schemas default to version `1`, empty tags, no concurrency policy, and no schemas.

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

Pass `options.idempotencyKey` for at-most-once starts: the first call commits the workflow and a durable key→id mapping in one compare-and-swap, and every later call with the same key returns a handle to that run instead of starting a second (even after it reaches a terminal state). Concurrent same-key callers converge on one run. `id` and `idempotencyKey` are mutually exclusive — idempotency assigns its own generated id and dedups through the key, so supply one or the other. Idempotent start requires a storage backend with `conditionalBatch` and throws if it is absent.

The key→id mapping is permanent: it deliberately outlives terminal cleanup so repeat calls keep returning the same handle. When the workflow **record** is purged or swept by retention, the mapping itself **survives** (purge and retention do not touch the `start-idem:` keyspace) but now points at a run that no longer exists. The key is then **spent** — a subsequent call with the same key resolves the surviving mapping, finds no record, and throws `IdempotencyKeyPurgedError` (HTTP 409 over REST/JSON-RPC) rather than silently starting a new run (a fresh create would fail the still-present mapping CAS and strand the caller). Treat that error as "this key is consumed; start fresh with a different key," or keep retention longer than your deduplication window.

Pass `options.onTerminalConflict: 'start-new'` to **reuse a stable id across runs** once the prior run has finished — Weft's equivalent of Temporal's `WorkflowIdReusePolicy.ALLOW_DUPLICATE`. The classic case is a periodic job keyed by a deterministic id (e.g. `reconcile:installation-42`): the previous tick has already reached a terminal state, so the next tick would otherwise hit `WorkflowAlreadyExistsError`. With `'start-new'`, if the prior run under that id is terminal (`completed` | `failed` | `cancelled` | `timed-out`) Weft purges it while holding the same in-process start reservation a normal start holds (the same teardown as `engine.purge`, sweeping every key the run owned) and then starts a fresh run in its place; if the prior run is still **non-terminal** (running/pending), it throws `WorkflowAlreadyExistsError` unchanged — `'start-new'` never displaces a live run. The default, `'error'`, preserves the strict at-most-once-per-id contract (a duplicate id always throws, terminal or not). `'start-new'` requires an explicit `id` and is mutually exclusive with `idempotencyKey` (the idempotency mapping is permanent and at-most-once, so restarting under it would contradict that contract). Because the prior run's record is gone after a restart, a `WorkflowHandle` held against the old id resolves to the fresh run for every method (`result()`, `snapshot()`, status) — handles are id-scoped, not run-attempt-scoped. The reservation is held across the purge and the create, so two concurrent `'start-new'` calls for one id cannot both win — the loser sees `WorkflowAlreadyExistsError`. The purge-then-create is serialized against same-engine concurrent starts but is not a single atomic storage operation: a non-start observer can momentarily see the id absent during the sub-millisecond gap (acceptable for the reconciler use case, where list-continuity across a restart is not required).

> [!NOTE]
> `onTerminalConflict` is an in-process `engine.start`-only policy. It is deliberately **not** exposed over the REST/JSON-RPC `weft.workflows.start` operation — a conditionally-destructive start would break that operation's `destructive: false` contract — and it is rejected on `engine.startOrSignal` (whose identity is the permanent at-most-once idempotency key) and absent from `ctx.startChild` (a child re-attaches to an existing run by id on parent replay, so purging a terminal child mid-replay would break determinism). Extending restart semantics to those surfaces — and a dedicated remote `weft.workflows.restart` operation — is tracked in issue #489.

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

Reuse a stable id once the prior run is terminal (a periodic reconciler):

```ts partial
const handle = await engine.start(
  'reconcile',
  { installationId: 42 },
  { id: 'reconcile:installation-42', onTerminalConflict: 'start-new' },
);
```

### `startOrSignal()`

```ts partial
async startOrSignal<TName extends keyof WorkflowRegistry & string>(
  type: TName,
  input: WorkflowInput<WorkflowRegistry, TName>,
  signal: StartOrSignalSignal,
  options?: StartOptions,
): Promise<StartOrSignalResult<WorkflowOutput<WorkflowRegistry, TName>>>
```

Atomically start a workflow or signal it if it already exists (signal-with-start). When the target is absent, the workflow record and the first signal commit in one batch and the freshly-launched run consumes the signal on its first drive. When the target is **non-terminal** — running, pending, or suspended — the signal is delivered through the normal signal path. When the target is **terminal**, this throws `StartOrSignalConflictError`: a finished run cannot be signalled and is not silently replaced.

The result carries both the `handle` and a per-call `outcome`. `outcome: 'started'` means this call created the workflow. `outcome: 'signalled'` means this call delivered a signal to an existing run or lost a concurrent same-key create race and converged onto the winner. The outcome is not stored on the shared engine `WorkflowHandle`, because converged callers can share that handle while each call still has its own outcome.

Pass `options.idempotencyKey` to deduplicate independent callers such as retried webhooks. Convergence requires a **shared workflow identity**: a shared `options.idempotencyKey` (the signal id derives from the key, so callers that share only the key converge on one workflow and one signal) or a shared `options.id` plus `signal.signalId`. A bare `signal.signalId` with neither `options.id` nor `options.idempotencyKey` does **not** converge — each absent-target call generates its own workflow id, so concurrent callers create distinct runs. In that mode `startOrSignal` is an atomic start-with-one-initial-signal, not a convergence primitive. Supply exactly one of `signal.signalId` or `options.idempotencyKey` (not both); `options.idempotencyKey` and `options.id` are likewise mutually exclusive. Requires a storage backend with `conditionalBatch`.

> [!NOTE] Terminal-transition race
> The non-terminal check and the signal write are not a single atomic step. If the target workflow transitions to terminal in the narrow window between the two, the signal is dropped (the underlying signal path does not buffer onto a terminal run) and the returned handle is for the now-terminal run. This is the same at-least-once-detection / no-delivery-on-terminal behavior as `engine.signal`; it is not specific to `startOrSignal`.

> [!NOTE] Concurrent same-id pre-commit abort
> When two callers race on the same `options.id`, one reserves the id in memory before its durable record commits. If that winner then _aborts_ before committing — a storage failure, an oversized payload, or a start interceptor that throws — no run ever materializes. `startOrSignal` recovers from this internally: the losing caller waits for the reservation to clear, sees no committed run, and retries its own create, so it converges on a real run rather than stranding (a bounded retry guards the pathological case where every winner keeps aborting). A bare `engine.start` does _not_ retry — it surfaces the collision as `WorkflowAlreadyExistsError` for the caller to retry, preserving its strict at-most-once-per-id contract.

| Parameter | Type                  | Description                                           |
| --------- | --------------------- | ----------------------------------------------------- |
| `type`    | `string`              | Name of the registered workflow                       |
| `input`   | `unknown`             | Input data passed to the workflow generator           |
| `signal`  | `StartOrSignalSignal` | The signal `name`, optional `payload`, and `signalId` |
| `options` | `StartOptions`        | Optional start configuration                          |

```ts partial
const { handle, outcome } = await engine.startOrSignal(
  'order',
  { orderId: 'order-42' },
  { name: 'payment', payload: { status: 'succeeded' } },
  { idempotencyKey: 'webhook-order-42' },
);

console.log(handle.id, outcome);
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

Register a recurring schedule that starts a workflow on a cron expression or fixed interval, returning a `ScheduleHandle` for pausing, resuming, updating, or cancelling it. Call it either with a `ScheduleDefinition` object (`{ workflow, cron | every, input, overlapPolicy?, jitter? }`) or positionally with a workflow type, input, and a cron string or `ScheduleSpec`. The `ScheduleOptions.overlap` policy governs what happens when a tick fires while the previous run is still in flight. A _suspended_ previous run counts as in flight: it still holds the schedule slot, so under a non-`allow` policy (`skip`/`queue`/`cancel-running`) the next tick does not start a second run until the suspended run is resumed to completion or cancelled. The `ScheduleDefinition`, `ScheduleSpec`, and `ScheduleOptions` types carry JSDoc describing the spec formats (`{ cron }` vs `{ every }`) and the overlap values.

By default, `ScheduleOptions.backfill` is `false`: when a schedule timer is more than one second late, Weft skips the missed occurrence window instead of starting catch-up workflows. The schedule state and summary keep `missedFireCount` and `lastMissedFireAt`, and the engine emits `ScheduleMissedFireEvent` with the schedule ID, missed count, window start, and window end. Set `backfill: true` when downtime should produce immediate catch-up runs instead.

Set `ScheduleOptions.jitter` to a duration string or millisecond count when many schedules share the same cadence and should spread their effective dispatch times. Weft keeps `ScheduleState.nextFireAt` as the nominal pre-jitter occurrence timestamp, then derives a deterministic offset in `[0, jitter)` from the schedule ID and that nominal timestamp when writing the timer. The same schedule occurrence gets the same offset after recovery or replay without storing extra per-occurrence state.

When inline `resolveWorkflowServices` is configured, each scheduled occurrence resolves services before its workflow body can run. An available result is installed as `ctx.services`; an unavailable result or resolver throw fails only that occurrence and does not pause the schedule.

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

### `getLaunchMetadata()`

```ts partial
async getLaunchMetadata(): Promise<LaunchMetadata | null>
```

Shorthand for reading this workflow's original input and durable launch options from persisted state. Intended for recovered handles; returns `null` after purge or retention removes the workflow record.

### `snapshot()`

```ts partial
async snapshot(): Promise<WorkflowSnapshot | null>
```

Read the workflow's current status and checkpoint step without awaiting the final result. Intended for progress reattachment after `recoverAll()`; returns `null` after purge or retention removes the workflow record.

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

See [Configuration](./configuration.md) for defaults and Worker execution hardening options. `interceptors` is equivalent to registering each entry with `addInterceptor()` during construction. Explicit `workflowExecutionMode: 'worker'` is the untrusted workflow posture; inline execution remains available for trusted deployments. `resolveWorkflowServices` rebuilds services for recovered inline runs that were launched with `StartOptions.services`; its `info.launchOptions` includes the workflow id and current tags when present. When configured, it is also consulted for scheduled inline occurrences before their workflow bodies run, with `info.schedule` carrying the schedule id and occurrence timestamp when available.

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
  searchAttributes?: SearchAttributeSchema;
}
```

`inputSchema` and `outputSchema` use [Standard Schema](https://standardschema.dev/) or [Standard JSON Schema](https://standardschema.dev/json-schema) compatible metadata. They are stored for introspection and adapter-level discovery; the engine does not enforce them during local execution.

### `Duration`

```ts partial
type Duration = number | string;
```

Milliseconds as a number, or a human-readable string like `'1s'`, `'5m'`, `'2h'`.
