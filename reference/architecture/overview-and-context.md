# Weft: A Bun-Native Durable Execution Engine

> _Weft_ — the cross-threads in weaving that bind the warp together.

> [!NOTE]
> Weft's built-in agent surface — `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()`, and the agent types, events, and runtime that backed them — was removed in v0.1.0. Weft does not ship an agent primitive. Build durable agent loops on `ctx.run()` and `ctx.review()`, or run them in an external agent framework. See the [`CHANGELOG`](../../CHANGELOG.md) for the full removed-export list and migration path.

---

Long-form research now lives in [./research.md](./research.md). This document keeps the overview, problem framing, and architectural context that feed the checklist-first roadmap in [../architecture.md](../architecture.md).

## Before We Start: What Problem Are We Solving?

Imagine you're building an e-commerce checkout:

1. Charge the customer's credit card
2. Reserve inventory in the warehouse
3. Send a confirmation email
4. Schedule shipping

**What happens if your server crashes between step 1 and step 2?** The customer has been charged, but the inventory was never reserved. You can't just re-run the whole flow — you'd double-charge them.

**Durable execution** solves this: you write a normal-looking function and the runtime guarantees it will complete — even if the process crashes and restarts a hundred times along the way. Each step is checkpointed so recovery picks up exactly where it stopped.

