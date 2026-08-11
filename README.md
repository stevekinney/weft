# Weft

A Bun-native durable execution engine. Current release: `0.18.0`.

Install the library from npm as `@lostgradient/weft`:

```bash
bun add @lostgradient/weft
```

The CLI binaries remain unscoped: package installs place `weft` and `weft-mcp` on `PATH`.

> _Weft_—the cross-threads in weaving that bind the warp together.

## The Problem

Imagine you're building an e-commerce checkout: charge the customer's credit card, reserve inventory, send a confirmation email, schedule shipping. What happens if your server crashes between step one and step two? The customer has been charged, but the inventory was never reserved. You can't just re-run the whole flow—you'd double-charge them.

**Durable execution** solves this. You write a normal-looking function around durable boundaries; with durable storage, Weft checkpoints those boundaries and automatically resumes persisted work after a process restart. The exact guarantee, including the current activity crash-window limit, is spelled out in [Durability Guarantee](documentation/architecture/durability-guarantee.md).

Temporal is the most prominent durable execution engine, built in 2019 with Go, gRPC, and Cassandra. It works. But we can do better with modern tools.

## What Is Weft?

Weft runs async workflows to completion across crashes, retries, and arbitrary stretches of wall-clock time. You write what looks like a normal generator function; the engine persists a checkpoint at every `yield*` boundary and resumes from the last checkpoint on recovery. No replay, no determinism constraints, no special imports.

It's built for two execution shapes that traditional workflow engines treat as second-class:

- **Long-running business processes**—checkouts, onboarding flows, fulfillment pipelines—where a process crash mid-flight must not lose money or leave the system in a partial state.

## Design Constraints

Weft is a ground-up rethink: what would durable execution look like if you designed it today, for today's workloads?

- **Web-native everywhere.** Every API comes from web standards: `fetch`, `WebSocket`, `Worker`, `BroadcastChannel`, `structuredClone`, `AbortController`, `crypto.randomUUID()`, `ReadableStream`. If the browser has it, we use it.
- **Bun-native on the server.** `Bun.serve()`, `Bun.SQL`, `Bun.build()`, `bun:test`. The full Bun platform, not just "Node.js but faster."
- **Single binary, every OS.** `bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. One CI pipeline, six binaries, zero runtime dependencies.
- **Runs in the browser.** The core engine (minus the server shell) runs in Web Workers with a Service Worker as its persistence backbone. Same workflow code, different environment.
- **Human-in-the-loop.** Workflows can pause at any checkpoint and surface a decision to a human reviewer via `ctx.review()`. The workflow resumes with the reviewer's decision—approved or rejected—without any special infrastructure.

> [!IMPORTANT]
> Workflows run in TypeScript on the engine; activities can run in any language via the `RemoteWorker` protocol. This split is intentional — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only by design. See [ADR 0001](documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md) for the design rationale.

## Stability Tiers

Weft is pre-1.0. The [breaking-change policy](documentation/contributing/breaking-changes.md#stability-tiers) owns the current candidate-stable and experimental surface inventory; feature guides state local context without maintaining a second list.

Candidate-stable surfaces are suitable for serious trials, but the 1.0 compatibility promise is not final until the Tier-0 work is complete. Surfaces not named in the canonical inventory are experimental by default.

The public path to 1.0 is tracked in the [roadmap to 1.0](documentation/roadmap-to-1.0.md). The 1.0 compatibility promise will apply to the stable tier only; experimental surfaces may continue changing until they graduate.

The browser surfaces graduate on a specific, mechanical criterion: the IndexedDB and WebExtension adapters and the Service Worker runtime stay experimental until their real-browser smoke tests are green in a **required** CI gate. The [browser-surface promotion gate](documentation/roadmap-to-1.0.md#browser-surface-promotion-gate) documents how the `browser-smoke` CI job flips from non-blocking to required, and why real-browser coverage — not fake-IndexedDB or stubbed-`chrome.storage` unit tests — is the evidence that moves them to stable.

## Durability Guarantee

Weft's durability promise is checkpoint-level and explicit:

- Every `yield*` boundary is persisted before the workflow advances to the next durable step.
- `Engine.create()` recovers by default after registering workflow definitions, so fresh processes resume persisted running workflows without a separate boot hook.
- Recovery resumes from the last checkpoint position instead of replaying the workflow from the beginning.
- External activity side effects still need idempotency keys, provider lookup, verifier logic, or external write fencing. Without that, a crash after the external side effect but before Weft commits the activity result can dispatch the activity again. Weft exposes `workflowExecutionToken` and per-attempt `activityAttemptToken` values so databases you control can reject stale writes from older attempts or replaced runs.

The full [Durability Guarantee](documentation/architecture/durability-guarantee.md) separates what is guaranteed today from the Tier-0 activity-reconciliation work that narrows the remaining crash window.

## Hello, World

The smallest useful Weft program has four moving pieces: a storage backend, a named activity, a named workflow, and a handle that waits for the result.

```typescript
import { Engine, workflow } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

