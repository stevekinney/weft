# Context API

The `Context` class is the workflow's view of the durable execution runtime. It is the `context` parameter passed as the first argument to every workflow generator function. Each durable method is a generator that yields a `ContextOperationRequest` descriptor back to the engine -- the engine handles execution and feeds results back via `generator.next(result)`.

Context does not execute activities or interact with storage directly.

## `Context`

```ts partial
class Context implements WorkflowContext
```

### Constructor

```ts partial
new Context(options: ContextOptions)
```

Typically constructed by the engine -- you will not create `Context` instances directly.

### Read-only Properties

| Property                 | Type             | Description                                                                             |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------------- |
| `workflowId`             | `string`         | The workflow's unique identifier                                                        |
| `workflowType`           | `string`         | The registered workflow type name                                                       |
| `startedAt`              | `number`         | Epoch timestamp when the workflow started                                               |
| `signal`                 | `AbortSignal`    | Abort signal -- fires when the workflow is cancelled                                    |
| `executionTimeRemaining` | `number`         | Milliseconds until execution deadline. `Infinity` if no deadline is set.                |
| `log`                    | `WorkflowLogger` | Checkpoint-aware structured logger scoped to this run. See [`log`](#log).               |
| `stepIndex`              | `number`         | Current step counter (incremented by each durable operation)                            |
| `nestingDepth`           | `number`         | How many levels deep this workflow is as a child workflow. `0` for top-level workflows. |

> [!NOTE]
> `workflowType` is part of the public `WorkflowContext` interface. `stepIndex` and `nestingDepth` are available on the concrete `Context` class for debugging purposes; they are not part of the public interface.

---

## Durable Operations

Each durable method is a generator. Inside a workflow, call them with `yield*`:

```ts partial
async function* example(context: Context) {
  const result = yield* context.run('myActivity', { first: 'arg1', second: 'arg2' });
}
```

### `run()`

```ts partial
// Without per-call options:
*run<TName extends keyof TActivities & string>(
  name: TName,
  ...rest: ActivityArgsFor<TActivities[TName]>
): WorkflowOperation<ActivityResultFor<TActivities[TName]>>

// With a trailing ActivityCallOptions:
*run<TName extends keyof TActivities & string>(
  name: TName,
  ...rest: [...ActivityArgsFor<TActivities[TName]>, ActivityCallOptions]
): WorkflowOperation<ActivityResultFor<TActivities[TName]>>
```

Execute a registered activity durably by name. The engine checkpoints before the call and records the result. When recovery reaches a checkpoint-restored step, cached results are returned without re-executing the activity. The `name` is the activity's registered name—the durable dispatch key Weft uses for local dispatch and for remote dispatch alike. When the workflow is typed through its `.activities({ ... })` registry, `TActivities` carries the declared names, so `name` autocompletes and the input and result types are inferred (the exported `ActivityArgsFor` and `ActivityResultFor` helpers let you spell those types out by hand). An optional `ActivityCallOptions` argument may follow the input to override retry, timeout, queue, or idempotency for a single call.

| Parameter | Type                  | Description                            |
| --------- | --------------------- | -------------------------------------- |
| `name`    | `string`              | The registered activity name to run    |
| `input`   | `unknown`             | Single input value passed to activity  |
| `options` | `ActivityCallOptions` | Optional per-invocation activity rules |

**Returns:** The activity's return value.

```ts partial
async function* orderWorkflow(context: Context, order: Order) {
  const receipt = yield* context.run('chargeCard', {
    cardToken: order.cardToken,
    total: order.total,
  });
  yield* context.run('sendConfirmation', { email: order.email, receipt });
  return receipt;
}
```

### `sleep()`

```ts partial
*sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown>
```

Pause the workflow for the given duration. The sleep is durable -- if the process restarts, the timer resumes from where it left off.

| Parameter  | Type       | Description                                                 |
| ---------- | ---------- | ----------------------------------------------------------- |
| `duration` | `Duration` | Milliseconds or a human-readable string like `'5m'`, `'1h'` |

```ts partial
async function* example(context: Context) {
  yield* context.sleep('30s');
  yield* context.sleep(5000);
}
```

### `waitForSignal()`

```ts partial
*waitForSignal<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown>
```

Suspend the workflow until a named signal is delivered. If the signal was already sent before the workflow reached this point, it is consumed immediately.

| Parameter | Type     | Description                 |
| --------- | -------- | --------------------------- |
| `name`    | `string` | The signal name to wait for |

**Returns:** The signal's payload, typed as `T`.

```ts partial
async function* example(context: Context) {
  const approval = yield* context.waitForSignal<{ approved: boolean }>('approval');
  if (!approval.approved) {
    return { status: 'rejected' };
  }
}
```

### `waitForUpdate()`

```ts partial
*waitForUpdate<T = unknown>(
  name: string,
): Generator<ContextOperationRequest, { payload: T; respond: (result: unknown) => void }, unknown>
```

Suspend the workflow until a named update is received. Similar to `waitForSignal` but designed for request/response-style interactions.

| Parameter | Type     | Description                 |
| --------- | -------- | --------------------------- |
| `name`    | `string` | The update name to wait for |

**Returns:** The update envelope with the payload typed as `T` and a `respond(result)` callback.

### `waitUntil()`

```ts partial
waitUntil(predicate: () => boolean): WorkflowOperation<void>
waitUntil(predicate: () => boolean, timeout: Duration): WorkflowOperation<boolean>
```

Wait until `predicate` returns `true`. The engine re-evaluates the predicate whenever the workflow is driven forward—each time an `onUpdate` handler mutates workflow-local state, or when the optional `timeout` elapses. This is the condition-variable primitive (Temporal's `condition()`): a `waitUntil` whose predicate reads state mutated by `onUpdate` handlers re-checks in-process without polling.

The predicate must be **pure**. It may read only checkpoint-restored workflow-local state and must not perform I/O, generate randomness, or read wall-clock time. It is a non-serializable closure (like `ctx.memo`'s function), held in-process and never checkpointed. Once the wait outcome has been checkpointed, recovery returns the cached outcome and does not re-invoke the predicate. A predicate that throws fails the workflow at the `yield* context.waitUntil` call site (like a throwing activity), so the workflow body can `try`/`catch` it.

> [!NOTE]
> Weft signals are pull-only (`ctx.waitForSignal`) and run no state-mutating handler, so signal delivery does **not** re-drive a `waitUntil`. Use `onUpdate` to push the state a predicate observes.

`waitUntil` is inline-execution only: worker execution does not expose this operation (it is omitted from the worker context type), because the predicate closure cannot cross to a worker process. It also cannot be a `ctx.race`, `ctx.all`, or `ctx.speculate` branch; use `yield* ctx.waitUntil(...)` directly.

| Parameter   | Type            | Description                                                |
| ----------- | --------------- | ---------------------------------------------------------- |
| `predicate` | `() => boolean` | Pure condition re-evaluated on each state change           |
| `timeout`   | `Duration`      | Optional deadline; without it the wait blocks indefinitely |

**Returns:** `void` once the predicate is met (no timeout), or `boolean`—`true` when the predicate was met, `false` when the deadline elapsed first. If both happen on the same tick the predicate wins (`true`).

```ts partial
async function* example(context: Context) {
  let votes = 0;
  context.onUpdate('vote', () => {
    votes += 1;
  });
  // Block until three votes arrive, or give up after an hour.
  const reached = yield* context.waitUntil(() => votes >= 3, '1h');
  return reached ? 'quorum' : 'timed-out';
}
```

### `getVersion()`

```text
*getVersion(
  changeId: string,
  minSupported: number,
  maxSupported: number,
): Generator<ContextOperationRequest, number, unknown>
```

Pin a named workflow patch to a deterministic numeric version. The first execution stores `maxSupported` in checkpoint locals under `version:{changeId}`. Replay and recovery return that stored value, so in-flight workflows keep taking their original branch while new starts pin the newer version.

| Parameter      | Type     | Description                                     |
| -------------- | -------- | ----------------------------------------------- |
| `changeId`     | `string` | Stable name for the patch point                 |
| `minSupported` | `number` | Lowest version this code still knows how to run |
| `maxSupported` | `number` | Version to pin for workflows reaching it first  |

**Returns:** The pinned version for this workflow run.

```ts
import { type Context } from '@lostgradient/weft';

type Order = { id: string };

async function* example(context: Context, order: Order) {
  const version = yield* context.getVersion('shipping-v2', 1, 2);

  if (version === 1) {
    return yield* context.run('shipWithLegacyCarrier', order);
  }

  return yield* context.run('shipWithCarrierPool', order);
}

void example;
```

### `all()`

```ts partial
*all(
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown>
```

Run multiple durable operations in parallel. All operations must complete before the workflow continues. Rejection mirrors `Promise.all`—any branch fails, the whole operation fails. But timing is different: `ctx.all` waits for every sibling to settle before throwing the error. That delay is deliberate; it lets successful branches get persisted.

| Parameter    | Type          | Description                                                                                                       |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `operations` | `Generator[]` | An array of generators from `context.run()`, `context.sleep()`, `context.waitForSignal()`, `context.memo()`, etc. |

**Returns:** An array of results in the same order as the input operations.

**Failure semantics.** When any branch rejects, every fulfilled branch's value is written to the parent's in-memory cache entry before the error is thrown into the workflow generator. The entry becomes durable on the next checkpoint write (the workflow's next yield). If the workflow catches the rejection and yields again, that next yield persists the partial entry; a recovered run reaches the same step and reuses fulfilled slots without re-dispatch. If the workflow fails terminally without yielding again, the partial entry is **not** persisted—no recovered run can reuse it. This partial-preservation guarantee requires the default inline execution strategy; `workerExecution` cannot persist fulfilled branch slots after a sibling branch fails and reports that unsupported boundary explicitly.

See the [parallel execution guide](../guides/parallel-execution.md) for the full contract, including the deterministic-branch-order requirement and the explicit catch-and-yield boundary.

`context.waitForSignal()` inside `context.all()` is unbounded: the parent waits until that signal branch and every sibling settle. Use `context.race([context.waitForSignal(name), context.sleep('30s')])` when the signal wait needs a relative timeout.

```ts partial
async function* example(context: Context) {
  const [user, inventory] = yield* context.all([
    context.run('fetchUser', userId),
    context.run('checkInventory', sku),
  ]);
}
```

### `race()`

```ts partial
*race(
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown, unknown>
```

Run multiple durable operations in parallel, returning the result of whichever completes first. Analogous to `Promise.race`.

| Parameter    | Type          | Description                                                                                                       |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `operations` | `Generator[]` | An array of generators from `context.run()`, `context.sleep()`, `context.waitForSignal()`, `context.memo()`, etc. |

**Returns:** The result of the first operation to complete.

**Loser results are abandoned.** Once a winner is selected, Weft stops driving the losing branch generators and discards their results. In-flight activities that already started keep running unless the workflow is cancelled, so design race branches to be idempotent or pair them with compensation.

Signal-wait losers are non-destructive. If a `context.waitForSignal()` branch loses the race, it releases its waiter without consuming the durable signal record. Nested `all()` / `race()` branches defer signal consumption until the top coordinator has selected the winning result.

```ts partial
async function* example(context: Context) {
  const result = yield* context.race([
    context.run('fetchFromPrimary', key),
    context.run('fetchFromFallback', key),
  ]);
}
```

### `memo()`

```ts partial
*memo<T>(key: string, fn: () => T | Promise<T>): Generator<ContextOperationRequest, T, unknown>
```

Execute a function and cache its result by key. On checkpoint cache hits or repeated calls with the same key, the cached value is returned without re-executing. Useful for non-deterministic computations that must keep a stable value across recovery (e.g., generating an ID).

| Parameter | Type                    | Description                            |
| --------- | ----------------------- | -------------------------------------- |
| `key`     | `string`                | Cache key for deduplication            |
| `fn`      | `() => T \| Promise<T>` | Function to compute the memoized value |

**Returns:** The memoized result.

```ts partial
async function* example(context: Context) {
  const correlationId = yield* context.memo('correlationId', () => crypto.randomUUID());
}
```

### `runAll()`

```ts partial
*runAll<T extends Record<string, [Function] | [Function, unknown]>>(
  branches: T,
): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown>
```

Run multiple named activity branches in parallel. Returns a record mapping each branch name to its result.

| Parameter  | Type                                              | Description                                                             |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `branches` | `Record<string, [Function] \| [Function, input]>` | Named branches, each a tuple of `[activityFn]` or `[activityFn, input]` |

**Returns:** A record with the same keys, each holding the branch's result.

**Failure semantics.** Same partial-persistence contract as `ctx.all`. Branch identity is the **ordered key list** (not just the set of keys)—adding, removing, or reordering keys between attempts throws `BranchTopologyChangedError` to surface the non-determinism instead of silently mismatching slots.

```ts partial
async function* example(context: Context) {
  const results = yield* context.runAll({
    email: [sendEmail, { email: user.email, subject: 'Welcome!' }],
    slack: [notifySlack, { channel: '#signups', name: user.name }],
  });
  // results.email, results.slack
}
```

### `offload()`

```ts partial
*offload<T>(
  key: string,
  fn: () => Promise<T>,
): Generator<ContextOperationRequest, OffloadReference, unknown>
```

Move large data out of the checkpoint by computing it and storing it externally. The function `fn` is called to produce the data, which is then encoded with MessagePack and persisted at a storage key derived from the workflow ID and the provided `key`. Returns an `OffloadReference` that can be passed to `load()` later to retrieve the data.

| Parameter | Type               | Description                                                      |
| --------- | ------------------ | ---------------------------------------------------------------- |
| `key`     | `string`           | A unique identifier for this offloaded data within the workflow. |
| `fn`      | `() => Promise<T>` | An async function that produces the data to offload.             |

**Returns:** `OffloadReference` — an object containing `key`, `workflowId`, and `sizeBytes` (the byte length of the encoded data).

```ts partial
async function* example(context: Context) {
  const reference = yield* context.offload('large-dataset', async () => {
    return await fetchLargeDataset();
  });
  // reference.sizeBytes tells you how large the stored data is
  // Pass reference to load() when you need the data again
  const data = yield* context.load(reference);
}
```

### `load()`

```ts partial
*load<T>(reference: OffloadReference): Generator<ContextOperationRequest, T, unknown>
```

Load data that was previously offloaded via `offload()`. Reads the encoded data from storage using the reference's `workflowId` and `key`, decodes it, and returns the original value. Throws if the data is not found in storage.

| Parameter   | Type               | Description                                            |
| ----------- | ------------------ | ------------------------------------------------------ |
| `reference` | `OffloadReference` | The reference returned by a previous `offload()` call. |

**Returns:** `T` — the decoded data that was originally offloaded.

```ts partial
async function* example(context: Context) {
  const reference = yield* context.offload('large-dataset', async () => bigData);
  // ... later in the workflow, or even after recovery ...
  const data = yield* context.load<MyDataType>(reference);
}
```

### `archive()`

```ts partial
*archive(key: string, data: unknown): Generator<ContextOperationRequest, void, unknown>
```

Persist data to external archive storage, separate from the checkpoint. The data is encoded with MessagePack and stored at a key derived from the workflow ID and the provided `key`. Unlike `offload()`, archive is write-only from the workflow's perspective — the data is meant for auditing, debugging, or external queries rather than retrieval within the same workflow.

| Parameter | Type      | Description                                                     |
| --------- | --------- | --------------------------------------------------------------- |
| `key`     | `string`  | A unique identifier for this archived data within the workflow. |
| `data`    | `unknown` | The data to archive. Must be structuredClone-compatible.        |

**Returns:** `void`

```ts partial
async function* example(context: Context) {
  yield* context.archive('processing-result-batch-1', {
    processedAt: new Date(),
    recordCount: records.length,
    summary: computeSummary(records),
  });
}
```

### `review()`

```ts partial
*review(options: HumanReviewOptions): Generator<ContextOperationRequest, HumanReviewResult, unknown>
```

Pause the workflow and request a human decision. The review request is persisted, the workflow stays suspended at the checkpoint, and the workflow resumes when a reviewer submits a decision.

| Parameter | Type                 | Description                                             |
| --------- | -------------------- | ------------------------------------------------------- |
| `options` | `HumanReviewOptions` | Review artifact, type, reviewers, timeout, and routing. |

**Returns:** The submitted review decision.

```ts partial
async function* paymentWorkflow(ctx: WorkflowContext, payment: PaymentRequest) {
  const decision = yield* ctx.review({
    artifact: payment,
    reviewType: 'payment-approval',
    timeout: 72 * 60 * 60 * 1000,
  });

  if (decision.decision !== 'approved') {
    return { status: 'rejected' };
  }

  const charge = yield* ctx.run('chargeCard', payment);
  return { status: 'charged', charge };
}
```

### `startChild()`

```ts partial
*startChild<TResult = unknown>(
  workflowType: string,
  input: unknown,
  options?: AwaitChildWorkflowOptions,
): Generator<ContextOperationRequest, TResult, unknown>

*startChild<TResult = unknown>(
  workflowType: string,
  input: unknown,
  options: DetachedChildWorkflowOptions,
): Generator<ContextOperationRequest, ChildWorkflowHandle<TResult>, unknown>
```

Start a child workflow. The child workflow is independently checkpointed -- it has its own workflow ID, its own state in storage, and its own lifecycle. With the default `parentClosePolicy: 'await'`, the parent workflow suspends at the `yield*` boundary until the child completes or fails.

| Parameter      | Type                   | Description                               |
| -------------- | ---------------------- | ----------------------------------------- |
| `workflowType` | `string`               | The registered name of the child workflow |
| `input`        | `unknown`              | Input to pass to the child workflow       |
| `options`      | `ChildWorkflowOptions` | Optional configuration for the child      |

**Returns:** The child workflow's return value, typed as `TResult`, for omitted or `'await'` policy. Returns `ChildWorkflowHandle<TResult>` for `'abandon'` and `'request-cancel'`.

If the child workflow throws, the error propagates into the parent and can be caught with `try/catch`.

```ts partial
async function* parentWorkflow(ctx: WorkflowContext, order: Order) {
  // Start a child workflow and wait for its result
  const receipt = yield* ctx.startChild<Receipt>('process-payment', {
    amount: order.total,
    cardToken: order.cardToken,
  });

  // Child failures propagate to the parent
  try {
    yield* ctx.startChild('send-notification', { email: order.email, receipt });
  } catch (error) {
    // Handle child failure gracefully
    yield* ctx.run('logFailure', error);
  }

  return { receipt, status: 'completed' };
}
```

`parentClosePolicy` controls whether the parent waits for the child result:

| Policy             | Return value                   | Behavior                                                                                                                        |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `'await'`          | `TResult`                      | Default behavior. The parent waits for the child result or failure.                                                             |
| `'abandon'`        | `ChildWorkflowHandle<TResult>` | Returns `{ id }` immediately and does not link the child to the parent's execution-state owner.                                 |
| `'request-cancel'` | `ChildWorkflowHandle<TResult>` | Returns `{ id }` immediately and registers parent cancellation to request cancellation of the child in the same engine process. |

`ChildWorkflowHandle` is a checkpointable reference. It intentionally contains durable data only; use `engine.getHandle(handle.id).snapshot()` or `engine.getHandle(handle.id).result()` from host code for live observation.

```ts
import type { WorkflowContext } from '@lostgradient/weft';

type Order = {
  cardToken: string;
  total: number;
};

type Receipt = {
  receiptId: string;
};

async function* parentWorkflow(ctx: WorkflowContext, order: Order) {
  const child = yield* ctx.startChild<Receipt>(
    'process-payment',
    {
      amount: order.total,
      cardToken: order.cardToken,
    },
    {
      parentClosePolicy: 'abandon',
    },
  );

  return { paymentWorkflowId: child.id };
}

void parentWorkflow;
```

`ctx.pipe()`, `ctx.map()`, and `ctx.reduce()` remain await-only because their contract is to collect child workflow results. Use direct `ctx.startChild()` calls for detached children. A forcible `terminate` policy is intentionally absent.

> **Nesting depth limit:** By default, child workflows can nest up to 10 levels deep. Configure `maxNestingDepth` in engine options to adjust this limit. Exceeding the limit throws an error into the parent workflow.

---

## Synchronous Operations

These methods do not yield and can be called directly (no `yield*`).

### `setAttribute()`

```ts partial
setAttribute(key: string, value: SearchAttributeValue): void
```

Set a single search attribute on the workflow. The change is batched and persisted at the next checkpoint.

### `setAttributes()`

```ts partial
setAttributes(attributes: Record<string, SearchAttributeValue>): void
```

Set multiple search attributes at once.

### `getAttribute()`

```ts partial
getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined
```

Read a search attribute by key.

### `getAttributes()`

```ts partial
getAttributes(): Readonly<Record<string, SearchAttributeValue>>
```

Read all search attributes as a frozen snapshot.

### `onUpdate()`

```ts partial
onUpdate(name: string, handler: (payload: unknown) => unknown): void
```

Register a synchronous handler for named updates. When `engine.update()` is called with this name, the handler runs immediately and its return value is sent back to the caller.

```ts partial
let progress = 0;
context.onUpdate('getProgress', () => progress);
```

### `onQuery()`

```ts partial
onQuery<TInput, TOutput>(
  definition: QueryDefinition<TInput, TOutput>,
  handler: (input: TInput) => TOutput | Promise<TOutput>,
): void
onQuery<TOutput>(
  definition: QueryDefinition<void, TOutput>,
  handler: () => TOutput | Promise<TOutput>,
): void
onQuery(name: string, handler: (input: unknown) => unknown): void
```

Register a read-only handler for workflow queries. Prefer a typed `query()` definition, which carries the query input and output types through `ctx.onQuery()`, `engine.query()`, and `handle.query()`. String names are still accepted for untyped registries. When a matching query is called, the handler runs against the workflow's current context and returns its value to the caller.

Signal-parked inline workflows keep query handlers callable while they wait at `waitForSignal()`. If the workflow resumes and parks again, queries use the fresh post-resume context. After the workflow is suspended or reaches a terminal state, the retained context is torn down and a query with that name returns `undefined`.

```ts partial
async function* example(context: Context) {
  const phaseQuery = query<void, string>('phase');
  let phase = 'starting';
  context.onQuery(phaseQuery, () => phase);
  phase = 'waiting';
  yield* context.waitForSignal('continue');
}
```

### `expose()`

```ts partial
expose(accessors: Record<string, () => unknown>): void
```

Expose named read-only accessors for external introspection.

### `explain()`

```ts partial
explain(enabled?: boolean): void
```

Enable or disable explain mode. When enabled, durable operations log detailed checkpoint and dispatch information to the console. Useful for debugging checkpoint cache-hit and dispatch behavior.

### `log`

```ts partial
readonly log: WorkflowLogger;
```

A structured logger scoped to the run. Each method (`debug`, `info`, `warn`, `error`) emits a record to the current process console (`console.debug` / `console.info` / `console.warn` / `console.error`) with `workflowId`, `workflowType`, `level`, and `timestamp` auto-attached:

```ts partial
ctx.log.info('charge succeeded', { amount: 1999, currency: 'usd' });
```

Caller-supplied attributes are nested under their own `attributes` key in the record, so they can never shadow an envelope field. `ctx.log.info('x', { workflowId: 'spoof' })` keeps the real `workflowId` on the envelope and quarantines `{ workflowId: 'spoof' }` inside `attributes`.

`ctx.log` is checkpoint-aware. When the engine reaches a step position whose result was restored from the checkpoint, the logger suppresses the call so a recovered run does not re-emit logs it already emitted. At an uncached live frontier, the log emits normally. This holds in both inline and worker execution modes, unlike `ctx.services`-injected loggers, which are inline-only. `ctx.log` is _not_ a durable operation: it consumes no step index and is never checkpointed.

> [!NOTE] Checkpoint edge cases
> A log placed _after_ the last committed step re-fires on recovery, because there is no cached step to suppress it. Likewise, a workflow with no committed durable step has no checkpoint-restored position to suppress against, so its logs may re-emit on recovery. Logs inside `ctx.all` / `ctx.runAll` branches follow that branch's cached-step behavior.

> [!NOTE] Log destination
> Records go to the current process console. In worker-pool mode that is the worker process's console, not the engine host. Inline timestamps come from the engine clock; worker-mode timestamps come from the worker process wall clock. A pluggable host sink and worker-mode host log routing are tracked in [issue #491](https://github.com/stevekinney/weft/issues/491).

`log` is typed `readonly log?: WorkflowLogger` on the public `WorkflowContext` interface (optional, so existing structural implementors are not source-broken), but the engine always populates it at runtime, so within a real workflow body it is always present. The `WorkflowLogger` type is exported so a host can also type a logger it injects through `ctx.services`.

### `state`

```ts partial
readonly state: WorkflowStateNamespace
```

Return the workflow state namespace.

- `ctx.state.session<T>(key, options?)` is checkpoint-local and synchronous. It is private to the current workflow instance.
- `ctx.state.execution<T>(key, options?)` is storage-backed and shared by a parent workflow, durable child workflows, and concurrent branches in that execution tree.
- `ctx.state.workflow<T>(key, options?)` is storage-backed and shared by every run of the current workflow type.

All factories accept `options.initial`, captured when the handle is constructed.
Session handles expose synchronous `.get()`, `.set()`, `.update()`, `.delete()`,
convenience methods, and `.run()`. Durable handles expose yielded `.get()`,
`.set()`, `.update()`, `.delete()`, and the same convenience methods.

```ts partial
engine.register(
  workflow({ name: 'order' }).execute(async function* (ctx, order) {
    const attempts = ctx.state.session<number>('chargeAttempts', { initial: 0 });
    attempts.set((attempts.get() ?? 0) + 1);
    if (attempts.get()! > 3) {
      return { status: 'abandoned' };
    }

    const typeCharges = ctx.state.workflow<number>('chargeCount', { initial: 0 });
    yield* typeCharges.increment();

    const receipt = yield* ctx.run('chargeCard', order.token);
    return { status: 'charged', receipt };
  }),
);
```

`ctx.state.session()` is synchronous -- no `yield*` needed. Durable state methods
must be yielded because they read and commit through storage.

> [!WARNING] Inline execution mode only
> `ctx.state.session()` throws on first call under `workflowExecutionMode: 'worker'` because checkpoint-local session handles live inside the inline workflow context. Use `workflowExecutionMode: 'inline'` when you need session state, or use storage-backed `ctx.state.workflow()` / `ctx.state.execution()` state in worker mode. See [Workflow Execution Mode](./configuration.md#workflow-execution-mode) for the context surfaces that are unavailable in worker mode.

---

## Step-Based Workflows

For workflows that do not need the full generator API, Weft offers a progressive disclosure alternative. Instead of writing `async function*` with `yield*`, you write a plain `async` function and call `ctx.step()` for each durable operation.

### `StepWorkflowContext`

```ts
interface StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}
```

The step context is a subset of the full `Context`. It exposes `workflowId`, `signal`, and a single `step()` method. Features like `sleep()`, `waitForSignal()`, `all()`, and `race()` are not available -- when you need those, use the generator API.

### `step()`

```ts partial
step<T>(name: string, fn: () => Promise<T> | T): Promise<T>
```

Execute a named step as a durable operation. Each `step()` call routes through the same durable activity machinery as `ctx.run(...)`: the engine assigns it a positional checkpoint slot, persists the result to the checkpoint, and -- on crash recovery -- returns the stored result without re-running `fn`. Completed steps are not re-executed when a workflow resumes. Steps execute sequentially -- one at a time.

| Parameter | Type                    | Description                                                    |
| --------- | ----------------------- | -------------------------------------------------------------- |
| `name`    | `string`                | The durable step label (shown in the timeline and diagnostics) |
| `fn`      | `() => Promise<T> \| T` | The function to execute (sync or async)                        |

**Returns:** A promise that resolves with the step function's return value.

> [!WARNING] Await steps in order
> Step durability is **positional**: a step is matched during recovery by the order in which it ran, not by its `name`. You must `await` each `ctx.step(...)` before starting the next one. Firing steps concurrently -- e.g. `await Promise.all([ctx.step('a', ...), ctx.step('b', ...)])` where a `.then(...)` continuation enqueues further steps -- can change the order steps are queued between the original run and a recovered run, which silently returns the wrong cached value after a crash. When you need parallelism, durable timers, or signals, graduate to the generator API.

> [!NOTE] Inline execution mode only
> Step-based workflows require `workflowExecutionMode: 'inline'` (the default). Worker execution mode drives workflows with a different context that has no step machinery, so a `compileStepWorkflow` workflow throws there -- use the generator API for worker mode.

```ts partial
engine.register(
  workflow({ name: 'onboard' }).execute(
    compileStepWorkflow(async (ctx: StepWorkflowContext, input: { name: string }) => {
      const user = await ctx.step('create-user', () => createUser(input.name));
      await ctx.step('send-email', () => sendWelcome(user));
      return user;
    }),
  ),
);
```

Step-based workflows compile to generators via `compileStepWorkflow(...)`. The engine always works with generators internally, but the compilation is explicit — `.execute(...)` only accepts generator workflows, so passing a plain `async` function would fail to typecheck.

---

## Types

### `ContextOptions`

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
  nestingDepth?: number;
}
```

### `ContextOperationRequest`

A discriminated union describing the operation the workflow wants the engine to perform:

```ts partial
type ContextOperationRequest =
  | { type: 'activity'; operationId: string; activityName: string; fn?: (input: unknown, context?: unknown) => unknown; input: unknown; ... }
  | { type: 'sleep'; operationId: string; duration: number; scheduledFireAt: number }
  | { type: 'wait-signal'; operationId: string; signalName: string }
  | { type: 'wait-update'; operationId: string; updateName: string }
  | { type: 'parallel'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'race'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'memo'; operationId: string; key: string; fn: () => unknown }
  | { type: 'child-workflow'; operationId: string; workflowType: string; input: unknown; ... }
  | { type: 'offload'; operationId: string; key: string; fn: () => Promise<unknown> }
  | { type: 'load'; operationId: string; reference: OffloadReference }
  | { type: 'archive'; operationId: string; key: string; data: unknown }
  | { type: 'run-all'; operationId: string; branches: Record<string, [Function] | [Function, unknown]> }
  | { type: 'wait-review'; operationId: string; options: HumanReviewOptions }
```

### `OffloadReference`

```ts
interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}
```
