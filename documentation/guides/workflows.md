# Workflows

You have a multi-step business process—charge a card, reserve inventory, send a confirmation email—and if anything crashes midway through, you need to pick up exactly where you left off. Not from the beginning. Not by replaying every step. From the _last successful point_, with all your local variables intact.

That is what a Weft workflow gives you.

## Getting started without generators

If you are not familiar with generators, Weft provides a simpler entry point. Write a plain `async` function that uses `ctx.step()` for each durable operation, then wrap it with `compileStepWorkflow(...)` before passing it to `.execute(...)`:

> [!NOTE]
> The generator workflow API is the primary engine surface. [`ctx.step()`](../reference/api-context.md#step-based-workflows) and [`compileStepWorkflow(...)`](../reference/api-context.md#step-based-workflows) are experimental sugar before 1.0; use them when they improve readability, but expect the generator API to define the stable semantics first.

```typescript partial
import {
  Engine,
  workflow,
  compileStepWorkflow,
  type StepWorkflowContext,
} from '@lostgradient/weft';

const engine = new Engine();

engine.register(
  workflow({ name: 'welcome' }).execute(
    compileStepWorkflow(async (ctx: StepWorkflowContext, input: { name: string }) => {
      const greeting = await ctx.step('greet', () => greet(input.name));
      await ctx.step('notify', () => notify(greeting));
      return { greeting, notified: true };
    }),
  ),
);
```

Each `ctx.step()` call is a checkpoint boundary, just like `yield*` in the generator API. The result is persisted with the checkpoint commit, and a step that already completed is restored from storage -- not re-run -- when the workflow recovers from a crash. `compileStepWorkflow(...)` compiles the step-based function into the generator shape the engine runs internally; the compilation step is explicit so the type system knows what `.execute(...)` is receiving.

The step-based API is a subset of the full API. It supports sequential steps only -- and you must `await` each step before starting the next, because durability is positional: a step is matched during recovery by the order it ran, not by its name. It also requires `workflowExecutionMode: 'inline'` (the default); worker execution mode has no step machinery. When you need durable timers (`sleep()`), external signals (`waitForSignal()`), parallel execution (`all()`, `race()`), or worker-mode isolation, graduate to the generator API described below.

## Generator functions as workflows

A workflow is an `async function*` that receives a context and an input. The generator syntax is the key: every `yield*` expression is a **checkpoint boundary** where Weft snapshots your entire local scope.

```typescript partial
import { Engine, workflow } from '@lostgradient/weft';

const engine = new Engine();

engine.register(
  workflow({ name: 'welcome' }).execute(async function* (ctx, input: { name: string }) {
    const greeting = yield* ctx.run('greet', { name: input.name });
    yield* ctx.run('notify', { message: greeting });
    return { greeting, notified: true };
  }),
);
```

The `async function*` declaration gives you a function that can pause itself with `yield` and be resumed later. Each pause preserves all local variables. `yield*` delegates to another generator—in this case, the context methods that represent durable operations. These are the only JavaScript primitives that give you serializable, suspendable execution, and they are a web standard that works everywhere.

So when you write `yield* ctx.run('greet', { name: input.name })`, two things happen: the named activity executes, and Weft captures a checkpoint of your workflow's state. If the process crashes after that line but before the next `yield*`, recovery resumes from the checkpoint—not from the top of the function.

Weft checkpoints instead of replaying workflow code, so recovery resumes from saved state without determinism constraints; the [Checkpoint vs. Replay architecture note](../architecture/checkpoint-versus-replay.md) is the canonical deep dive.

## The workflow lifecycle

Every workflow moves through a state machine with six possible states:

- **pending** -- created but not yet executing
- **running** -- actively advancing through its generator
- **completed** -- the generator returned a value
- **failed** -- an unhandled error escaped the generator
- **cancelled** -- explicitly cancelled via `handle.cancel()` or `engine.cancel(id)`
- **timed-out** -- hit its execution deadline

The `pending` state is only observable for workflows scheduled with `startAt` or `startAfter`; workflows started with a plain `engine.start()` call skip directly to `running`.

Transitions are one-way. A completed workflow stays completed. A failed workflow does not automatically retry (that is what [activities](activities.md) are for). This simplicity is deliberate—workflow state is easy to reason about because it only moves forward.

## Checkpoint serialization

Weft uses `structuredClone` semantics to serialize checkpoints—the same algorithm browsers use for `postMessage`. This means your local variables can contain:

- Primitives (strings, numbers, booleans, null, undefined)
- Plain objects and arrays
- `Date`, `Map`, `Set`, `RegExp`
- `ArrayBuffer` and `TypedArray`

They _cannot_ contain:

- Functions or closures
- Class instances with methods
- Symbols, `WeakMap`, `WeakRef`
- System resources (sockets, file handles, database connections)

The practical rule: if you can `structuredClone` it, it survives a checkpoint. If you cannot, keep it outside your workflow's local scope or derive it fresh after each `yield*`.

## Catching serialization bugs early

Set `development: true` when constructing your engine and Weft will validate every checkpoint round-trip as it happens. If a local variable would not survive serialization, you get a `DevelopmentWarningEvent` with the exact field paths that failed.

```typescript partial
const engine = new Engine({ development: true });

engine.addEventListener('development:warning', (event) => {
  console.warn(event.message, event.fieldPaths);
});
```

This is cheap insurance during development. Turn it off in production—the validation adds overhead you do not need once your workflows are proven correct.

## Registering workflows

The simplest registration builds a workflow definition with `workflow({ name }).execute(handler)` and passes it to `engine.register()`.

```typescript partial
engine.register(
  workflow({ name: 'order' }).execute(async function* (ctx, input) {
    // ...
  }),
);
```

When you need a recovery boundary for a workflow definition, pass a `version`
builder option.

```typescript partial
engine.register(
  workflow({
    name: 'order',
    version: '2',
  }).execute(async function* (ctx, input) {
    // ...
  }),
);
```

The `version` string tags every checkpoint so that Weft knows which workflow
definition produced it. Recovery rejects a stored checkpoint when the registered
version differs, which prevents a new handler from silently resuming state it may
not understand.

The builder also accepts `retention` (how long to keep terminal workflow state) and `constraints` (resource-level execution limits) as options, and exposes a chained `.searchAttributes(schema)` method to declare indexed attributes for this workflow type. See the [search attributes guide](./search-attributes.md) for `searchAttributes` usage.

### What you cannot change mid-flight

Checkpointing removes replay determinism rules, but it does not make every handler edit safe for a running workflow. A recovered workflow must still understand the checkpoint it is resuming from.

- Keep the order of durable `yield*` operations stable for workflows that may already be running. If you insert, remove, or reorder a durable boundary before an existing checkpoint position, bump the workflow `version` and run the new definition as a separate recovery boundary.
- Keep workflow-local values structured-cloneable at every checkpoint. Values such as functions, sockets, clients, class instances with methods, symbols, `WeakMap`, and `WeakRef` cannot be serialized into durable state; keep them outside workflow locals or rebuild them from `ctx.services` or activities after recovery.
- Treat activity names declared in `.activities({ ... })` as durable dispatch identity. Renaming a key changes the name Weft stores and dispatches; register a new activity name and update workflows deliberately instead of silently reusing the old slot for different work.

## Starting workflows and getting results

Call `engine.start()` with the registered name and your input. You get back a `WorkflowHandle`—a lightweight reference you can use to await the result, send [signals](signals-and-queries.md), or cancel execution.

```typescript partial
const handle = await engine.start('welcome', { name: 'World' }, { id: 'welcome:world' });
const result = await handle.result();
// { greeting: 'Hello, World!', notified: true }
```

You can also provide options when starting a workflow.

```typescript partial
const handle = await engine.start('order', orderData, {
  id: 'order-abc-123', // deterministic ID instead of random UUID
  executionTimeout: '30 minutes', // hard deadline for the entire workflow
});
```

If you omit `options.id`, Weft creates a fresh workflow id for this start. The `id` option is useful when you want idempotent starts—starting a workflow with an ID that already exists throws an error, so your caller can safely retry without creating duplicates and then reattach to the existing workflow.

### Per-run services

Most workflow state should be serializable and durable: inputs, local variables that survive checkpoints, activity results, session state, and offloaded artifacts. Sometimes the workflow also needs a live host capability that should never be written to storage, such as a database client, API client, closure, tool registry, or test double. Pass those capabilities through `engine.start(..., { services })` and read them from `ctx.services`:

```typescript partial
type OrderServices = {
  reserveInventory: (orderId: string) => Promise<void>;
};

function isOrderServices(value: unknown): value is OrderServices {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reserveInventory' in value &&
    typeof value.reserveInventory === 'function'
  );
}

engine.register(
  workflow({ name: 'order' }).execute(async function* (ctx, input: { orderId: string }) {
    if (!isOrderServices(ctx.services)) {
      throw new Error('order services unavailable');
    }

    yield* ctx.run(ctx.services.reserveInventory, input.orderId);
    return { reserved: true };
  }),
);

await engine.start('order', { orderId: 'order-123' }, { services: orderServices });
```

`ctx.services` is typed `unknown` because Weft does not own your application dependency graph. Narrow it at the call site or with a local type guard. The value is available only in inline workflow execution. Passing `services` with `workflowExecutionMode: 'worker'` throws at `engine.start()`, because a non-serializable object cannot cross to a Worker.

`services` is not durable data. Weft never checkpoints the object and never serializes it into workflow state. It persists only a presence marker for runs that were launched with services. On a fresh-process recovery, configure `Engine.create({ resolveWorkflowServices })` so the engine can rebuild that value before the generator advances:

```typescript partial
const engine = await Engine.create({
  storage,
  workflows: { order },
  resolveWorkflowServices: async ({ workflowId, input }) => {
    const orderId = (input as { orderId: string }).orderId;
    const services = await buildOrderServices(orderId);
    if (!services) {
      return { status: 'unavailable', reason: `No services for ${workflowId}` };
    }
    return { status: 'available', services };
  },
});
```

Fresh-process recovery consults the resolver only for inline runs that were launched with `services`, using the durable presence marker written at start. Scheduled inline occurrences are different: when `resolveWorkflowServices` is configured, each occurrence consults it before the workflow body runs. Returning `unavailable` or throwing fails only that run or scheduled occurrence with a system failure category. Child workflows do not inherit the parent's `services`; start each child with its own durable input and host services if it needs them.

> Warning: if a recovered run has the durable services marker but the fresh engine was created without `resolveWorkflowServices`, Weft fails that run before the workflow body advances and emits a `DevelopmentWarningEvent` naming the workflow id and `EngineOptions.resolveWorkflowServices`. It never resumes the workflow with `ctx.services === undefined`.

## Bounded checkpoint growth

Unlike systems that replay an ever-growing event history of side effects, Weft's canonical checkpoint stores current workflow state plus any still-pending replay entry. Completed operation results are moved into checkpoint-event replay metadata once they have been consumed, so they are not copied into every later checkpoint. If your workflow locals stay bounded, the serialized checkpoint stays bounded as the number of completed activities grows. There is no checkpoint-size-driven `continueAsNew` requirement or manual state serialization step.

Long-running workflows just run.

## Managing large state

While Weft no longer copies every completed operation result into each checkpoint, the data _inside_ your checkpoint can still grow if your workflow accumulates large intermediate results in local variables. Two context methods help you manage this. For small mutable state that should survive recovery—a counter, a flag, a conversation handle—reach for the lightweight [`ctx.state.session`](./session-state.md) primitive instead.

### Offloading large intermediate data

When a workflow produces a large value that it needs later—a batch of 10,000 processed records, a large API response—keeping it in a local variable bloats the checkpoint. Use `ctx.offload()` to store the data separately, leaving only a lightweight reference in the checkpoint:

```typescript partial
engine.register(
  workflow({ name: 'process-batch' }).execute(async function* (ctx, input: { batchId: string }) {
    // Offload the large result out of the checkpoint
    const reference = yield* ctx.offload('batch-results', async () => {
      return await fetchAndProcessBatch(input.batchId);
    });

    // reference.sizeBytes tells you how big the stored data is
    yield* ctx.run('logMetrics', { batchId: input.batchId, bytes: reference.sizeBytes });

    // Load it back when needed
    const results = yield* ctx.load(reference);
    yield* ctx.run('publishResults', results);

    return { batchId: input.batchId, recordCount: results.length };
  }),
);
```

The offloaded data survives engine recovery and normal completion — it is persisted to the same storage backend as checkpoints. The `OffloadReference` is small (just a key, workflow ID, and size) and serializes cleanly in the checkpoint. After `handle.result()` resolves, callers outside the workflow can read the artifact with `engine.getOffload(workflowId, key)`:

```typescript partial
const result = await handle.result();
const report = await engine.getOffload(handle.id, 'batch-results');

void result;
void report;
```

`getOffload()` returns the decoded value, or `null` when the key was never written, the workflow ID is unknown, or the artifact was swept after termination, cancellation, or timeout.

### Archiving historical data

Use `ctx.archive()` when you want to preserve data for auditing or debugging but do not need it again in the workflow. Archived data is stored at `archive:{workflowId}:{key}` and can be queried externally, but the workflow does not load it back:

```typescript partial
engine.register(
  workflow({ name: 'order-pipeline' }).execute(async function* (ctx, order: Order) {
    const validated = yield* ctx.run('validateOrder', order);

    // Archive the validation snapshot for auditing
    yield* ctx.archive('validation-snapshot', {
      validatedAt: new Date(),
      order,
      result: validated,
    });

    const charged = yield* ctx.run('chargeCard', validated);
    return { orderId: order.id, charged };
  }),
);
```

**When to use which:**

- **`offload` / `load`**: large data you need again later in the same workflow. Keeps the checkpoint lean while preserving access.
- **`archive`**: data you want to persist for external consumption (dashboards, compliance, debugging) but never read back in the workflow.

## Sagas and Compensation

Use `ctx.saga()` when a workflow needs a sequence of activities where completed work should be compensated if a later step fails. Each saga step contains an activity definition and the input for that activity:

```typescript
import { Engine, activity, workflow } from '@lostgradient/weft';

type Order = { id: string; sku: string; total: number };

async function releaseInventory(details: { sku: string; reservationId: string }): Promise<void> {
  void details;
}

async function refundCharge(details: { amount: number; chargeId: string }): Promise<void> {
  void details;
}

async function scheduleShipping(orderId: string): Promise<void> {
  void orderId;
}

const engine = new Engine();

const reserveInventory = activity({
  name: 'reserveInventory',
  execute: async (sku: string) => `reservation:${sku}`,
  compensate: async (sku: string, reservationId: string) => {
    await releaseInventory({ sku, reservationId });
  },
});

const chargeCard = activity({
  name: 'chargeCard',
  execute: async (amount: number) => `charge:${amount}`,
  compensate: async (amount: number, chargeId: string) => {
    await refundCharge({ amount, chargeId });
  },
});

const shipOrder = activity({
  name: 'shipOrder',
  execute: async (orderId: string) => {
    await scheduleShipping(orderId);
  },
});

engine.register(
  workflow({ name: 'fulfill-order' }).execute(async function* (ctx, order: Order) {
    return yield* ctx.saga([
      { definition: reserveInventory, input: order.sku },
      { definition: chargeCard, input: order.total },
      { definition: shipOrder, input: order.id },
    ]);
  }),
);

void engine;
```

Saga steps run sequentially through the same durable activity pipeline as `ctx.run()`. If a step fails, Weft runs compensators for previously completed steps in reverse order, skips the failing step's own compensator, swallows compensator errors, and then rethrows the original step error into the workflow. The saga result is the last successful step output, or `undefined` for an empty saga.

Cancellation has a narrower compensation path: in inline execution, cancelling an active saga runs completed compensators in reverse order through an in-memory, best-effort path. That path is _not_ durable — it is not recovered after an engine restart, and a hard cancel or a crash that evicts the workflow before it runs loses it. So, for saga compensation that must survive process failure, rely on normal activity idempotency and external reconciliation. When the thing you need to clean up is a single paid external resource (rather than a multi-step rollback), reach for a durable [`finalizer`](#durable-cancellation-teardown) instead — it survives hard cancel and crash.

## Durable cancellation teardown

A saga compensates a _sequence_ of steps, and `ctx.onCancel` runs an _in-memory, best-effort_ handler. Neither survives a hard cancel or a crash. So, when a workflow holds a single paid external resource — a sandbox, a leased VM, a reserved seat — that _must_ be released even if the process dies, use a **durable finalizer**.

A finalizer is two pieces working together: a definition-level `finalizer` activity, and a `ctx.setFinalizerState(value)` call that records what the finalizer needs to tear the resource down. Record the state the moment you acquire the resource. After the workflow reaches a `cancelled` or `timed-out` terminal, the engine drives the finalizer to durable completion — passing your recorded value as its input.

```typescript
import { Engine, activity, workflow } from '@lostgradient/weft';

type Sandbox = { id: string };

async function createSandbox(): Promise<Sandbox> {
  return { id: 'sandbox-1' };
}

async function destroySandboxById(sandboxId: string): Promise<void> {
  // Idempotent: destroying an already-destroyed sandbox must not throw.
  void sandboxId;
}

const engine = new Engine();

const destroySandbox = activity({
  name: 'destroySandbox',
  execute: async (state: { sandboxId: string }) => {
    await destroySandboxById(state.sandboxId);
  },
});

engine.register(
  workflow({ name: 'run-in-sandbox', finalizer: destroySandbox }).execute(async function* (ctx) {
    const sandbox = yield* ctx.run(createSandbox);
    // Record the teardown payload as soon as the resource exists, so the
    // engine can destroy it even if this run is hard-cancelled or crashes.
    ctx.setFinalizerState({ sandboxId: sandbox.id });
    yield* ctx.sleep('1h');
    return sandbox.id;
  }),
);

void engine;
```

What the engine guarantees once you have recorded finalizer state:

- **It runs on `cancelled` and `timed-out` only.** A workflow that `completed` or `failed` never runs its finalizer — those paths are the workflow's own responsibility (clean up in the body). Recording no state at all means the engine skips the finalizer entirely.
- **It survives crashes.** The drive runs from a durable timer and a claim marker that ride the same atomic batch as the terminal transition, so a crash mid-teardown re-drives the finalizer after recovery rather than dropping it.
- **It retries with backoff and dead-letters.** A finalizer that throws is retried on a backoff schedule; after it exhausts its attempt budget the failure is recorded durably (a dead-letter) rather than retried forever.
- **It runs _at least once_, so it must be idempotent.** Retries and crash-recovery re-drive mean your finalizer can see the same payload more than once. Destroying an already-destroyed resource must succeed (or no-op) — the same discipline as keying a destroy by `sandboxId`. This is the central contract: write the teardown so repetition is harmless.

The recorded value is last-write-wins: call `setFinalizerState` again to replace it when the live resource changes (for example, after re-provisioning). Recording `null` still counts as recorded — the finalizer runs with a `null` payload — which is the difference between "tear down with no extra detail" and "nothing to tear down."

> [!NOTE] Finalizers run on the engine host
> You can register a `finalizer` on a worker-mode engine — registration no longer throws — and the teardown always runs on the engine host, even when `activityExecution` is configured separately. But durable teardown only fires when the workflow staged state with `ctx.setFinalizerState`, and that call is unavailable inside a worker generator (there is no host-side API to stage it for you). So a worker-mode workflow that needs durable finalizer teardown must run in inline mode instead.

`ctx.onCancel` is inline-only for the same reason `ctx.setFinalizerState` is — both are workflow-context methods the worker generator runs without access to. A worker-mode workflow that needs best-effort in-process cleanup should do it in the workflow body instead (a `ctx.run` destroy step inside a `try/finally`).

Choosing between the three teardown tools: use a **`finalizer`** for a single external resource that must be released durably; use **`ctx.saga`** for a multi-step operation whose completed steps need ordered compensation if a later step fails; use **`ctx.onCancel`** for in-process, best-effort cleanup (releasing an in-memory lock, flushing a buffer) where durability is not required.

## Child workflows

Sometimes a workflow needs to kick off a sub-process that should be independently checkpointed—with its own workflow ID, its own state in storage, and its own lifecycle. That is what child workflows are for.

Use `yield* ctx.startChild()` to start a child workflow from within a parent. By default, the parent suspends at the `yield*` boundary until the child completes or fails.

```typescript partial
engine.register(
  workflow({ name: 'process-payment' }).execute(async function* (ctx, input: { amount: number }) {
    // ... payment logic ...
    return { receiptId: 'rcpt-123', amount: input.amount };
  }),
);

engine.register(
  workflow({ name: 'order' }).execute(async function* (
    ctx,
    input: { total: number; email: string },
  ) {
    const receipt = yield* ctx.startChild('process-payment', { amount: input.total });
    yield* ctx.run('sendConfirmation', { email: input.email, receipt });
    return { receipt, confirmed: true };
  }),
);
```

### Parent-close policies

`ctx.startChild()` accepts `parentClosePolicy` when the direct child workflow call should not wait for the child result.

| Policy             | Return value                    | Behavior                                                                                                                       |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `'await'`          | The child workflow result       | Default behavior. The parent waits for the child to finish.                                                                    |
| `'abandon'`        | `ChildWorkflowHandle` reference | Starts the child and returns `{ id }` immediately. The child is not linked to the parent's execution-state owner.              |
| `'request-cancel'` | `ChildWorkflowHandle` reference | Starts the child and returns `{ id }` immediately. Parent cancellation requests child cancellation in the same engine process. |

The returned `ChildWorkflowHandle` is a serializable reference, not the live `WorkflowHandle` object. Use the `id` outside the workflow body with `engine.getHandle(id)` when host code needs to inspect status, signal the child, or await the child result.

```typescript
import { Engine, workflow } from '@lostgradient/weft';

type PaymentReceipt = { receiptId: string; amount: number };

const engine = new Engine();

engine.register(
  workflow({ name: 'process-payment' }).execute(async function* (
    _ctx,
    input: { amount: number },
  ): AsyncGenerator<unknown, PaymentReceipt, unknown> {
    return { receiptId: 'rcpt-123', amount: input.amount };
  }),
);

engine.register(
  workflow({ name: 'order' }).execute(async function* (
    ctx,
    input: { total: number; email: string },
  ) {
    const child = yield* ctx.startChild<PaymentReceipt>(
      'process-payment',
      { amount: input.total },
      {
        parentClosePolicy: 'abandon',
      },
    );

    yield* ctx.run(async (record: { childWorkflowId: string; email: string }) => record, {
      childWorkflowId: child.id,
      email: input.email,
    });

    return { childWorkflowId: child.id };
  }),
);

void engine;
```

There is no forcible `terminate` policy. Child workflows that need cooperative shutdown should listen for cancellation through their normal workflow logic.

`ctx.pipe()`, `ctx.map()`, and `ctx.reduce()` are await-only by design: they collect child workflow results and therefore do not accept detached parent-close policies. Use direct `ctx.startChild()` calls when a workflow needs fire-and-forget child runs.

### Error handling

If a child workflow throws, the error propagates into the parent. You can catch it with a standard `try/catch` block.

```typescript partial
engine.register(
  workflow({ name: 'parent' }).execute(async function* (ctx, input) {
    try {
      yield* ctx.startChild('risky-child', input);
    } catch (error) {
      // Handle or compensate for the child failure
      yield* ctx.run('handleFailure', error);
    }
  }),
);
```

### Nesting depth limits

Child workflows can themselves start child workflows, creating a nesting hierarchy. To prevent runaway recursion, the engine enforces a maximum nesting depth. The default limit is 10 levels. You can configure it when creating the engine.

```typescript partial
const engine = new Engine({ maxNestingDepth: 5 });
```

When a child workflow would exceed the nesting limit, the engine throws an error into the parent workflow with a message indicating the depth exceeded the maximum.

## Forking Workflows

Use `engine.fork(sourceWorkflowId, options?)` to start a new workflow from an existing workflow checkpoint. The source workflow is unchanged. The fork receives a new workflow ID, copies the source checkpoint state and search attributes, records fork lineage, and launches with the same registered workflow type.

```typescript
import { Engine, workflow } from '@lostgradient/weft';

const engine = new Engine();
const registeredEngine = engine.register(
  workflow({ name: 'order' }).execute(async function* (ctx, input: { id: string }) {
    const saved = yield* ctx.run(async function saveOrder() {
      return { id: input.id };
    });
    return saved;
  }),
);

const original = await registeredEngine.start('order', { id: 'order-123' });
await original.result();

const forked = await registeredEngine.fork(original.id);
const forkedFromStepTwo = await registeredEngine.fork(original.id, { fromStep: 2 });

void forked;
void forkedFromStepTwo;
void engine;
```

By default, `fork()` uses the latest persisted checkpoint. Pass `fromStep` to fork from checkpoint history for a specific step. The engine must still have the source workflow type registered, and the requested checkpoint must still exist; otherwise `fork()` throws before creating the new workflow.