type WelcomeInput = {
  name: string;
};

const welcome = workflow({ name: 'welcome' })
  .activities({
    formatGreeting: async ({ name }: WelcomeInput) => `Hello, ${name}!`,
  })
  .execute(async function* (ctx, input: WelcomeInput) {
    const greeting = yield* ctx.run('formatGreeting', input);
    yield* ctx.sleep('1s');
    return { greeting, onboarded: true };
  });

const engine = await Engine.create({
  storage: new SQLiteStorage('./weft.db'),
  workflows: { welcome },
});

const handle = await engine.start('welcome', { name: 'Steve' });
const result = await handle.result();
// result is { greeting: "Hello, Steve!", onboarded: true }
```

That's the core loop: `workflow({ name })` is a **chained builder** that co-locates the workflow's side-effecting steps inside `.activities({...})`, and `.execute(fn)` seals it all together and returns a `WorkflowDefinition`. Inside the generator, `ctx.run('formatGreeting', input)` autocompletes from the workflow's own activity table, typechecks the input, and infers the output. Every `yield*` is a checkpoint boundary; `handle.result()` waits for the output. Checkpoints are written to `./weft.db`, so running workflows survive process crashes.

`Engine.create()` does the registration dance for you: it constructs the engine and registers each workflow in the `workflows` map, pulling in all the activities each workflow declares. It then **recovers by default** — `engine.recoverAll()` runs after registration, so any workflows still running from a previous process pick up where they left off. That's the point of durable storage, so you don't have to ask for it. Pass `recover: false` to opt out (handy for tests, for `ScopedStorage`-isolated engines, or when you want to inspect a store before migrating it). Durability is separate: each step is persisted before it commits no matter what `recover` is set to — `recover` only decides whether _this_ engine resumes that persisted work on boot. If a host owns recovery but still needs durable timers, use `startScheduler: true`; otherwise `recover: false` also leaves the real-time scheduler stopped. Run a single engine per durable store; pointing two at the same store is not yet coordinated and can double-resume a workflow.

Passing an explicitly empty workflow map is the same default-registry boot shape as omitting `workflows`: `Engine.create({ workflows: {} })` recovers after registration and returns an engine whose TypeScript type is compatible with default-registry consumers such as `serve({ engine })`. Use a non-empty `workflows` map when you want TypeScript to narrow `engine.start(...)` to the registered names.

Serverless hosts that cannot keep process-local intervals alive can set `backgroundTasks: 'manual'` and call `await engine.runMaintenance()` from an alarm or Cron wake-up to drive timers, scheduled starts, update-response cleanup, retention, and alert evaluation. Await each maintenance cycle before starting another one so host-driven ticks do not overlap.

If you'd rather wire things up by hand — useful for tests, isolating engines onto separate storage scopes via `ScopedStorage`, or adding new workflows after the engine starts up — `new Engine({ storage })`, `engine.register(workflow)` or `engine.registerWorkflows({ ... })`, and `await engine.recoverAll()` are the underlying primitives. Each `engine.register(workflow)` call returns the engine with that workflow's name and types baked in, so `engine.start('welcome', ...)` autocompletes immediately.

When a workflow needs a live host capability that cannot be checkpointed, pass it as per-run `services`:

```typescript
const handle = await engine.start('welcome', { name: 'Steve' }, { services: { crmClient } });
```

Inside inline workflows, read that value from `ctx.services` and narrow it to your application type. Weft never writes the service object into checkpoints; it persists only a presence marker so `Engine.create({ resolveWorkflowServices })` can rebuild the service value during fresh-process recovery before the generator advances. Scheduled runs also carry `schedule.id` and, when the grid timestamp is retained, `schedule.occurrence` into the resolver across recovery, so host services can branch on schedule origin without duplicating that identity in workflow input. Do not use `services` for durable data, and do not pass it in Worker execution mode — non-serializable values cannot cross to a Worker.

When recovery also needs to rebuild live host surfaces such as progress emitters or adapters, opt out of automatic recovery first with `Engine.create({ recover: false, ... })`, then call `await engine.recoverAll({ onRecoveredWorkflow })` after any host surfaces are ready. Weft awaits the hook after services are re-provided and before the recovered generator advances, and a hook failure fails only that recovered run with a system failure category.

> [!NOTE]
> The chained builder also accepts `.signals({...})`, `.updates({...})`, `.queries({...})`, and `.searchAttributes({...})`. Each can be called at most once before `.execute(fn)`; the type system flips a phantom flag so a duplicate call fails to typecheck, and the runtime mirrors the same invariant. These maps don't introduce new runtime gating — they're type hints that thread into `ctx.run()`, `ctx.waitForSignal()`, `ctx.waitForUpdate()`, and friends so your editor autocompletes and your code typechecks. The underlying dispatch paths are unchanged.

> [!NOTE]
> `MemoryStorage` (also exported from `@lostgradient/weft`) is fine for tests and ephemeral scripts, but it lives in process memory—a crash takes the checkpoints with it. Use a persistent backend like `SQLiteStorage` whenever durability actually matters.

## How It Works

Weft uses a **checkpoint model**, not a replay model. At each `yield*`, the engine snapshots the workflow's current state, including live local variables and the generator position, then resumes from that snapshot after a crash. The checkpoint is the source of truth for "where am I and what do I know."

Because recovery never re-executes the workflow from the beginning, your workflow code does not inherit replay determinism rules. `Date.now()`, `Math.random()`, dynamic imports, and normal TypeScript control flow are all fine; side effects still belong in activities. The [Checkpoint vs. Replay architecture note](documentation/architecture/checkpoint-versus-replay.md) covers the full design and tradeoffs.

## Core Concepts

| Concept              | What it is                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**         | A generator function the engine drives to completion. Every `yield*` is a checkpoint.                                         |
| **Activity**         | A named unit of side-effecting work registered with the engine and dispatched by a workflow with `ctx.run(activity, input)`.  |
| **Checkpoint**       | A serialized snapshot of a workflow's position and local variables, written at every yield.                                   |
| **Signal**           | A fire-and-forget message sent _into_ a running workflow. Workflows pause at `ctx.waitForSignal()` until one arrives.         |
| **Update**           | A request-response message sent into a running workflow. The caller blocks until the workflow returns a result.               |
| **Query**            | A read-only request sent with `engine.query()` or `handle.query()` to inspect workflow state without mutating it.             |
| **Search attribute** | Indexed metadata on a workflow (customer ID, region, status) set via `ctx.setAttribute()` and queryable through the list API. |
| **Worker**           | A process or thread that executes activities. Inline by default; can run remote over WebSocket.                               |
| **Interceptor**      | A composable hook that wraps context operations for tracing, validation, encryption, or any cross-cutting concern.            |
| **Shared state**     | A compare-and-swap (CAS) durable mutable primitive for safe concurrent reads and writes across workflows.                     |
| **Idempotent start** | A stable `idempotencyKey` that makes retried starts return the existing run instead of creating duplicates.                   |

## Features

### Durable Workflows

Generator functions with automatic checkpointing at every `yield*` boundary. Activities, sleeps, signals, condition gates with `ctx.waitUntil()`, queries, updates, structured logs with `ctx.log`, parallel execution via `ctx.all()`, race semantics via `ctx.race()` and `ctx.raceKeyed()`, memoization via `ctx.memo()`, sagas via `ctx.saga()`, child workflows, and forks. Plain async helpers called from inline `ctx.memo()` callbacks can use `durableActivity()` for activity-level retry, heartbeat, reconciliation, and observability without converting the helper stack to generators. `ctx.sleep()` uses replay-stable durable timer keys, so a workflow that crashes while parked on a sleep resumes the same timer instead of orphaning the old one. Fired sleep timers are acknowledged only after the awakened inline workflow reaches its next durable checkpoint or terminal state, which lets Service Worker schedulers retry a timer instead of deleting the only wake-up record during an eviction window. `ctx.all()`, `ctx.race()`, and `ctx.raceKeyed()` can branch over activities, sleeps, and signal waits; use `ctx.race([ctx.waitForSignal(name), ctx.sleep(timeout)])` for signal timeouts instead of placing an unbounded signal wait directly in `ctx.all()`.

Use `ctx.raceKeyed()` when the workflow needs to know which branch won without encoding branch identity into the payload. The result is a discriminated `{ key, value }` pair, so checking `winner.key` narrows `winner.value`. For non-blocking signal drains, race a direct `ctx.waitForSignal(name)` branch against a literal `ctx.sleep(0)`: Weft checks the durable signal buffer first, consumes one already-buffered signal if present, and otherwise continues immediately. The stronger ordering is specific to zero-duration sleeps; positive timeouts keep ordinary race behavior.

Every workflow context exposes `ctx.workflowId` and `ctx.workflowType`. `workflowType` is the registered name from `workflow({ name })`, so shared workflow code can log, tag, or branch on the current workflow type without closing over definition-site state.

```typescript
const checkout = workflow({ name: 'checkout' })
  .activities({ chargeCard, reserveInventory, sendConfirmation, scheduleShipping })
  .execute(async function* (ctx, order: Order) {
    const charge = yield* ctx.run('chargeCard', { payment: order.payment });
    yield* ctx.run('reserveInventory', { items: order.items });

    const [confirmation, shipment] = yield* ctx.all([
      ctx.run('sendConfirmation', { email: order.email, receiptId: charge.receiptId }),
      ctx.run('scheduleShipping', { address: order.address }),
    ]);

    return { status: 'completed' as const, charge, confirmation, shipment };
  });
