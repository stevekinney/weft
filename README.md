# Weft

A Bun-native durable execution engine. Current launch version: `0.2.0`.

> _Weft_—the cross-threads in weaving that bind the warp together.

## The Problem

Imagine you're building an e-commerce checkout: charge the customer's credit card, reserve inventory, send a confirmation email, schedule shipping. What happens if your server crashes between step one and step two? The customer has been charged, but the inventory was never reserved. You can't just re-run the whole flow—you'd double-charge them.

**Durable execution** solves this. You write a normal-looking function and the runtime guarantees it will complete—even if the process crashes and restarts a hundred times along the way. Each step is checkpointed so recovery picks up exactly where it stopped.

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

Weft is launching as `0.2.0`, not `1.0`. The table below is the current adoption guidance, not a permanent compatibility guarantee. Surfaces marked **candidate-stable** are expected to carry the 1.0 support promise if the [Tier-0 Behavioral Contract](documentation/architecture/tier-0-behavioral-contract.md) does not force a public-shape change. Tier-0 work may still add error codes, duplicate-response shapes, or storage-capability failures before those surfaces graduate.

| Tier                          | Surfaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What to expect                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Candidate-stable, provisional | Engine core, [`TestEngine`](documentation/guides/testing.md), Bun SQLite, Node SQLite, LMDB, [`RemoteWorker`](documentation/guides/remote-workers.md), [`serve()`](documentation/guides/server.md) and `/v1` REST, exported public error codes                                                                                                                                                                                                                                       | Suitable for serious trials. Pin the package version and read release notes before upgrading until the 1.0 contract lands. |
| Experimental                  | [Browser runtime](documentation/guides/service-worker.md), [MCP](documentation/reference/api-server.md#mcp-server), IndexedDB, WebExtension, HTTP and compressed storage, Turso pending conformance proof, CLI commands beyond `serve` and `doctor` when running Weft from source or a standalone binary, [OpenTelemetry](documentation/guides/observability.md) metric names, dashboard, [`ctx.step()`](documentation/guides/workflows.md#getting-started-without-generators) sugar | API shape, storage guarantees, diagnostics, or compatibility behavior may change without a deprecation window before 1.0.  |

If a surface is not named here, treat it as experimental. Stability is about compatibility and operational guarantees; it is not a statement that every candidate-stable surface is appropriate for every deployment.

The public path to 1.0 is tracked in the [roadmap to 1.0](documentation/roadmap-to-1.0.md). The 1.0 compatibility promise will apply to the stable tier only; experimental surfaces may continue changing until they graduate.

The browser surfaces graduate on a specific, mechanical criterion: the IndexedDB and WebExtension adapters and the Service Worker runtime stay experimental until their real-browser smoke tests are green in a **required** CI gate. The [browser-surface promotion gate](documentation/roadmap-to-1.0.md#browser-surface-promotion-gate) documents how the `browser-smoke` CI job flips from non-blocking to required, and why real-browser coverage — not fake-IndexedDB or stubbed-`chrome.storage` unit tests — is the evidence that moves them to stable.

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

`Engine.create()` does the registration dance for you: it constructs the engine and registers each workflow in the `workflows` map, pulling in all the activities each workflow declares. It then **recovers by default** — `engine.recoverAll()` runs after registration, so any workflows still running from a previous process pick up where they left off. That's the point of durable storage, so you don't have to ask for it. Pass `recover: false` to opt out (handy for tests, for `ScopedStorage`-isolated engines, or when you want to inspect a store before migrating it). Durability is separate: each step is persisted before it commits no matter what `recover` is set to — `recover` only decides whether _this_ engine resumes that persisted work on boot. Run a single engine per durable store; pointing two at the same store is not yet coordinated and can double-resume a workflow.

If you'd rather wire things up by hand — useful for tests, isolating engines onto separate storage scopes via `ScopedStorage`, or adding new workflows after the engine starts up — `new Engine({ storage })`, `engine.register(workflow)` or `engine.registerWorkflows({ ... })`, and `await engine.recoverAll()` are the underlying primitives. Each `engine.register(workflow)` call returns the engine with that workflow's name and types baked in, so `engine.start('welcome', ...)` autocompletes immediately.

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
| **Query**            | A read-only peek at a running workflow's state. Never mutates anything.                                                       |
| **Search attribute** | Indexed metadata on a workflow (customer ID, region, status) set via `ctx.setAttribute()` and queryable through the list API. |
| **Worker**           | A process or thread that executes activities. Inline by default; can run remote over WebSocket.                               |
| **Interceptor**      | A composable hook that wraps context operations for tracing, validation, encryption, or any cross-cutting concern.            |
| **Shared state**     | A compare-and-swap (CAS) durable mutable primitive for safe concurrent reads and writes across workflows.                     |

## Features

### Durable Workflows

Generator functions with automatic checkpointing at every `yield*` boundary. Activities, sleeps, signals, queries, updates, parallel execution via `ctx.all()`, race semantics via `ctx.race()`, memoization via `ctx.memo()`, sagas via `ctx.saga()`, child workflows, and forks.

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

### Live Workflow Events

Workflow handles expose lifecycle events through `addEventListener`, and client handles can open a live tail for progress UIs or operators. `LocalClient` reads from the in-process engine stream; `HttpClient` uses the per-workflow `/v1/workflows/:id/watch` WebSocket channel with history catch-up on connect and reconnect, so `addEventListener`, `client.tail(id)`, and `handle.tail()` are push-based rather than a polling loop.

```typescript
const handle = await client.start('checkout', order);
const tail = handle.tail();

await tail.whenConnected();

for await (const event of tail) {
  console.log(event.type);
}
```

The tail is single-consumer and stops on terminal workflow events or `tail.close()`. In runtimes without a built-in WebSocket, or where authenticated WebSockets need headers the platform constructor cannot send, provide `HttpClientOptions.webSocketFactory`.

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

### Human-in-the-Loop Review

Weft can pause a workflow at any checkpoint and surface a decision payload to a human reviewer. The workflow resumes with the reviewer's decision—no polling, no special infrastructure.

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

If the process crashes between the approval decision arriving and `chargeCard` executing, the engine resumes from the last checkpoint—the charge runs exactly once. The reviewer's decision is persisted as part of the checkpoint; there is no resubmission.

### Pluggable Storage

A small `Storage` interface over string keys and `Uint8Array` values: five required methods (`get`, `put`, `delete`, `scan`, `batch`) plus optional capabilities (`conditionalBatch`, `has`, `deletePrefix`) that adapters can implement when their backend supports them. Built-in adapters:

- **`MemoryStorage`** for development and tests
- **`SQLiteStorage`** (subpath `@lostgradient/weft/storage/sqlite`) for SQLite persistence; Bun resolves to `BunSQLiteStorage`, Node resolves to `NodeSQLiteStorage`
- **`BunSQLiteStorage`** (subpath `@lostgradient/weft/storage/sqlite/bun`) for an explicit Bun SQLite override
- **`NodeSQLiteStorage`** (subpath `@lostgradient/weft/storage/sqlite/node`) for an explicit Node.js SQLite override via `better-sqlite3`
- **`LMDBStorage`** (subpath `@lostgradient/weft/storage/lmdb`) for embedded high-throughput workloads
- **`TursoStorage`** (subpath `@lostgradient/weft/storage/turso`) for distributed libSQL deployments
- **`IndexedDBStorage`** (subpath `@lostgradient/weft/storage/indexeddb`) for browser environments
- **`WebExtensionStorage`** (subpath `@lostgradient/weft/storage/web-extension`) for extension contexts using `browser.storage` or `chrome.storage`
- **`HTTPStorage`** (subpath `@lostgradient/weft/storage/http`) for remote storage over Weft's HTTP storage routes
- **`CompressedStorage`** wrapper for transparent `gzip` or `brotli` compression

Bring your own backend by implementing the interface—five methods is enough.

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

Endpoints under `/api/v1/` cover the full lifecycle: start workflows, list, signal, update, query, cancel, fork, and stream events. Content negotiation supports JSON and MessagePack. The server can also serve the built-in dashboard at `/`; see the [server guide](documentation/guides/server.md#dashboard) for how to enable it, lock it down, and disable it.

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

await worker.start();
```

### Browser Support

The core engine runs inside a Web Worker, with a Service Worker acting as the durable persistence layer over `IndexedDB`. Browser-compatible workflow logic ships across server and browser without modification—useful for offline-first apps that need durable client-side workflows. Activities, storage adapters, and other environment-bound pieces still need browser-safe implementations: use `IndexedDBStorage` or `WebExtensionStorage` instead of SQLite storage, swap server-only activities for `fetch`-based equivalents, and so on. See the [Service Worker guide](documentation/guides/service-worker.md) for the browser runtime wiring.

### Observability

Built-in event system (`EventTarget`-based, so it composes with everything), W3C `traceparent` propagation, and OpenTelemetry-compatible metrics. Composable interceptors layer cross-cutting concerns—tracing, validation, encryption—without any of them knowing about each other.

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

`bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. The engine, server, dashboard, and your workflow code embed into a single file with zero runtime dependencies—download, run, done.

### Error Handling

Every error Weft throws extends `WeftError`, so a single `instanceof` check catches them all, and each carries a stable string `code` equal to its class name:

```typescript
import { isWeftError, isWeftErrorCode } from '@lostgradient/weft';

try {
  await engine.start('checkout', { orderId: 'order-1' }, { id: 'order-1' });
} catch (error) {
  if (!isWeftError(error)) throw error; // not ours — rethrow

  if (isWeftErrorCode(error.code)) {
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
}
```

`isWeftError` is an `instanceof` check — the right tool in the common case where the error came from the same module instance. If an error can reach you across a realm or a duplicate module load (multiple copies of `@lostgradient/weft` in one process), `instanceof` is unreliable; skip `isWeftError` and branch on `error.code` directly, since the string `code` survives those boundaries:

```typescript
import { isWeftErrorCode } from '@lostgradient/weft';

function isAlreadyRunning(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return isWeftErrorCode(code) && code === 'WorkflowAlreadyExistsError';
}
```

The exported `WeftErrorCode` union lists every code that belongs to a public, exported error class; those codes are stable contract and safe to `switch` on exhaustively. Errors that are internal to Weft also extend `WeftError` but carry codes intentionally left out of `WeftErrorCode` — `isWeftErrorCode` returns `false` for them — so internal codes may change between releases without breaking your types.

## Installation

```bash
bun add @lostgradient/weft
```

Storage backends and adapters are exported under subpaths so they only load when imported:

```typescript
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';
import { LMDBStorage } from '@lostgradient/weft/storage/lmdb';
import { TursoStorage } from '@lostgradient/weft/storage/turso';
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

Each `ctx.step()` is a checkpoint boundary. The engine compiles step-style workflows to generator form at registration time. When you need durable timers, signals, or parallel execution, switch to the generator API.

## Weft vs. Temporal

| Concept                | Temporal                                      | Weft                                                                       |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| Core mental model      | Replay determinism                            | Generators pause and resume                                                |
| Workflow language      | Go, Java, TypeScript, Python, .NET, Ruby, PHP | TypeScript only (activities can be any language via `RemoteWorker`)        |
| Activity invocation    | `proxyActivities()` + type import             | `yield* ctx.run('activityName', input)` (declared in `.activities({...})`) |
| Timer                  | Deterministic `workflow.sleep()`              | `yield* ctx.sleep("1 hour")`                                               |
| Signal                 | `setHandler` + `condition`                    | `yield* ctx.waitForSignal(name)`                                           |
| Versioning             | `patched()` / `deprecatePatch()`              | Deploy new code (migration optional)                                       |
| Long-running workflows | `continueAsNew()`                             | None needed (checkpoint size is bounded by live state, not history length) |
| Dev environment        | Docker Compose + Temporal server              | `bun add @lostgradient/weft`                                               |
| Bundling               | Webpack for workflow sandbox                  | None                                                                       |

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

- [Design Philosophy](documentation/architecture/design-philosophy.md), [Checkpoint vs. Replay](documentation/architecture/checkpoint-versus-replay.md), [Web Standards](documentation/architecture/web-standards.md)
- [Browser Runtime](documentation/architecture/browser-runtime.md), [Web Workers](documentation/architecture/web-workers.md), [Single Binary](documentation/architecture/single-binary.md)
- [API Reference](documentation/reference/) (Engine, Context, Storage, Server, Workers, Testing, Events, Interceptors, Observability, CLI, Configuration, Types)

Contributing:

- [Development Setup](documentation/contributing/development-setup.md), [Documentation Maintenance](documentation/contributing/documentation-maintenance.md), [Subprocess Durability Tests](documentation/contributing/subprocess-durability-tests.md), [Architecture Decisions](documentation/contributing/architecture-decisions.md)

## License

MIT