**Temporal** is the most prominent durable execution engine (created by the engineers who built Uber's Cadence). It works, but it was designed in 2019 with Go + gRPC + Cassandra. We can do better with modern tools.

---

## The Thesis

Weft is a ground-up rethink: **What would durable execution look like if you designed it today, for today's workloads, with today's primitives?**

The design constraints, in priority order:

1. **Web-native everywhere.** Every API, primitive, and communication pattern should come from web standards: `fetch`, `WebSocket`, `Worker`, `BroadcastChannel`, `structuredClone`, `AbortController`, `crypto.randomUUID()`, `ReadableStream`. If the browser has it, we use it.

2. **Bun-native on the server.** `Bun.serve()`, `Bun.SQL`, `Bun.build()`, `bun:test`. The full Bun platform, not just "Node.js but faster."

3. **Single binary, every OS.** `bun build --compile` produces standalone executables for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, and `windows-x64`. One CI pipeline, six binaries, zero runtime dependencies for end users.

4. **Runs in the browser.** The core engine (minus the server shell) runs in Web Workers and can use a Service Worker as its persistence and scheduling backbone. Same workflow code, different execution environment.

5. **Library/server parity.** Every capability exposed by the server's HTTP and WebSocket API is also available through the library's in-process `Engine` API — and vice versa. A developer who starts with `bun add weft` and later moves to the standalone server (or the reverse) should not lose features or change workflow code. The server is a deployment wrapper around the engine, not a superset of it. Track 8 extends that parity model with shared REST/OpenAPI and JSON-RPC/OpenRPC contracts generated from one runtime operation catalog, but those transports remain adapters over the same `Engine`, `EventTarget`, `BroadcastChannel`, and Worker messaging primitives rather than a separate system.

---

## Why Not Temporal: Ten Design Failures Weft Eliminates

Temporal's replay-based architecture creates a cascade of constraints — determinism, versioning, history limits, sandbox, payload sensitivity — that manifest as developer experience pain. These are not bugs to fix; they are architectural consequences. Weft's checkpoint-based architecture eliminates the root cause, which means all the downstream constraints dissolve simultaneously.

Here is what a developer must learn to write their first workflow:

| Concept                | Temporal                          | Weft                                 |
| ---------------------- | --------------------------------- | ------------------------------------ |
| Core mental model      | Replay determinism                | Generators pause and resume          |
| Activity invocation    | `proxyActivities()` + type import | `yield* ctx.run(fn, args)`           |
| Timer                  | Deterministic `workflow.sleep()`  | `yield* ctx.sleep("1 hour")`         |
| Signal                 | `setHandler` + `condition`        | `yield* ctx.waitForSignal(name)`     |
| Versioning             | `patched()` / `deprecatePatch()`  | Deploy new code (migration optional) |
| Long-running workflows | `continueAsNew()`                 | Nothing (checkpoints are fixed-size) |
| Dev environment        | Docker Compose + Temporal server  | `bun add weft`                       |
| Bundling               | Webpack for workflow sandbox      | None                                 |

### 1. The Determinism Constraint Is a Developer Experience Nightmare

**The Temporal problem.** Temporal's TypeScript SDK removes `WeakRef` and `FinalizationRegistry` from the sandbox, replaces `Date.now()` and `Math.random()` with deterministic versions, and runs workflows through Webpack bundling that cannot reference Node.js or DOM APIs. Developers write normal-looking code, it works in tests, and then it explodes with `DeterminismViolationError` in production during replay. The error messages are often inscrutable ("Activity machine does not handle this event").

**The Weft answer.** Checkpoint, don't replay. No determinism requirement at all. Use `Date.now()`, `WeakRef`, `FinalizationRegistry`, `Math.random()` — anything. The only rule is `yield*` for durable operations. (See: [Checkpoint, Don't Replay](./platform-foundations.md#1-checkpoint-dont-replay).)

Weft actually _uses_ `WeakRef` and `FinalizationRegistry` internally for memory management. The primitives Temporal bans are the ones Weft depends on. This is not "we allow them" — it is "we need them."

**Going further: development mode serialization validation.** The most common class of bugs Weft developers will hit is accidentally putting a non-cloneable value (a closure, a class instance with methods, a `WeakRef`) into their checkpoint state. In Temporal, you discover this at replay time in production. In Weft, a development mode catches it immediately:

```typescript
const engine = new Engine({
  storage: new MemoryStorage(),
  development: true,
});
```

When `development: true`, the engine serializes and deserializes the checkpoint at each boundary and compares the result. If they diverge, it emits a `DevelopmentWarningEvent` with the exact field paths that diverged, the values on each side, and a suggestion for how to fix it. The error message looks like this:

```
CheckpointSerializationError: Cannot serialize workflow state at step 2

  The value at path "locals.apiClient" is a class instance with methods.
  structuredClone cannot serialize functions or class instances.

  Value: ApiClient { baseUrl: "https://api.stripe.com", ... }

  Fix: Move the ApiClient creation inside ctx.run() or store only the
  configuration data (e.g., { baseUrl: "https://api.stripe.com" }) in
  local variables and reconstruct the client when needed.

  at orderWorkflow (./workflows/order.ts:15:3)
```

**Going further: stack-trace-preserving errors.** Every context method (`ctx.run`, `ctx.sleep`, `ctx.review`) captures the caller's stack trace at call time — before the generator yields. When an activity fails after being dispatched to a remote worker and retried three times, the error shown to the developer includes the original call site in their workflow code:

```
ActivityFailedError: charge failed after 3 attempts
  Last attempt: PaymentDeclinedError: Card ending 4242 declined
    at charge (./activities/payments.ts:42:5)
  Dispatched from:
    at orderWorkflow (./workflows/order.ts:12:28)
  Activity: charge | Operation: op-abc123 | Attempts: 3/3
  Retry policy: { initialBackoff: "1s", multiplier: 2, maxBackoff: "30s" }
```

### 2. Versioning Is Painfully Complex

**The Temporal problem.** Changing workflow code while workflows are in-flight requires either the `patched()` / `deprecatePatch()` API — which litters your code with version branches that never go away — or Worker Versioning, a whole deployment orchestration system. The Temporal docs themselves acknowledge this is complex enough that they deprecated their first versioning approach and replaced it in 2025. Developers routinely report confusion about which changes are safe versus which break replay.

**The Weft answer.** Checkpointing means code before the current checkpoint never re-executes. Changing steps after the current checkpoint is inherently safe. Versioning only matters for the step you are currently on — and even then, the migration path is a pure data transformation on the checkpoint, not code-path branching. (See: [Workflow Versioning](./workflow-platform-features.md#13-workflow-versioning).)

```typescript
// Temporal: version branches that accumulate forever
if (workflow.patched('v2-shipping')) {
  await ship(order, { express: true });
} else {
  await ship(order);
}
// v3? Now you have TWO version branches. v4? Three. They never go away.

// Weft: deploy new code. Old checkpoints migrate automatically.
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflow,
  migrate: (checkpoint, fromVersion) => ({
    ...checkpoint,
    shippingOptions: { express: true }, // add the new field
  }),
});
```

**Going further: pre-deployment compatibility checking.** A `weft version:check` CLI command that analyzes registered workflows against the existing database and reports compatibility _before_ deployment:

```bash
$ weft version:check --database ./weft.db

order (v1.0.0 → v2.0.0):
  47 running workflows at step 1 (post-charge, pre-ship)
    checkpoint shape: { payment: PaymentResult }
    new code at step 1 expects: { payment: PaymentResult, region: string }
    INCOMPATIBLE: missing field "region"
    migration function: PROVIDED (will add region: "us-east-1")

  12 running workflows at step 0 (pre-charge)
    COMPATIBLE: no migration needed

Result: 47 workflows require migration. Migration function provided. Safe to deploy.
```

**Going further: automatic checkpoint schema inference.** Since checkpoints use `structuredClone` semantics and the engine knows the generator's local variables at each yield point, the engine can automatically record a checkpoint schema for each step. On resume, if the shapes diverge and no migration is provided, the error message says exactly which fields changed: "field `address` was a string in v1, expected an object in v2" — not just `VersionMismatchError`.

### 3. Steep Learning Curve and Conceptual Overhead

**The Temporal problem.** Multiple sources describe Temporal as having a steep learning curve. The mental model is non-obvious: you write what looks like normal code, but it is actually being replayed from an event history, which means it has invisible constraints. The concepts of "commands vs. events," "workflow tasks," "sticky queues," "continue-as-new," and the 50K event history limit all require significant study. Temporal invested heavily in courses (101 and 102) because self-service onboarding was failing.

**The Weft answer.** The mental model is one concept: generators pause (`yield*`), checkpoints save, recovery resumes. If you know `async function*` and `yield*`, you know Weft. There is no event history to understand, no replay semantics, no command/event distinction. (See: [Hello World](./performance-and-examples.md#hello-world).)

**Going further: progressive disclosure with `ctx.step()`.** For developers who do not know generators, a sugar API wraps checkpoint boundaries in a familiar async function:

```typescript
// Step mode: no generators, no yield*
const handle = await engine.start(
  'onboard',
  async (ctx) => {
    const user = await ctx.step('create-user', () => createUser(input));
    await ctx.step('send-email', () => sendWelcome(user));
    return user;
  },
  { name: 'Alice' },
);
```

Under the hood, `ctx.step()` compiles to the generator form internally. Developers who need the full power of generators, parallel branches, signals, and agents graduate to the `async function*` form. The simple API is a subset of the full API — not a separate abstraction.

**Going further: `ctx.explain()` for runtime learning.** In development mode, every context method logs what it does and why:

```
[weft] ctx.run(charge, { orderId: "abc", amount: 99 })
  → Creating checkpoint at step 1 with locals: { order }
  → Dispatching activity "charge" to queue "default"
  → Checkpoint size: 847 bytes
  → Activity completed in 234ms, result: { id: "pay-123" }
  → Updated checkpoint with result, new size: 1.2KB
```

This teaches the mental model while the developer writes code.

### 4. Heavy Operational Infrastructure

**The Temporal problem.** Running Temporal self-hosted requires Cassandra or PostgreSQL, Elasticsearch for visibility, the Temporal server itself (multiple Go services), and a frontend service. Even for local development, you need Docker Compose or the Temporal CLI dev server. Temporal Cloud describes "several compute clusters, one or more databases, Elasticsearch, ingress, observability stack, and other dependency components" per cloud cell, with eight engineering on-call rotations.

**The Weft answer.** `bun add weft` or download a single binary. SQLite is the default database, embedded in the runtime. No external dependencies for development or small production deployments. (See: [Single Binary Distribution](./runtime-and-deployment.md#8-single-binary-distribution).)

```bash
# Temporal
docker compose up -d          # PostgreSQL, Elasticsearch, 4 Temporal services
temporal server start-dev     # ... or the dev shortcut that still needs Docker

# Weft
./weft --port 7233            # SQLite auto-created. Dashboard at localhost:7233/ui
```

**Going further: `weft doctor` diagnostic command.** A single command that reports everything an operator needs to know:

```bash
$ weft doctor --database ./weft.db

Database:
  Size: 2.3 GB (of 10 GB limit)
  WAL size: 12 MB (healthy)
  Integrity: OK
  Fragmentation: 8% (VACUUM recommended above 20%)

Workflows:
  Total: 14,293 (8,412 running, 5,102 completed, 779 failed)
  Longest running: wf-abc123 (started 47 days ago, step 12)
  Largest checkpoint: wf-def456 (847 KB — consider reducing state size)

Activities:
  Queue "default": 23 pending, 7 in-flight, 2 workers connected
  Queue "payments": 0 pending, 0 in-flight, 1 worker connected
  Retry rate (24h): 3.2% (healthy, below 10% threshold)

Performance:
  Avg checkpoint write: 18μs (healthy)
  Avg task claim: 42μs (healthy)
  P99 workflow start-to-first-activity: 3ms (healthy)

Recommendations:
  ⚠ wf-abc123 has been running for 47 days. Consider adding an executionTimeout.
  ⚠ Queue "payments" has only 1 worker. Consider adding redundancy.
```

**Going further: built-in alerting with zero external dependencies.** Alert rules are event listeners on the engine's internal metrics. No Prometheus, no Grafana, no alert manager required. The `AlertManager` evaluates rules against sliding time windows and dispatches `AlertFiredEvent`/`AlertResolvedEvent` with optional webhook notifications:

```typescript
const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
  alerts: {
    rules: [
      { metric: 'workflow.failure_rate', threshold: 0.05, window: '5m', action: 'log' },
      { metric: 'activity.p99_duration', threshold: 30_000, window: '1m', action: 'webhook' },
    ],
    webhooks: [{ url: 'https://hooks.slack.com/...', events: ['alert:fired', 'alert:resolved'] }],
  },
});
```

### 5. Performance Issues Out of the Box

**The Temporal problem.** The O(n) replay model means workflows with long histories get progressively slower to recover. The Temporal team acknowledges that "almost all performance issues we have encountered are caused by the default settings" — meaning the defaults are wrong for most use cases. A single-activity workflow can have "running time being too high" with default configuration.

**The Weft answer.** O(1) recovery regardless of history length. In-process SQLite reads at ~10μs instead of network round-trips at ~1ms. Task claiming is a single atomic SQL statement, not a gRPC round-trip. Defaults are optimized for the common case. (See: [Performance Profile](./performance-and-examples.md#performance-profile).)

**Going further: automatic checkpoint size monitoring.** The engine tracks checkpoint size and warns developers when it exceeds a threshold:

```typescript
// Emitted when a checkpoint exceeds the configurable threshold (default: 64KB)
engine.addEventListener('checkpoint:size-warning', (event) => {
  console.warn(
    `Workflow ${event.workflowId} checkpoint is ${event.sizeBytes} bytes at step ${event.step}. ` +
      `Consider using ctx.offload() for large intermediate state.`,
  );
});
```

**Going further: `ctx.offload()` for large intermediate state.** When a workflow accumulates large data (a list of 10,000 processed records, a large API response), the checkpoint balloons. `ctx.offload()` stores large data separately, leaving only a lightweight reference in the checkpoint:

```typescript
async function* batchWorkflow(ctx: Context, items: string[]) {
  const resultsRef = yield* ctx.offload('batch-results', async () => {
    return await processAll(items); // Large result stored separately
  });

  // resultsRef is ~64 bytes in the checkpoint, not the full dataset.
  // Load on demand when needed:
  const data = yield* ctx.load(resultsRef);
  yield* ctx.run(sendReport, { count: data.length });
}
```

**Going further: built-in profiling mode.** `MemoryProfiler` provides interval-based memory sampling with stability analysis. Start a profiling session, run a workload, then retrieve summary statistics including RSS growth slope and stability verdict:

```typescript
import { MemoryProfiler, analyzeStability } from 'weft';

const profiler = new MemoryProfiler();
profiler.start(1000); // sample every second

// ... run workload ...

profiler.stop();
const { samples, summary } = profiler.profile();
const stability = analyzeStability(samples);
// { stable: true, slope: 0.0023, verdict: "No significant memory growth detected" }
```

### 6. TypeScript SDK-Specific Pain: Webpack Bundling and Sandbox

**The Temporal problem.** The TypeScript SDK bundles workflow code through Webpack to create a sandboxed environment. This causes: module resolution failures in monorepos, cryptic Webpack errors when importing packages that reference Node APIs, inability to use `console.log` normally (must use Temporal's logger), inability to import activity code directly (must use `proxyActivities`), and the general cognitive overhead of writing code that _looks_ like TypeScript but runs in a restricted sandbox.

**The Weft answer.** No bundling, no sandbox, no Webpack. Workflows are regular TypeScript generator functions. Import anything. Use `console.log`. Reference activities directly. (See: [Web Worker Execution Model](./platform-foundations.md#2-web-worker-execution-model).)

The isolation that Temporal achieves through Webpack + sandbox, Weft achieves through Web Workers. Workers provide process-level isolation (fault containment, memory separation) without restricting the JavaScript language. This is the fundamental insight: you do not need to hobble the language to get safety — you just need OS-level process boundaries.

```typescript
// Temporal: 4 lines of ceremony before your first activity call
import type * as activities from './activities';
const { charge, ship } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
});
const result = await charge(order); // "Go to definition" → proxy type, not implementation

// Weft: zero ceremony
import { charge, ship } from './activities';
const result = yield * ctx.run(charge, order); // "Go to definition" → actual function
```

**Going further: typed workflow registry.** A type-level pattern that gives compile-time safety on `engine.start()`, `handle.result()`, and `handle.signal()`:

```typescript
interface WorkflowRegistry {
  order: {
    input: { orderId: string; items: CartItem[] };
    output: { payment: PaymentResult; shipment: ShipmentResult };
  };
  welcome: {
    input: { name: string; email: string };
    output: { greeting: string; onboarded: boolean };
  };
}

const engine = new Engine<WorkflowRegistry>({
  storage: new BunSQLiteStorage('./weft.db'),
});

// TypeScript infers everything:
const handle = await engine.start('order', { orderId: 'abc', items: [] });
//                                 ^-- autocomplete: "order" | "welcome"
//                                          ^-- type error if wrong shape

const result = await handle.result();
//    ^-- type: { payment: PaymentResult; shipment: ShipmentResult }
```

This is compile-time only. At runtime, the engine uses strings and unknown exactly as before. The type parameter is erased.

**Going further: `weft/testing` module with `TestEngine`.** A real engine backed by `MemoryStorage` with deterministic time control and crash simulation:

```typescript
import { TestEngine } from 'weft/testing';

const engine = new TestEngine();
engine.mock(charge, async (order) => ({ id: 'pay-123', amount: order.total }));

const handle = await engine.start('order', testOrder);
await engine.waitForStep(handle.id, 1);

// Simulate crash and recovery
const engine2 = engine.recover(); // New engine, same storage
const handle2 = engine2.getHandle(handle.id);
const result = await handle2.result();
// charge was NOT re-called — checkpoint preserved the result
```

### 7. `continueAsNew` for Long-Running Workflows

**The Temporal problem.** Temporal has a ~50K event history limit per workflow execution. Long-running workflows — subscription loops, monitoring agents, order lifecycle management — must periodically call `continueAsNew()` to reset their history. This requires manually serializing all state into `continueAsNew` arguments, re-registering all signal handlers in the new execution, and reconstructing all local variables. Getting this wrong causes data loss. Temporal's 2025 "Upgrade on Continue-as-New" feature (explicitly motivated by AI agent use cases where agents "sleep for weeks between interactions") helps with versioning during continuation, but the fundamental mechanism—manual state serialization at artificial boundaries—remains a sharp edge.

**The Weft answer.** Checkpoints are fixed-size snapshots of the current state, not a growing event log. A workflow that has executed 1 million activities has the same checkpoint size as one that has executed 10. There is no `continueAsNew`, no history limit, no manual state serialization. A workflow can run for years without any special handling. (See: [Checkpoint, Don't Replay](./platform-foundations.md#1-checkpoint-dont-replay).)

```
Temporal: history size grows linearly with activity count
  10 activities  →  ~1K events  →  ~100KB history
  1K activities  →  ~10K events →  ~1MB history
  50K activities →  ~50K events →  LIMIT HIT, must continueAsNew

Weft: checkpoint size is constant regardless of history
  10 activities  →  ~2KB checkpoint
  1K activities  →  ~2KB checkpoint
  1M activities  →  ~2KB checkpoint (same locals, same size)
```

**Going further: `ctx.archive()` for long-running state management.** Workflows that accumulate data over time (invoice history, event logs) can move old data out of the checkpoint while preserving it for auditing:

```typescript
async function* subscriptionWorkflow(ctx: Context, plan: Plan) {
  let invoiceHistory: Invoice[] = [];

  while (true) {
    const invoice = yield* ctx.run(generateInvoice, plan);
    invoiceHistory.push(invoice);

    if (invoiceHistory.length > 3) {
      yield* ctx.archive('invoice-history', invoiceHistory.slice(0, -3));
      invoiceHistory = invoiceHistory.slice(-3); // Keep only recent in checkpoint
    }

    yield* ctx.sleep('30 days');
  }
}
```

Archived data is stored at `archive:{workflowId}:{key}` — still queryable via the dashboard and API, but not bloating the checkpoint.

**Going further: `ctx.expose()` for live workflow inspection.** For workflows that run for weeks, operators need visibility without stopping the workflow or pre-registering query handlers:

```typescript
async function* longRunningWorkflow(ctx: Context, config: Config) {
  let processedCount = 0;
  let lastError: string | null = null;
  let currentPhase = 'initializing';

  ctx.expose({
    processedCount: () => processedCount,
    lastError: () => lastError,
    currentPhase: () => currentPhase,
    uptime: () => Date.now() - ctx.startedAt,
  });

  // ... workflow logic. Exposed values update at each checkpoint.
}
```

The dashboard renders these as a live key-value table. The HTTP API serves them at `GET /v1/workflows/:id/state`.

**Going further: checkpoint history with time-travel debugging.** Store the last N checkpoints (configurable, default 10) instead of just the latest:

```typescript
const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
  checkpointHistory: 10,
});

// GET /v1/workflows/wf-abc123/checkpoints
// Returns: [{ step: 12, timestamp: ..., size: "2.1KB" }, { step: 11, ... }, ...]

// GET /v1/workflows/wf-abc123/checkpoints/11
// Returns: the full deserialized checkpoint state at step 11
```

For debugging a workflow that has been running for 30 days, being able to see "what did the state look like 15 days ago at step 8?" is transformative.

### 8. The `proxyActivities` Indirection

**The Temporal problem.** In the TypeScript SDK, you cannot call activity functions directly. You must create proxy objects via `proxyActivities<T>()` which generate type stubs that know how to schedule activities. This exists because the sandbox cannot import activity code. It creates confusion about what is a real function call versus a scheduled remote operation. "Go to definition" navigates to the proxy type, not the actual implementation.

**The Weft answer.** `yield* ctx.run(myFunction, input)`. You pass the actual function reference and one serializable input value. The `yield*` makes the durable boundary explicit — no proxies, no type stubs, no magic. "Go to definition" takes you to the implementation. (See: [Checkpoint, Don't Replay](./platform-foundations.md#1-checkpoint-dont-replay).)

**Going further: `activity()` helper with colocated configuration.** Instead of configuring retry policies at scattered call sites, activities declare their own operational characteristics:

```typescript
import { activity } from 'weft';

export const charge = activity({
  name: 'charge',
  retry: { maxAttempts: 3, initialBackoff: '1s', multiplier: 2, maxBackoff: '30s' },
  timeout: '30s',
  queue: 'payments',
  idempotent: true,

  async execute(order: Order, context: ActivityContext): Promise<PaymentResult> {
    const result = await stripe.charges.create({
      amount: order.total,
      signal: context.signal, // Standard AbortSignal for cancellation
    });
    context.heartbeat({ status: 'processing', chargeId: result.id });
    return { id: result.id, amount: result.amount };
  },
});

// In the workflow — configuration travels with the activity:
const payment = yield * ctx.run(charge, order);
// No need to specify retry, timeout, queue — they are on the activity definition.
// But you CAN override per-invocation:
const payment = yield * ctx.run(charge, order, { timeout: '60s' });
```

**Going further: `ctx.runAll()` with named concurrent branches.** More ergonomic than `ctx.all()` with arrays when each branch needs its own error handling:

```typescript
const results =
  yield *
  ctx.runAll({
    payment: [charge, order],
    inventory: [reserveInventory, order.items],
    email: [sendConfirmation, order, { onError: 'continue' }],
  });

// results.payment: PaymentResult (throws if failed)
// results.email: SendResult | ActivityError (captured, not thrown)
```

### 9. No AI/Agent-Native Primitives

**The Temporal problem.** Teams building AI agent orchestration on Temporal must model agent loops as activities, manually handle token streaming, build their own cost tracking, and figure out human-in-the-loop patterns from scratch. Temporal's primitives were designed for microservice RPC, not multi-turn LLM interactions. The Temporal community calls this the "Lord of the Loop" problem: when integrating third-party agent frameworks (OpenAI Agents SDK, PydanticAI, LangGraph), who controls the execution loop? Temporal or the framework? A community member's extensive analysis argues that current integrations force agents to be "extremely narrow in scope—with only a few tools available." Community members have explicitly requested an "Agent Builder layer over Temporal," and multiple forum threads ask for higher-level orchestration primitives: conversation history management, guardrail hooks, agent task queues. Temporal's response: "We are examining higher level primitives...no roadmap or announcements to share about that yet."

**The Weft answer.** Weft does not ship a built-in agent primitive. Instead, its generator model makes the durable agent loop something you _build_ — each LLM call and each tool call is a `yield* ctx.run(...)` boundary, independently checkpointed, with `ctx.review()` for the human-in-the-loop step. You own the loop; Weft makes every step in it durable.

**Why this is the right boundary.** Temporal's determinism constraint forces LLM API calls into activities, and activities are opaque to the workflow — you cannot checkpoint mid-tool-call, and you cannot stream tokens back through replay. That pushes agent loops into one of two bad choices:

1. **Fully in-activity:** The entire ReAct loop runs as one activity. Tool calls within it are not individually checkpointed. If the process crashes mid-loop, the entire agent conversation restarts from scratch.
2. **Fully in-workflow:** Each LLM call is a separate activity. But now every LLM response must be deterministically replayable — and LLM APIs are inherently non-deterministic. You need to store and replay every token, defeating the purpose of having a live model.

Weft's generator model avoids this dilemma without a dedicated agent surface. Each tool call you write as a separate `yield*` boundary is independently checkpointed, and token streaming flows through the standard `EventTarget` and `WebSocket` systems. The loop you build is durable _and_ live.

**Multi-agent composition via existing primitives.** An agent step is just an activity. The existing `ctx.run()` / `ctx.all()` / `ctx.race()` composition works naturally — sequential pipelines, parallel fan-out, and delegation are all expressed in ordinary workflow code:

```typescript
async function* researchWorkflow(ctx: Context, topic: string) {
  // Sequential: researcher → critic → writer
  const research = yield* ctx.run(researchAgent, { topic });
  const critique = yield* ctx.run(critiqueAgent, { research });
  const report = yield* ctx.run(writeReportAgent, { research, critique });

  // Parallel: run multiple review steps simultaneously
  const [legal, technical] = yield* ctx.all([
    ctx.run(legalReviewAgent, { report }),
    ctx.run(technicalReviewAgent, { report }),
  ]);

  return { report, reviews: { legal, technical } };
}
```

Each `ctx.run(...)` activity wraps whatever agent framework or raw LLM client you prefer; Weft checkpoints the boundary between them. Cost tracking, budget enforcement, and tool-result caching live in those activities (or the framework you run inside them), not in the engine.

**Human-in-the-loop with `ctx.review()`.** When an agent step needs human approval, `yield* ctx.review(...)` durably suspends the workflow until a reviewer responds — the same primitive that gates any other approval flow, applied to agent output.

### 10. Payload Size Sensitivity

**The Temporal problem.** The docs warn extensively about keeping workflow inputs, outputs, and activity results small because everything is serialized into the event history. Large payloads degrade replay performance and bloat storage. This is a tax on the developer experience — you have to constantly think about data size. For AI workloads, this tax is acute: a single GPT-4 response with tool calls can be 10–50KB, and multi-turn conversations with function calling reach megabytes quickly. Individual payloads are capped at 2MB with a 4MB gRPC message limit. Every AI team on Temporal builds the same claim-check pattern—externalize large payloads to S3, pass references through the history. The official `temporal-ai-agent` demo warns explicitly: "In a prod setting, I would need to ensure that payload data is stored separately."

**The Weft answer.** Checkpoints store only the current state — the values of local variables at the pause point. Activity inputs are not stored in the checkpoint (they are derived from the workflow code). Previous activity results are only stored if they are still live in a local variable. A workflow that processed 1,000 large API responses but only keeps the final summary in a local variable has a checkpoint containing only that summary. (See: [Checkpoint, Don't Replay](./platform-foundations.md#1-checkpoint-dont-replay).)

```typescript
// A workflow that processes 100 images (each 1MB):
async function* imageWorkflow(ctx: Context, urls: string[]) {
  let summary = { processed: 0, totalSize: 0 };

  for (const url of urls) {
    const result = yield* ctx.run(processImage, url);
    // result is in scope as a local — but only until the NEXT yield*
    summary = { processed: summary.processed + 1, totalSize: summary.totalSize + result.size };
  }
  // Temporal: history contains 100 x 1MB activity results = ~100MB
  // Weft: checkpoint contains only { summary: { processed: 100, totalSize: ... } } = ~200 bytes
  return summary;
}
```

**Going further: `ctx.stream()` for large payloads.** When an activity produces a large result, `ctx.stream()` writes data to storage as chunks without buffering in memory:

```typescript
async function* dataExportWorkflow(ctx: Context, query: ExportQuery) {
  const exportRef = yield* ctx.stream('export-data', async function* (sink) {
    const cursor = db.query(query);
    for await (const batch of cursor) {
      yield batch;
      sink.heartbeat({ processed: batch.length });
    }
  });

  // exportRef in the checkpoint is ~64 bytes.
  // Actual data at blob:{workflowId}:export-data:chunk:{n}
  const url = ctx.streamUrl(exportRef);
  yield* ctx.run(notifyUser, { downloadUrl: url });
}
```

**Going further: automatic payload compression.** For payloads above a configurable threshold, the storage layer compresses transparently:

```typescript
const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
  compression: {
    threshold: 4096, // Compress blobs larger than 4KB
    algorithm: 'gzip', // "gzip" | "brotli" | "none"
  },
});
```

**Going further: pluggable serialization.** While `structuredClone` semantics are the right default, some teams need custom serialization for `BigInt`, `Decimal`, or domain-specific value objects:

```typescript
const engine = new Engine({
  serializer: {
    serialize(value: unknown): Uint8Array {
      /* custom encoding */
    },
    deserialize(bytes: Uint8Array): unknown {
      /* custom decoding */
    },
  },
});
```

The default uses MessagePack with `structuredClone` semantics. Custom serializers plug in at the same boundary. The engine validates the serializer at startup by round-tripping a test value.

---

## AI Workloads: Three Structural Mismatches Temporal Cannot Fix

The ten design failures above are architectural consequences of replay-based execution. They affect _all_ Temporal workloads. But AI/LLM workloads hit three additional structural mismatches that make the friction acute enough to drive teams toward workaround infrastructure or alternative platforms entirely. These are not bugs Temporal will patch—they are consequences of design decisions that predate the agent era.

The pain points below are sourced from Temporal's own community forums, GitHub issues, and webinar Q&As. They represent what production teams building AI products on Temporal are hitting _right now_.

### 1. Event Sourcing Assumes Small, Discrete State Transitions—LLM Interactions Produce Large, Continuous Data Flows

Temporal's event history records every activity result. A single GPT-4 response with tool calls can be 10–50KB. Multi-turn conversations with function calling reach megabytes. This creates compounding pressure against the 51,200-event / 50MB execution limits, degrades replay performance proportionally, and forces aggressive `continueAsNew` policies. Individual payloads are capped at 2MB with a 4MB gRPC message limit.

The streaming gap is worse. Token-by-token delivery is the primary output mode for LLM applications—users cannot wait 30–60 seconds for a complete response. Every team building AI on Temporal constructs the same workaround: a Redis pub/sub or SSE sidecar that streams tokens from activities to frontends _outside_ Temporal's durability model. A Temporal engineer confirmed in December 2025 that native streaming plans exist but remain in early design, with activity-to-workflow streaming described as "a longer term project." Scale AI confirmed using Redis pub/sub as their production workaround.

**How Weft eliminates this.** Checkpoints store only the current state—not the history of every activity result. A workflow that processed 100 large LLM responses but only keeps the current conversation in a local variable has a checkpoint containing only that conversation. No history bloat, no payload caps, no `continueAsNew`. For streaming, an activity can return a `ReadableStream<string>` that bridges to `EventTarget`, WebSocket observers, and SSE endpoints natively. No Redis sidecar, no infrastructure outside the durability model. (The earlier `ctx.offload()` and payload-compression examples in this overview show how large intermediate state stays out of the hot checkpoint path.)

### 2. The Activity Boundary Is Too Coarse for Agent Loop Durability

This is the most architecturally significant friction. When teams integrate agent frameworks (OpenAI Agents SDK, PydanticAI, LangGraph) with Temporal, they face a fundamental question: _who controls the agent's execution loop?_

Today, the agent framework runs inside a Temporal activity. Temporal cannot provide durability, signals, child workflows, or timers within the agent's tool-calling cycle. If the agent makes 10 tool calls inside a single activity, Temporal sees one opaque operation—it can retry the whole thing, but cannot checkpoint between tool calls 5 and 6.

The alternative—decomposing the agent loop into individual Temporal activities—preserves durability at the right granularity but forces teams to abandon the framework and reimplement the loop in workflow code. A community member authored an extensive analysis of this dilemma ("The Lord of the Loop"), arguing that current integrations force agents to be "extremely narrow in scope—with only a few tools available." Temporal's response was candid: "You would need to find a way of breaking LangGraph up into serializable payloads...Until then, executing your LangGraph agents as one Temporal activity will work."

**How Weft eliminates this.** There is no dilemma because Weft's generator model makes each tool call a `yield*` boundary—independently checkpointed, individually retryable, observable at the right granularity. The agent loop _is_ the workflow: model each LLM turn and each tool call as its own `ctx.run(...)` step and every one is independently checkpointed, with token streaming flowing through standard `ReadableStream` and `EventTarget`, so a crash resumes mid-loop. The granularity is yours to choose: run a whole external framework loop inside a single activity and it stays opaque to the engine — it checkpoints only at that boundary, so a crash re-runs the entire loop. Expose the internal turns as separate `ctx.run()` steps when you want yield-level recovery.

### 3. The Python Sandbox Conflicts with Every Major AI/ML Library

Temporal's Python SDK sandbox—designed to enforce determinism via import isolation—conflicts with virtually every major AI/ML library. PyTorch, httpx, Pydantic V2, cryptography, debugpy, Loguru, and Protobuf all have documented sandbox conflicts. A GitHub issue requesting a "make option for all passthrough" is upvoted by an OpenAI employee. The practical result is that most AI teams either maintain extensive custom passthrough lists or disable the sandbox entirely with `UnsandboxedWorkflowRunner()`.

Nearly every AI/ML Python library depends on Pydantic V2, and the sandbox's re-importing causes models to be created with incorrect field types. An official Pydantic contrib module has been requested but not yet shipped.

**How Weft sidesteps this entirely.** Weft is TypeScript-native. There is no Python sandbox, no import isolation, no passthrough lists. The isolation that Temporal achieves through Webpack + sandbox, Weft achieves through Web Workers—OS-level process boundaries that don't restrict the language. You do not need to hobble the runtime to get safety. (See: [Web Worker Execution Model](./platform-foundations.md#2-web-worker-execution-model) and [TypeScript SDK-Specific Pain](#6-typescript-sdk-specific-pain-webpack-bundling-and-sandbox).)

---

## Competitive Landscape

Three durable execution platforms explicitly target Temporal's AI workload gaps. Teams evaluating Weft will encounter all of them. Here is how they compare architecturally—not as feature checklists, but as design trade-offs.

### Inngest

Inngest has the most complete AI-specific feature set among Temporal alternatives. `step.ai.infer()` provides native AI inference as a durable step with automatic token counting. `step.ai.wrap()` wraps any AI SDK with observability. `useAgent` provides a React hook for parts-based streaming from durable workflows to frontends via their Realtime feature. AgentKit provides first-class agent/network/router abstractions. Their observability dashboard offers SQL-queryable token usage and cost analysis.

**Where Inngest leads:** Full serverless suspension during LLM inference waits. When `step.ai.infer()` calls an LLM API, the function doesn't run (or charge) while waiting for the response. Inngest also ships AI-specific primitives (`step.ai.infer()`, AgentKit) that Weft leaves to userland. Weft's worker-mode execution keeps the per-workflow worker reserved until completion.

**Where Weft leads:** Durability model. Inngest uses an event-driven step function model, not checkpoint-based recovery. Weft's O(1) checkpoint recovery, constant-size state regardless of history length, and no event/history limits provide stronger durability guarantees for long-running workflows. A generator-based loop built on `ctx.run()` gets finer-grained checkpointing than Inngest's step-level boundaries. Weft also runs as a self-contained library or single binary with embedded storage—no cloud dependency required.

### Restate

Restate competes on architecture and latency. Virtual Objects provide session-scoped stateful entities—a natural fit for multi-turn AI conversations where each session maintains state. Their durable AI loops approach demonstrates wrapping existing AI SDKs (Vercel AI SDK, OpenAI Agent SDK, Google ADK, Pydantic AI) via simple middleware. Single-binary, zero-dependency deployment targets Temporal's infrastructure complexity.

**Where Restate leads:** Virtual Objects provide built-in session affinity with co-located state—no sticky routing configuration needed. User code suspension during async waits (similar to Inngest) allows processes to be shut down during LLM calls.

**Where Weft leads:** Checkpoint granularity and state model. Both engines leave agent-level concerns (budget enforcement, context window management, model routing) to userland; Weft's yield-level checkpointing means an agent loop built on `ctx.run()` recovers at the individual tool-call boundary rather than the journal-replay boundary. Weft's `ctx.state` ladder keeps session state checkpoint-local while execution and workflow scopes use durable storage-backed state.

### Hatchet

Hatchet positions as simpler Temporal with AI-first design. Native result streaming, FIFO/LIFO/Round Robin/Priority queue policies for fair scheduling, built-in human-in-the-loop eventing, and Postgres-only self-hosting.

**Where Hatchet leads:** Queue scheduling policies (priority, FIFO, round-robin) are more sophisticated than Weft's current least-loaded routing.

**Where Weft leads:** Weft exceeds Hatchet on streaming (multiplexed ReadableStream with backpressure vs. result streaming), storage flexibility (SQLite, LMDB, Turso, IndexedDB vs. Postgres-only), checkpoint granularity (yield-level vs. step-level), and deployment flexibility (library mode, single binary, browser via Service Worker).

### Summary

| Capability                | Temporal           | Inngest            | Restate            | Hatchet          | Weft                 |
| ------------------------- | ------------------ | ------------------ | ------------------ | ---------------- | -------------------- |
| Durability model          | Event replay       | Step functions     | Journal replay     | Event-driven     | Checkpoint           |
| Recovery cost             | O(n) history       | Step-level         | O(n) journal       | Step-level       | O(1) checkpoint      |
| Checkpoint granularity    | Activity-level     | Step-level         | Context call-level | Step-level       | Yield-level          |
| Native streaming          | No (Redis sidecar) | Realtime + hooks   | No                 | Result streaming | ReadableStream       |
| Observability             | External only      | Built-in dashboard | External only      | Basic            | Events + OTel        |
| Serverless suspension     | No                 | Yes                | Yes                | No               | Worker parking       |
| Self-hosted single binary | No                 | No                 | Yes                | No (Postgres)    | Yes (SQLite)         |
| Browser runtime           | No                 | No                 | No                 | No               | Yes (Service Worker) |

---

## Honest Gaps

Weft does not ship AI-native primitives. Agent loops, budget enforcement, context-window management, and model routing all live in userland — built on `ctx.run()` and `ctx.review()` or inside an external agent framework you call from an activity. The unchecked roadmap items in [the roadmap](../architecture.md) are operational performance-verification tasks, not AI primitives.

---