```

If `scheduleShipping` fails, `sendConfirmation`'s result is recorded in the parent operation's cache entry before the error is thrown into the workflow. If the workflow catches and yields again (e.g., to retry shipping or compensate), the next checkpoint persists that entry—a resumed run reuses the confirmation result instead of sending a duplicate email. See the [parallel execution guide](documentation/guides/parallel-execution.md) for the precise failure-semantics contract, including the catch-and-yield requirement.

### Durable Timers and Signals

Sleeps survive process restarts. Signals pause workflows for seconds, days, or weeks at no cost—the checkpoint just sits in storage.

```typescript
const approvalSignal = signal<{ approved: boolean }>('approval');

const approval = workflow({ name: 'approval' })
  .activities({ ship })
  .signals({ approval: approvalSignal })
  .execute(async function* (ctx, input: { orderId: string }) {
    const decision = yield* ctx.waitForSignal('approval');
    if (!decision.approved) {
      return { orderId: input.orderId, status: 'rejected' as const };
    }

    yield* ctx.sleep('24 hours');
    yield* ctx.run('ship', { orderId: input.orderId });
    return { orderId: input.orderId, status: 'shipped' as const };
  });

// From an HTTP handler, another workflow, or anywhere with engine access:
const handle = await engine.start('approval', { orderId: 'order-123' });
await engine.signal(handle.id, approvalSignal, { approved: true });
```

For state that changes through synchronous updates, use `ctx.waitUntil(predicate, timeout?)` as a durable condition gate. It re-checks a pure predicate when `ctx.onUpdate()` handlers mutate workflow-local state, or when the optional timeout fires. It is inline-only because the predicate closure stays in the engine process; signals do not re-drive it because signals are pull-based messages consumed by `ctx.waitForSignal()`.

```typescript partial
const quorum = workflow({ name: 'quorum' })
  .updates({
    vote: update<void, number>('vote'),
  })
  .execute(async function* (ctx) {
    let votes = 0;
    ctx.onUpdate('vote', () => {
      votes += 1;
      return votes;
    });

    const reached = yield* ctx.waitUntil(() => votes >= 3, '1h');
    return reached ? 'accepted' : 'expired';
  });
```

### Live Workflow Events

Workflow handles expose lifecycle events through `addEventListener`, and client handles can open a live tail for progress UIs or operators. `LocalClient` reads from the in-process engine stream; `HttpClient` defaults to the per-workflow `/v1/workflows/:id/watch` WebSocket channel when the runtime can carry authentication headers, and falls back to fetch-based SSE at `/v1/workflows/:id/events/sse` when it cannot. Both transports run history catch-up on connect and reconnect, so `addEventListener`, `client.tail(id)`, and `handle.tail()` are push-based rather than a polling loop. JSON-RPC clients can subscribe over WebSocket with `weft.workflows.subscribe` for one workflow or `weft.events.subscribe` for the fleet-wide event feed. Client code that receives a workflow id from another process can call `client.getHandle(id)` to re-attach a `ClientHandle` or get `null` when the run does not exist.

```typescript
const handle = await client.start('checkout', order);
const tail = handle.tail();

await tail.whenConnected();

for await (const event of tail) {
  console.log(event.type);
}
```

The tail is single-consumer and stops on terminal workflow events or `tail.close()`. Pass `eventTransport: 'websocket'` to require WebSocket, `eventTransport: 'sse'` to require SSE, or `HttpClientOptions.webSocketFactory` to provide a runtime-specific WebSocket constructor.

### Idempotent Starts and Signal-With-Start

Retried webhooks and queue deliveries should not double-start workflows. Pass a stable `idempotencyKey` to `engine.start()` to make every retry return a handle for the same run. Use `engine.startOrSignal()` when the first event should create the workflow and later events should signal the existing non-terminal run. The call returns `{ handle, outcome }`, where `outcome` is `'started'` for the caller that created the run and `'signalled'` for callers that delivered to, or converged onto, an existing run.

```typescript
const { handle, outcome } = await engine.startOrSignal(
  'approval',
  { orderId: 'order-123' },
  { name: 'payment', payload: { status: 'succeeded' } },
  { idempotencyKey: 'payment-webhook-order-123' },
);

console.log(handle.id, outcome); // outcome is 'started' or 'signalled'
```

The idempotency mapping intentionally outlives terminal cleanup. If retention removes the workflow record, the key is spent and future calls return a conflict instead of starting a replacement.

For stable-id re-sync flows, `engine.startOrSignal()` can replace a terminal prior run with `{ id, onTerminalConflict: 'start-new' }` when the initial signal also carries a deterministic `signalId`. Non-terminal runs are still signalled, not replaced, and restart-capable calls reject `idempotencyKey` because idempotency keys are permanent at-most-once mappings. Signal identifiers are treated as opaque user identifiers before storage-key construction, so caller-provided values that contain separator-looking text such as `anonymous:` stay explicit signal IDs instead of colliding with Weft's generated anonymous-signal sequence.

When a workflow drains signals with `ctx.race([ctx.waitForSignal(name), ctx.sleep(0)])` and then returns, use that stable `id`, a deterministic per-event `signalId`, and `onTerminalConflict: 'start-new'` for the corresponding `startOrSignal` calls. Delivery is serialized against terminal completion, so a signal arriving across the completion boundary is consumed by the current run or handed to its successor; a positive drain window is not needed for correctness.

### Search Attributes

Attach indexed metadata to a workflow at runtime, then list and filter on it.

```typescript
const order = workflow({ name: 'order' })
  .searchAttributes({
    customerId: { type: 'string' },
    status: { type: 'string' },
  })
  .execute(async function* (ctx, input: { customerId: string }) {
    ctx.setAttribute('customerId', input.customerId);
    ctx.setAttribute('status', 'processing');
    // ... work ...
    ctx.setAttribute('status', 'shipped');
  });

const orders = await engine.list({
  attributes: [
    { key: 'customerId', value: 'acme' },
    { key: 'status', value: 'shipped' },
  ],
});
```

Workflow visibility extends the same list surface with operator filters for `idPrefix`, failure categories, created/updated/deadline ranges, and status arrays. Use `engine.aggregate()` or `GET /api/v1/workflows/aggregate` for grouped counts by status, type, failure category, or a search attribute. Existing Bun SQLite deployments should run the [workflow visibility backfill](documentation/guides/workflow-visibility-backfill.md) before relying on the indexed fast path for older workflows.

Failure-category filters use the current execution taxonomy only: `application`, `timeout`, `cancellation`, `resource`, and `system`. Older category names from pre-1.0 experiments are dropped during decode and are not expanded in list or aggregate filters.

### Human-in-the-Loop Review

Weft can pause a workflow at any checkpoint and surface a decision payload to a human reviewer. The workflow resumes with the reviewer's decision—no polling, no special infrastructure.

As of June 12, 2026, [Temporal's public human-approval example](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python) models approval with Signals, and [Inngest's TypeScript docs](https://www.inngest.com/docs/reference/typescript/v4/functions/step-wait-for-event) model approval waits with `step.waitForEvent()`. Weft makes the review itself a durable workflow operation: [`ctx.review()`](src/core/context/durable-operations.ts) creates a stored review request, exposes review list/get/decision APIs, emits review events, and resumes the workflow with the submitted decision.

```typescript
import { Engine, workflow } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

type PaymentRequest = {
  orderId: string;
  amount: number;
  currency: string;
  customerId: string;
};

const paymentWorkflow = workflow({ name: 'payment' })
  .activities({
    chargeCard: async ({ orderId, amount, currency }: PaymentRequest) => {
      // Call your payment processor here.
      return { chargeId: `ch_${orderId}`, amount, currency };
    },
  })
  .execute(async function* (ctx, request: PaymentRequest) {
    // Pause and surface the payment details for human approval.
    const decision = yield* ctx.review({
      artifact: request,
      reviewType: 'payment-approval',
      reviewers: ['payments-team'],
      timeout: 72 * 60 * 60 * 1000,
    });

    if (decision.decision !== 'approved') {
      return { status: 'rejected' as const, orderId: request.orderId };
    }

    // Only runs after a human approves—checkpoint survives crashes.
    const charge = yield* ctx.run('chargeCard', request);
    return { status: 'charged' as const, charge };
  });
```

If the process crashes after the approval decision is checkpointed, the reviewer is not asked again. The `chargeCard` activity is still an at-least-once side effect: if the payment provider accepts the charge and the process crashes before Weft commits the activity result, recovery can run `chargeCard` again. Pass an idempotency key, provider transaction lookup, or equivalent verifier to the payment provider; the [activities guide](documentation/guides/activities.md#per-call-options) explains that boundary in more detail.

### Pluggable Storage

A small `Storage` interface over string keys and `Uint8Array` values: five required methods (`get`, `put`, `delete`, `scan`, `batch`) plus optional capabilities (`conditionalBatch`, `has`, `deletePrefix`) that adapters can implement when their backend supports them. Built-in adapters:

- **`MemoryStorage`** for development and tests
- **`SQLiteStorage`** (subpath `@lostgradient/weft/storage/sqlite`) for SQLite persistence; Bun resolves to `BunSQLiteStorage`, Node resolves to `NodeSQLiteStorage`
- **`BunSQLiteStorage`** (subpath `@lostgradient/weft/storage/sqlite/bun`) for an explicit Bun SQLite override
- **`NodeSQLiteStorage`** (subpath `@lostgradient/weft/storage/sqlite/node`) for an explicit Node.js SQLite override via `better-sqlite3`
- **`LMDBStorage`** (subpath `@lostgradient/weft/storage/lmdb`) for embedded high-throughput workloads
- **`TursoStorage`** (subpath `@lostgradient/weft/storage/turso`) for distributed libSQL deployments
- **`NeonStorage`** (subpath `@lostgradient/weft/storage/neon`) for durable remote Neon/Postgres deployments
- **`IndexedDBStorage`** (subpath `@lostgradient/weft/storage/indexeddb`) for browser environments
- **`WebExtensionStorage`** (subpath `@lostgradient/weft/storage/web-extension`) for extension contexts using `browser.storage` or `chrome.storage`
- **`HTTPStorage`** (subpath `@lostgradient/weft/storage/http`) for remote storage over Weft's HTTP storage routes
- **`CompressedStorage`** wrapper for transparent `gzip` or `brotli` compression

Bring your own backend by implementing the interface—five methods is enough.

For demos and local-first prototypes, `resolveDefaultStorage()` from `@lostgradient/weft/storage/auto` picks a durable default for the current runtime: SQLite under Bun or Node, `WebExtensionStorage` in extension contexts, and `IndexedDBStorage` in browsers and Service Workers. It deliberately throws instead of falling back to `MemoryStorage`, so a "default" engine does not silently lose checkpoints after a restart. Use `resolveStorage({ type: 'auto' })` only when an ephemeral fallback is acceptable.

Production recovery needs one engine process per durable store. Use a local durable adapter (`SQLiteStorage` or `LMDBStorage`) when the service owns its disk, or `NeonStorage` when the deployment wants managed Postgres durability and point-in-time restore. In either case, validate the store at boot with `assertDurableStorageForRecovery()` and enforce the singleton topology in infrastructure; the [singleton service deployment guide](documentation/guides/singleton-service-deployment.md) covers the checklist and the optional warn-only second-instance detector.

For long-running workflows, `history.retentionWindow` can compact old event-log records behind the latest checkpoint while preserving verification through a durable watermark. `history.maxEvents` remains a lifetime circuit breaker even after compaction. Use `payloadSize.maxBytes` when operators need an admission-time cap on workflow inputs, signal payloads, and activity results before those values reach storage.

### Server Mode

`serve()` wraps `Bun.serve()` to expose your engine over HTTP and WebSocket with a versioned REST API.

```typescript
import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

const engine = new Engine({ storage: new SQLiteStorage('./weft.db') });
engine.register(checkoutWorkflow);

await using server = serve({ engine, port: 7233 });
// server.url is e.g. "http://0.0.0.0:7233"
```

Endpoints under `/api/v1/` cover the full lifecycle: start workflows, list, signal, update, query, cancel, fork, and stream events. JSON-RPC over WebSocket also exposes workflow and fleet event subscriptions for operator UIs that need live state without polling. Content negotiation supports JSON and MessagePack. The server can also mount an externally supplied dashboard shell at known page routes; see the [server guide](documentation/guides/server.md#external-dashboard-mounting) for the hosting contract.

### Remote Workers

Workers can connect to the server over WebSocket, pull tasks, execute activities, and report results back. The same activity code runs inline in development and remote in production—no API changes.

```typescript
import { RemoteWorker } from '@lostgradient/weft';

const worker = new RemoteWorker({
  serverUrl: 'wss://weft.internal:7233',
  workflows: {
    orderFulfillment: {
      name: 'orderFulfillment',
      activities: { chargeCard, reserveInventory, sendConfirmation },
    },
  },
});

await worker.connect();
```

### Browser Support

The core engine runs inside a Web Worker, with a Service Worker acting as the durable persistence layer over `IndexedDB`. Browser-compatible workflow logic ships across server and browser without modification—useful for offline-first apps that need durable client-side workflows. Activities, storage adapters, and other environment-bound pieces still need browser-safe implementations: use `IndexedDBStorage`, `WebExtensionStorage`, or `resolveDefaultStorage()` instead of SQLite storage, swap server-only activities for `fetch`-based equivalents, and so on.

Service Worker deployments can import `ServiceWorkerScheduler` from `@lostgradient/weft/service-worker` and wire timer wakeups through `onTimerFired: (entry) => engine.fireTimer(entry)`. See the [Service Worker guide](documentation/guides/service-worker.md) for the browser runtime wiring and Periodic Background Sync fallback pattern.

### Observability

Built-in event system (`EventTarget`-based, so it composes with everything), W3C `traceparent` propagation, and OpenTelemetry-compatible metrics. Composable interceptors layer cross-cutting concerns—tracing, validation, encryption—without any of them knowing about each other.

Schedules also emit `schedule:fired` on the live engine each time a schedule actually launches a workflow run. The event carries `scheduleId`, `workflowId`, `firedAt`, and the scheduled `occurrence` when one is retained, so in-process dispatchers can react to cadence without polling schedule state.

```typescript
import { createObservabilityInterceptors, createOpenTelemetryMetrics } from '@lostgradient/weft';

const metrics = createOpenTelemetryMetrics({
  /* your meter provider */
});
const interceptors = createObservabilityInterceptors({ metrics });

const engine = new Engine({
  storage,
  interceptors: [interceptors.interceptor],
});
```

Inside workflow code, `ctx.log` emits structured console records with `workflowId`, `workflowType`, `level`, and `timestamp` attached. Caller attributes are nested under `attributes`, so they cannot overwrite the envelope. Logs at already-restored checkpoint positions are suppressed on recovery; logs at the live frontier still emit, and in worker mode the destination is the worker process console.

### Testing

`TestEngine` swaps the production engine in tests and gives you a virtual clock. `engine.advanceTime('1 hour')` jumps timers forward without waiting; `engine.mock(activity, fake)` swaps in fake activity implementations with type-checked signatures, call recording, and per-call overrides.

```typescript
import { TestEngine } from '@lostgradient/weft/testing';
import { expect, test } from 'bun:test';

test('onboarding completes after a day', async () => {
  const engine = new TestEngine();
  engine.register(onboardingWorkflow);

  const sendEmail = engine.mock(actualSendEmail, () => ({
    messageId: 'msg_test_1',
  }));

  const handle = await engine.start('onboarding', { name: 'Steve' });
  await engine.advanceTime('1 day');

  expect(await handle.result()).toEqual({ status: 'onboarded' });
  expect(sendEmail.callCount).toBe(2);
});
```

For chaos testing, `withChaos()` wraps activities with configurable transient failures, timeouts, and non-retryable errors so you can prove your retry policies actually work.

### Single-Binary Distribution

`bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. The engine, server, and your workflow code embed into a single file with zero runtime dependencies—download, run, done.

### Error Handling

Every error Weft throws extends `WeftError`, so a single `instanceof` check catches them all, and each carries a stable string `code` equal to its class name:

```typescript
import { isWeftError } from '@lostgradient/weft';

try {
  await engine.start('checkout', { orderId: 'order-1' }, { id: 'order-1' });
} catch (error) {
  if (!isWeftError(error)) throw error; // not ours — rethrow

  switch (error.code) {
    case 'WorkflowAlreadyExistsError':
      // idempotent retry — already running
      break;
    case 'WorkflowNotRegisteredError':
      throw error; // a programming error, not a runtime condition
    default:
      console.error(`[${error.code}] ${error.message}`);
  }
}
```

`isWeftError` is an `instanceof` check — the right tool in the common case where the error came from the same module instance. If an error can reach you across a realm or a duplicate module load (multiple copies of `@lostgradient/weft` in one process), `instanceof` is unreliable; use `isWeftErrorLike` to narrow the caught value structurally:

```typescript
import { isWeftErrorLike } from '@lostgradient/weft';

function isAlreadyRunning(error: unknown): boolean {
  return isWeftErrorLike(error) && error.code === 'WorkflowAlreadyExistsError';
}
```

When the same producer might run through either `LocalClient` or `HttpClient`, use `isWeftFault(error, code)` for a specific branch. It matches same-process `WeftError` instances and HTTP-wrapped errors whose REST response carried the originating public `weftCode`.

```typescript
import { isWeftFault } from '@lostgradient/weft';

function isMissingWorkflow(error: unknown): boolean {
  return isWeftFault(error, 'WorkflowNotFoundError');
}
```

The exported `WeftErrorCode` union lists every code that belongs to a public, exported error class; those codes are stable contract and safe to `switch` on exhaustively. Errors that are internal to Weft also extend `WeftError` but carry codes intentionally left out of `WeftErrorCode` — `isWeftErrorCode` and `isWeftErrorLike` return `false` for them — so internal codes may change between releases without breaking your types.

## Installation

```bash
bun add @lostgradient/weft
```

Storage backends and adapters are exported under subpaths so they only load when imported:

```typescript
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';
import { LMDBStorage } from '@lostgradient/weft/storage/lmdb';
import { TursoStorage } from '@lostgradient/weft/storage/turso';
import { NeonStorage } from '@lostgradient/weft/storage/neon';
import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';
import { WebExtensionStorage } from '@lostgradient/weft/storage/web-extension';
import { HTTPStorage } from '@lostgradient/weft/storage/http';
```

The `bun` runtime version `1.3.13` or later is required.

## Step API for `async`/`await` Users

If generator syntax is unfamiliar, the same workflow can be written with `ctx.step()` calls and plain `async`/`await`:

```typescript partial
const welcome = workflow({ name: 'welcome' }).execute(
  compileStepWorkflow(async (ctx: StepWorkflowContext, input: { name: string }) => {
    const greeting = await ctx.step('greet', () => greet(input.name));
    await ctx.step('notify', () => notify(greeting));
    return { greeting, notified: true };
  }),
);

engine.register(welcome);
```

Each `ctx.step()` is a checkpoint boundary. Completed steps replay from storage after crash recovery instead of re-running, and `compileStepWorkflow(...)` compiles the step-style function into the generator form the engine runs internally. Await each step before starting the next. When you need durable timers, signals, parallel execution, or worker-mode isolation, switch to the generator API.

## Weft vs. Temporal

| Concept                | Temporal                                                                                                                       | Weft                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Core mental model      | Replay determinism                                                                                                             | Generators pause and resume                                                                        |
| Workflow language      | Go, Java, TypeScript, Python, .NET, Ruby, PHP                                                                                  | TypeScript only (activities can be any language via `RemoteWorker`)                                |
| Activity invocation    | `proxyActivities()` + type import                                                                                              | `yield* ctx.run('activityName', input)` (declared in `.activities({...})`)                         |
| Timer                  | Deterministic `workflow.sleep()`                                                                                               | `yield* ctx.sleep("1 hour")`                                                                       |
| Signal                 | `setHandler` + `condition`                                                                                                     | `yield* ctx.waitForSignal(name)`                                                                   |
| Human review           | Signals/queries/updates as [message-passing primitives](https://docs.temporal.io/develop/typescript/workflows/message-passing) | `yield* ctx.review(...)` with [durable review request](src/core/review/index.ts) and decision APIs |
| Versioning             | `patched()` / `deprecatePatch()`                                                                                               | Stored and registered versions are strict recovery guards                                          |
| Long-running workflows | `continueAsNew()`                                                                                                              | None needed (checkpoint size is bounded by live state, not history length)                         |
| Dev environment        | Docker Compose + Temporal server                                                                                               | `bun add @lostgradient/weft`                                                                       |
| Bundling               | Webpack for workflow sandbox                                                                                                   | None                                                                                               |

> Weft is for teams whose primary backend language is TypeScript. If you need workflows in multiple languages, [Temporal](https://temporal.io) is the right answer. For the design rationale, see [ADR 0001 — Workflows Are TypeScript-Only by Design](documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md).
>
> Weft's server runtime is Bun-only for this launch line. If you need the workflow server itself to run as a Node-native process, evaluate [Temporal](https://temporal.io).

## Documentation

Getting started:

- [Installation](documentation/getting-started/installation.md)
- [Hello World](documentation/getting-started/hello-world.md)
- [Transports](documentation/getting-started/transports.md)

Guides:

- [Workflows](documentation/guides/workflows.md), [Activities](documentation/guides/activities.md), [Storage](documentation/guides/storage.md), [Server](documentation/guides/server.md)
- [Signals and Queries](documentation/guides/signals-and-queries.md), [Synchronous Updates](documentation/guides/synchronous-updates.md)
- [Durable Timers](documentation/guides/durable-timers.md), [Timeouts](documentation/guides/timeouts.md), [Parallel Execution](documentation/guides/parallel-execution.md)
- [Search Attributes](documentation/guides/search-attributes.md), [Workflow Visibility Backfill](documentation/guides/workflow-visibility-backfill.md), [State](documentation/guides/state.md), [Session State](documentation/guides/session-state.md), [Events](documentation/guides/events.md)
- [Interceptors](documentation/guides/interceptors.md), [Observability](documentation/guides/observability.md), [Testing](documentation/guides/testing.md)
- [Workflow Versioning](documentation/guides/workflow-versioning.md), [Remote Workers](documentation/guides/remote-workers.md), [Service Worker](documentation/guides/service-worker.md), [Resource Management](documentation/guides/resource-management.md), [Concurrency: Mutex and Semaphore](documentation/guides/concurrency.md)

Architecture and reference:

- [Design Philosophy](documentation/architecture/design-philosophy.md), [Durability Guarantee](documentation/architecture/durability-guarantee.md), [Checkpoint vs. Replay](documentation/architecture/checkpoint-versus-replay.md), [Web Standards](documentation/architecture/web-standards.md)
- [Temporal Comparison](documentation/architecture/temporal-comparison.md), [Inngest Comparison](documentation/architecture/inngest-comparison.md), [Browser Runtime](documentation/architecture/browser-runtime.md), [Web Workers](documentation/architecture/web-workers.md), [Single Binary](documentation/architecture/single-binary.md)
- [API Reference](documentation/reference/) (Engine, Context, Storage, Server, Workers, Testing, Events, Errors, Interceptors, Observability, CLI, Configuration, Types)

Contributing:

- [Development Setup](documentation/contributing/development-setup.md), [Documentation Maintenance](documentation/contributing/documentation-maintenance.md), [Subprocess Durability Tests](documentation/contributing/subprocess-durability-tests.md), [Architecture Decisions](documentation/contributing/architecture-decisions.md)

## License

MIT
