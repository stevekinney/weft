# Weft: A Bun-Native Durable Execution Engine

> _Weft_ — the cross-threads in weaving that bind the warp together.

> [!NOTE]
> Weft's built-in agent surface — `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()`, and the agent types, events, and runtime that backed them — was removed in v0.1.0. Weft does not ship an agent primitive. Build durable agent loops on `ctx.run()` and `ctx.review()`, or run them in an external agent framework. See the [`CHANGELOG`](../CHANGELOG.md) for the full removed-export list and upgrade notes.

---

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

5. **Library/server parity.** Every capability exposed by the server's HTTP and WebSocket API is also available through the library's in-process `Engine` API — and vice versa. A developer who starts with `bun add @lostgradient/weft` and later moves to the standalone server (or the reverse) should not lose features or change workflow code. The server is a deployment wrapper around the engine, not a superset of it.

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
| Versioning             | `patched()` / `deprecatePatch()`  | Version-pinned recovery guard        |
| Long-running workflows | `continueAsNew()`                 | Nothing (checkpoints are fixed-size) |
| Dev environment        | Docker Compose + Temporal server  | `bun add @lostgradient/weft`         |
| Bundling               | Webpack for workflow sandbox      | None                                 |

### 1. The Determinism Constraint Is a Developer Experience Nightmare

**The Temporal problem.** Temporal's TypeScript SDK removes `WeakRef` and `FinalizationRegistry` from the sandbox, replaces `Date.now()` and `Math.random()` with deterministic versions, and runs workflows through Webpack bundling that cannot reference Node.js or DOM APIs. Developers write normal-looking code, it works in tests, and then it explodes with `DeterminismViolationError` in production during replay. The error messages are often inscrutable ("Activity machine does not handle this event").

**The Weft answer.** Checkpoint, don't replay. No determinism requirement at all. Use `Date.now()`, `WeakRef`, `FinalizationRegistry`, `Math.random()` — anything. The only rule is `yield*` for durable operations. (See: [Checkpoint, Don't Replay](#1-checkpoint-dont-replay).)

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

**The Weft answer.** Checkpointing means code before the current checkpoint never re-executes. Changing steps after the current checkpoint is inherently safe. Versioning only matters for the step you are currently on, and Weft treats version drift as an operator decision point instead of branching inside workflow code. (See: [Workflow Versioning](#13-workflow-versioning).)

```typescript
// Temporal: version branches that accumulate forever
if (workflow.patched('v2-shipping')) {
  await ship(order, { express: true });
} else {
  await ship(order);
}
// v3? Now you have TWO version branches. v4? Three. They never go away.

// Weft: deploy new code under a new version. Old checkpoints stop at recovery.
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflow,
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

  12 running workflows at step 0 (pre-charge)
    COMPATIBLE: checkpoint can resume under v2.0.0

Result: 47 workflows require operator resolution before deploying v2.0.0.
```

**Going further: automatic checkpoint schema inference.** Since checkpoints use `structuredClone` semantics and the engine knows the generator's local variables at each yield point, the engine can automatically record a checkpoint schema for each step. On resume, if the shapes diverge, the error message says exactly which fields changed: "field `address` was a string in v1, expected an object in v2" — not just `VersionMismatchError`.

### 3. Steep Learning Curve and Conceptual Overhead

**The Temporal problem.** Multiple sources describe Temporal as having a steep learning curve. The mental model is non-obvious: you write what looks like normal code, but it is actually being replayed from an event history, which means it has invisible constraints. The concepts of "commands vs. events," "workflow tasks," "sticky queues," "continue-as-new," and the 50K event history limit all require significant study. Temporal invested heavily in courses (101 and 102) because self-service onboarding was failing.

**The Weft answer.** The mental model is one concept: generators pause (`yield*`), checkpoints save, recovery resumes. If you know `async function*` and `yield*`, you know Weft. There is no event history to understand, no replay semantics, no command/event distinction. (See: [Hello World](#hello-world).)

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

**The Weft answer.** `bun add @lostgradient/weft` or download a single binary. SQLite is the default database, embedded in the runtime. No external dependencies for development or small production deployments. (See: [Single Binary Distribution](#8-single-binary-distribution).)

```bash
# Temporal
docker compose up -d          # PostgreSQL, Elasticsearch, 4 Temporal services
temporal server start-dev     # ... or the dev shortcut that still needs Docker

# Weft
./weft --port 7233            # SQLite auto-created. Dashboard at localhost:7233/
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

**The Weft answer.** O(1) recovery regardless of history length. In-process SQLite reads at ~10μs instead of network round-trips at ~1ms. Task claiming is a single atomic SQL statement, not a gRPC round-trip. Defaults are optimized for the common case. (See: [Performance Profile](#performance-profile).)

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
import { MemoryProfiler, analyzeStability } from '@lostgradient/weft';

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

**The Weft answer.** No bundling, no sandbox, no Webpack. Workflows are regular TypeScript generator functions. Import anything. Use `console.log`. Reference activities directly. (See: [Web Worker Execution Model](#2-web-worker-execution-model).)

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

**Going further: `@lostgradient/weft/testing` module with `TestEngine`.** A real engine backed by `MemoryStorage` with deterministic time control and crash simulation:

```typescript
import { TestEngine } from '@lostgradient/weft/testing';

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

**The Weft answer.** Checkpoints are fixed-size snapshots of the current state, not a growing event log. A workflow that has executed 1 million activities has the same checkpoint size as one that has executed 10. There is no `continueAsNew`, no history limit, no manual state serialization. A workflow can run for years without any special handling. (See: [Checkpoint, Don't Replay](#1-checkpoint-dont-replay).)

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

The dashboard renders these as a live key-value table. The HTTP API serves them at `GET /api/v1/workflows/:id/state`.

**Going further: checkpoint history with time-travel debugging.** Store the last N checkpoints (configurable, default 10) instead of just the latest:

```typescript
const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
  checkpointHistory: 10,
});

// GET /api/v1/workflows/wf-abc123/checkpoints
// Returns: [{ step: 12, timestamp: ..., size: "2.1KB" }, { step: 11, ... }, ...]

// GET /api/v1/workflows/wf-abc123/checkpoints/11
// Returns: the full deserialized checkpoint state at step 11
```

For debugging a workflow that has been running for 30 days, being able to see "what did the state look like 15 days ago at step 8?" is transformative.

### 8. The `proxyActivities` Indirection

**The Temporal problem.** In the TypeScript SDK, you cannot call activity functions directly. You must create proxy objects via `proxyActivities<T>()` which generate type stubs that know how to schedule activities. This exists because the sandbox cannot import activity code. It creates confusion about what is a real function call versus a scheduled remote operation. "Go to definition" navigates to the proxy type, not the actual implementation.

**The Weft answer.** `yield* ctx.run(myFunction, input)`. You pass the actual function reference and one serializable input value. The `yield*` makes the durable boundary explicit — no proxies, no type stubs, no magic. "Go to definition" takes you to the implementation. (See: [Checkpoint, Don't Replay](#1-checkpoint-dont-replay).)

**Going further: `activity()` helper with colocated configuration.** Instead of configuring retry policies at scattered call sites, activities declare their own operational characteristics:

```typescript
import { activity } from '@lostgradient/weft';

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

**The Weft answer.** Checkpoints store only the current state — the values of local variables at the pause point. Activity inputs are not stored in the checkpoint (they are derived from the workflow code). Previous activity results are only stored if they are still live in a local variable. A workflow that processed 1,000 large API responses but only keeps the final summary in a local variable has a checkpoint containing only that summary. (See: [Checkpoint, Don't Replay](#1-checkpoint-dont-replay).)

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

**How Weft eliminates this.** Checkpoints store only the current state—not the history of every activity result. A workflow that processed 100 large LLM responses but only keeps the current conversation in a local variable has a checkpoint containing only that conversation. No history bloat, no payload caps, no `continueAsNew`. For streaming, an activity can return a `ReadableStream<string>` that bridges to `EventTarget`, WebSocket observers, and SSE endpoints natively. No Redis sidecar, no infrastructure outside the durability model. (See: [ctx.offload()](#5-performance-issues-out-of-the-box), [Payload Compression](#10-payload-size-sensitivity).)

### 2. The Activity Boundary Is Too Coarse for Agent Loop Durability

This is the most architecturally significant friction. When teams integrate agent frameworks (OpenAI Agents SDK, PydanticAI, LangGraph) with Temporal, they face a fundamental question: _who controls the agent's execution loop?_

Today, the agent framework runs inside a Temporal activity. Temporal cannot provide durability, signals, child workflows, or timers within the agent's tool-calling cycle. If the agent makes 10 tool calls inside a single activity, Temporal sees one opaque operation—it can retry the whole thing, but cannot checkpoint between tool calls 5 and 6.

The alternative—decomposing the agent loop into individual Temporal activities—preserves durability at the right granularity but forces teams to abandon the framework and reimplement the loop in workflow code. A community member authored an extensive analysis of this dilemma ("The Lord of the Loop"), arguing that current integrations force agents to be "extremely narrow in scope—with only a few tools available." Temporal's response was candid: "You would need to find a way of breaking LangGraph up into serializable payloads...Until then, executing your LangGraph agents as one Temporal activity will work."

**How Weft eliminates this.** There is no dilemma because Weft's generator model makes each tool call a `yield*` boundary—independently checkpointed, individually retryable, observable at the right granularity. The agent loop _is_ the workflow: model each LLM turn and each tool call as its own `ctx.run(...)` step and every one is independently checkpointed, with token streaming flowing through standard `ReadableStream` and `EventTarget`, so a crash resumes mid-loop. The granularity is yours to choose: run a whole external framework loop inside a single activity and it stays opaque to the engine — it checkpoints only at that boundary, so a crash re-runs the entire loop. Expose the internal turns as separate `ctx.run()` steps when you want yield-level recovery. (See: [Checkpoint, Don't Replay](#1-checkpoint-dont-replay).)

### 3. The Python Sandbox Conflicts with Every Major AI/ML Library

Temporal's Python SDK sandbox—designed to enforce determinism via import isolation—conflicts with virtually every major AI/ML library. PyTorch, httpx, Pydantic V2, cryptography, debugpy, Loguru, and Protobuf all have documented sandbox conflicts. A GitHub issue requesting a "make option for all passthrough" is upvoted by an OpenAI employee. The practical result is that most AI teams either maintain extensive custom passthrough lists or disable the sandbox entirely with `UnsandboxedWorkflowRunner()`.

Nearly every AI/ML Python library depends on Pydantic V2, and the sandbox's re-importing causes models to be created with incorrect field types. An official Pydantic contrib module has been requested but not yet shipped.

**How Weft sidesteps this entirely.** Weft is TypeScript-native. There is no Python sandbox, no import isolation, no passthrough lists. The isolation that Temporal achieves through Webpack + sandbox, Weft achieves through Web Workers—OS-level process boundaries that don't restrict the language. You do not need to hobble the runtime to get safety. (See: [Web Worker Execution Model](#2-web-worker-execution-model), [TypeScript SDK-Specific Pain](#6-typescript-sdk-specific-pain-webpack-bundling-and-sandbox).)

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

Weft does not ship AI-native primitives. Agent loops, budget enforcement, context-window management, and model routing all live in userland — built on `ctx.run()` and `ctx.review()` or inside an external agent framework you call from an activity. The unchecked roadmap items are operational performance-verification tasks, not AI primitives.

---

## Design Philosophy: No Userland Where Platform Exists

Weft eliminates every userland pattern that has a platform-native equivalent:

| Userland Pattern             | Platform Replacement                                    | Where in Weft                                                           |
| ---------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Node `EventEmitter`          | `EventTarget` + `Event` subclasses                      | Engine, WorkflowHandle, Worker                                          |
| RxJS / custom Observable     | `Symbol.observable` protocol + `AsyncIterator`          | Workflow observation, token streaming                                   |
| Manual try/finally cleanup   | `Symbol.dispose` / `using` declarations                 | Storage connections, Worker pools, Subscriptions                        |
| Manual cache invalidation    | `WeakRef` + `FinalizationRegistry`                      | Checkpoint cache, Worker pool, Activity registry                        |
| Custom deferred patterns     | `Promise.withResolvers()`                               | Signal waiting, result awaiting                                         |
| Custom ID generation         | `crypto.randomUUID()`                                   | Everywhere                                                              |
| Custom cloning               | `structuredClone()`                                     | Checkpoint serialization                                                |
| Custom cancellation          | `AbortController` / `AbortSignal`                       | Workflow cancellation, budget limits, timeouts                          |
| Custom streaming layer       | `ReadableStream` / `WritableStream` / `TransformStream` | Token streaming, context window management, stream multiplexing         |
| Separate library/server APIs | Single engine, deployment-agnostic handler              | `server/handler.ts` wraps `Engine`; `client/local.ts` calls it directly |

---

## Key Vocabulary

**Workflow:** A multi-step durable process defined as a generator function. The "orchestrator" that decides what to do and in what order.

**Activity:** A single unit of work dispatched by a workflow. Where side effects happen — API calls, database writes, emails. Just a regular async function.

**Checkpoint:** A snapshot of a workflow's current position and local variables. If the process crashes, the checkpoint is loaded and the workflow resumes from that exact point.

**Signal:** An external message sent _into_ a running workflow (e.g., "cancel this order").

**Query:** A read-only peek into a running workflow's state.

**Worker (Weft):** A process or thread that executes activities. In server mode, workers connect over WebSocket. In library mode, activities run inline.

**Worker (Web):** A standard Web Worker — a separate JavaScript thread. Weft uses Web Workers internally to isolate workflow execution from the HTTP server's main thread.

**Update:** A synchronous message sent into a running workflow that blocks the caller until the workflow processes it and returns a result. Unlike signals (fire-and-forget), updates are request-response.

**Search Attribute:** User-defined indexed metadata on a workflow (customer ID, region, priority) queryable via the list API. Stored as secondary indexes in the KV layer.

**Interceptor:** A composable hook that wraps workflow context operations (activities, sleeps, signals) for cross-cutting concerns like tracing, validation, and encryption. Interceptors chain via `next()` delegation.

**Execution Timeout:** Maximum wall-clock time for an entire workflow. Measured from start to terminal completion.

**MCP (Model Context Protocol):** A standard protocol for discovering and invoking LLM tools from external servers. Supports stdio and HTTP+SSE transports.

**Shared State:** A CAS-backed durable mutable state primitive that multiple concurrent workflows or activities can read from and write to without clobbering each other's writes.

**Human Review:** A structured interaction protocol for human-in-the-loop workflows, supporting approval, rejection, conversation threading, escalation, and partial approval.

---

## Architecture: Web Standards As The Foundation

### The Web Standards Stack

Every layer of Weft maps to a web standard:

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Code                            │
│            async function* myWorkflow(ctx) { ... }          │
├─────────────────────────────────────────────────────────────┤
│                      Weft Engine                            │
│  Generators │ structuredClone │ AbortController │ UUIDs     │
├──────────────────────┬──────────────────────────────────────┤
│   Server (Bun)       │        Browser                       │
│   Bun.serve()        │   Service Worker (fetch event)       │
│   Web Workers        │   Web Workers                        │
│   Bun.SQL (SQLite)   │   IndexedDB                          │
│   BroadcastChannel   │   BroadcastChannel                   │
│   WebSocket          │   WebSocket (to remote server)       │
├──────────────────────┴──────────────────────────────────────┤
│                   Wire Protocol                             │
│           HTTP (REST) + WebSocket + SSE                     │
│        JSON (default) / MessagePack (opt-in)                │
└─────────────────────────────────────────────────────────────┘
```

**Why this matters:** Any code that only uses the "Weft Engine" row runs identically in Bun, the browser, Deno, Cloudflare Workers, or any WASM environment. Platform-specific code is confined to the storage and server layers.

### Primitive Mapping

| Need                    | Web Standard                               | Bun Enhancement                      |
| ----------------------- | ------------------------------------------ | ------------------------------------ |
| IDs                     | `crypto.randomUUID()`                      | —                                    |
| Serialization           | `structuredClone()`                        | Fast path for `postMessage`          |
| Cancellation            | `AbortController` / `AbortSignal`          | —                                    |
| Timers                  | `setTimeout` (non-durable)                 | Stored as operations in DB (durable) |
| Parallelism             | `Worker` (Web Workers)                     | OS threads with shared I/O           |
| Inter-thread messaging  | `postMessage` / `MessageChannel`           | Transferable optimizations           |
| Pub/sub between threads | `BroadcastChannel`                         | Cross-worker event dispatch          |
| HTTP server             | `fetch` event handler                      | `Bun.serve()` with native perf       |
| Streaming               | `ReadableStream` / `WritableStream`        | —                                    |
| Binary encoding         | `TextEncoder`/`TextDecoder`, `ArrayBuffer` | —                                    |

---

## Core Design Decisions

### 1. Checkpoint, Don't Replay

This is the central architectural divergence from Temporal.

Workflows are `AsyncGenerator` functions. Each `yield*` is a checkpoint boundary. On crash, Weft deserializes the last checkpoint and resumes — no replay, no determinism constraints, O(1) recovery.

```typescript
export async function* orderWorkflow(ctx: Context, order: Order) {
  const payment = yield* ctx.run(charge, order); // checkpoint 1
  const shipment = yield* ctx.run(ship, { order, payment }); // checkpoint 2
  return { payment, shipment };
}
```

> **What are generators?** A function declared with `function*` that can pause itself with `yield` and be resumed later. Each pause preserves all local variables. `yield*` delegates to another generator. `AsyncGenerator` functions support `await` within the generator body. They're the only JavaScript primitive that gives you serializable, suspendable execution — and they're a web standard that works everywhere.

**Serialization uses `structuredClone` semantics** — the same algorithm browsers use for `postMessage`. This means checkpoints can contain: primitives, plain objects, arrays, `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer`, `TypedArray`. They **cannot** contain: functions, closures, class instances with methods, Symbols, WeakMap, WeakRef, or system resources (sockets, file handles).

#### No History Growth, No `continueAsNew`

Temporal's event history grows linearly with every activity, timer, and signal. At ~50K events, you must call `continueAsNew()` — which restarts the workflow, destroying all local variable state and requiring manual serialization of everything you want to carry forward. Signal handlers must be re-registered. Child workflow references must be re-established. This is not an edge case; any workflow that loops (subscriptions, monitoring, batch processing) hits this limit.

Weft's checkpoint is a constant-size snapshot of the current state. It does not grow with workflow history length. A workflow can run for years, execute millions of activities, and its checkpoint stays the same size as it was after the first `yield*`. There is no history limit, no `continueAsNew`, no manual state serialization. Long-running workflows just run.

#### Payload Efficiency

Temporal stores every activity input and output in the event history. If your workflow calls 100 activities that each return 10KB of data, the history contains 1MB of payload data — even if the workflow only uses the final result. Large payloads (file contents, API responses, document bodies) bloat history, slow down replay, and accelerate hitting the 50K event limit.

Weft checkpoints store only the current state — the values of local variables at the yield point. Activity inputs are not stored (they are derived from the workflow code on re-execution). Previous activity results are only present if they are still in scope as local variables. A workflow that processed 100 large API responses but only keeps a summary has a checkpoint containing only that summary.

### 2. Web Worker Execution Model

Weft uses the standard **`Worker` API** (not `node:worker_threads` — the _web standard_ `Worker`) to isolate execution:

```
┌──────────────────────────────────────────────┐
│ Main Thread                                  │
│                                              │
│  Bun.serve()          ← HTTP/WS requests     │
│  Router               ← API routing          │
│  Scheduler            ← Timer/retry polling   │
│  BroadcastChannel     ← Coordination          │
│                                              │
│  Does NOT execute workflows or activities     │
└──────────────┬──────────────┬────────────────┘
               │              │
     ┌─────────▼──────┐ ┌────▼───────────┐
     │ Workflow Worker │ │ Activity Worker│  (1..N of each)
     │                │ │ Pool           │
     │ Runs generator │ │ Runs activity  │
     │ checkpoints    │ │ functions      │
     │ advances state │ │ reports results│
     │                │ │                │
     │ postMessage ↔  │ │ postMessage ↔  │
     └────────────────┘ └────────────────┘
```

> **Why Web Workers, not just async code on the main thread?**
>
> 1. **Fault isolation.** If a workflow throws an unhandled error or enters an infinite loop, it crashes _its_ worker — not the HTTP server. The main thread detects the crash, marks the workflow as failed, and spins up a fresh worker.
> 2. **True parallelism.** JavaScript is single-threaded per event loop. Web Workers give you actual OS threads. A workflow computing something CPU-heavy doesn't block other workflows or the API server.
> 3. **Portability.** The `Worker` API is identical in Bun and in browsers. The same isolation model works in both environments with zero code changes. This is the core "web native" win.
> 4. **Memory control.** Bun's `smol: true` option for Workers reduces memory footprint per worker, useful when running many concurrent workflows.

#### Web Workers Replace the Temporal Sandbox

Temporal's TypeScript SDK uses Webpack bundling to create a sandboxed execution environment for workflows. This sandbox strips out non-deterministic APIs, prevents importing Node.js modules, intercepts `console.log`, and introduces module resolution failures in monorepos. The result: workflow code _looks_ like TypeScript but runs in a restricted subset of JavaScript.

Weft achieves the same safety guarantees — fault isolation and memory separation — through Web Workers. Workers are OS-level process boundaries. They provide true isolation without restricting the JavaScript language:

- **`console.log` works.** No special logger required.
- **Any npm package works.** No module resolution restrictions. No Webpack errors.
- **`debugger` statements work.** Bun's debugger and Chrome DevTools can attach to Workers.
- **Stack traces point to your source files.** Not to Webpack-generated bundle code.
- **No build step for workflows.** Changes take effect immediately. No Webpack rebuild.

The fundamental insight: you do not need to hobble the language to get safety. You just need OS-level process boundaries.

```typescript
// Main thread: spawn a workflow worker
const worker = new Worker(new URL('./workflow-runner.ts', import.meta.url), {
  smol: true, // Bun-specific: reduce memory footprint
});

// Send a workflow task to the worker
worker.postMessage(
  {
    type: 'run',
    workflowId: 'wf-abc123',
    workflowType: 'order',
    checkpoint: checkpointBlob, // ArrayBuffer — transferred, not copied
    input: { orderId: 'order-456' },
  },
  [checkpointBlob],
); // Transfer list: zero-copy

// Receive results
worker.onmessage = (event) => {
  const { type, workflowId, checkpoint, result, operationRequest } = event.data;

  switch (type) {
    case 'checkpoint':
      // Workflow yielded — persist the new checkpoint and dispatch the operation
      storage.updateCheckpoint(workflowId, checkpoint);
      storage.scheduleOperation(operationRequest);
      break;
    case 'completed':
      // Workflow returned — persist the result
      storage.completeWorkflow(workflowId, result);
      break;
    case 'failed':
      // Workflow threw — persist the error
      storage.failWorkflow(workflowId, result);
      break;
  }
};
```

```typescript
// workflow-runner.ts (runs inside a Web Worker)
/// <reference lib="webworker" />

import { registry } from './workflow-registry.ts';

self.onmessage = async (event) => {
  const { workflowId, workflowType, checkpoint, input } = event.data;

  const workflowFn = registry.get(workflowType);
  // ... restore or create the generator, advance it, report back

  // Use AbortController for cancellation (web standard)
  const controller = new AbortController();
  // If main thread sends a cancel message, abort
  // ...
};
```

#### BroadcastChannel for Coordination

> **What is BroadcastChannel?** A web standard for pub/sub messaging between same-origin contexts (windows, tabs, workers). In Bun, it works across Workers. You create a named channel, and any Worker subscribed to that channel name receives messages posted to it.

Weft uses `BroadcastChannel` for engine-wide coordination without direct Worker-to-Worker references:

```typescript
// On any thread:
const bus = new BroadcastChannel('weft:events');

// Scheduler (main thread) announces: "signal received for workflow wf-abc"
bus.postMessage({ type: 'signal:received', workflowId: 'wf-abc', signal: 'cancel' });

// Workflow Worker hears it and can react immediately (no polling needed)
bus.onmessage = (event) => {
  if (event.data.type === 'signal:received' && event.data.workflowId === myWorkflowId) {
    controller.abort(); // Cancel the in-flight operation
  }
};
```

This replaces what would otherwise be complex direct Worker references or a shared-memory coordination protocol.

### 3. EventTarget-Based Event System

Weft's `Engine` and `WorkflowHandle` extend `EventTarget` — the same interface that DOM elements, `WebSocket`, `AbortSignal`, and `BroadcastChannel` use. No custom event emitter. No `.on()` / `.off()` / `.emit()`. Just `addEventListener`, `removeEventListener`, and `dispatchEvent`.

#### Typed Event Subclasses (Not CustomEvent)

Following the modern best practice, Weft defines **Event subclasses** rather than using `CustomEvent` with `.detail`. This gives us: named properties directly on the event object, TypeScript inference without casts, and self-documenting event classes.

```typescript
// ─── Event Definitions ───

export class WorkflowStartedEvent extends Event {
  static readonly type = 'workflow:started' as const;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: unknown;

  constructor(workflowId: string, workflowType: string, input: unknown) {
    super(WorkflowStartedEvent.type);
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.input = input;
  }
}

export class WorkflowCompletedEvent extends Event {
  static readonly type = 'workflow:completed' as const;
  readonly workflowId: string;
  readonly result: unknown;
  readonly duration: number;

  constructor(workflowId: string, result: unknown, duration: number) {
    super(WorkflowCompletedEvent.type);
    this.workflowId = workflowId;
    this.result = result;
    this.duration = duration;
  }
}

export class WorkflowFailedEvent extends Event {
  static readonly type = 'workflow:failed' as const;
  readonly workflowId: string;
  readonly error: Error;

  constructor(workflowId: string, error: Error) {
    super(WorkflowFailedEvent.type);
    this.workflowId = workflowId;
    this.error = error;
  }
}

export class ActivityStartedEvent extends Event {
  static readonly type = 'activity:started' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;

  constructor(opId: string, wfId: string, name: string, attempt: number) {
    super(ActivityStartedEvent.type);
    this.operationId = opId;
    this.workflowId = wfId;
    this.activityName = name;
    this.attempt = attempt;
  }
}

export class ActivityCompletedEvent extends Event {
  static readonly type = 'activity:completed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly duration: number;

  constructor(opId: string, wfId: string, name: string, duration: number) {
    super(ActivityCompletedEvent.type);
    this.operationId = opId;
    this.workflowId = wfId;
    this.activityName = name;
    this.duration = duration;
  }
}

export class TokenEvent extends Event {
  static readonly type = 'stream:token' as const;
  readonly workflowId: string;
  readonly token: string;
  readonly model: string;

  constructor(workflowId: string, token: string, model: string) {
    super(TokenEvent.type);
    this.workflowId = workflowId;
    this.token = token;
    this.model = model;
  }
}

export class SignalReceivedEvent extends Event {
  static readonly type = 'signal:received' as const;
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: unknown;

  constructor(workflowId: string, signalName: string, payload: unknown) {
    super(SignalReceivedEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
    this.payload = payload;
  }
}

export class WorkflowTimedOutEvent extends Event {
  static readonly type = 'workflow:timed-out' as const;
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number;

  constructor(workflowId: string, timeoutType: 'execution' | 'run', elapsed: number) {
    super(WorkflowTimedOutEvent.type);
    this.workflowId = workflowId;
    this.timeoutType = timeoutType;
    this.elapsed = elapsed;
  }
}

export class AttributesChangedEvent extends Event {
  static readonly type = 'attributes:changed' as const;
  readonly workflowId: string;
  readonly changes: Record<string, unknown>;

  constructor(workflowId: string, changes: Record<string, unknown>) {
    super(AttributesChangedEvent.type);
    this.workflowId = workflowId;
    this.changes = changes;
  }
}

export class UpdateReceivedEvent extends Event {
  static readonly type = 'update:received' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;

  constructor(updateId: string, workflowId: string, name: string, payload: unknown) {
    super(UpdateReceivedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.payload = payload;
  }
}

export class UpdateCompletedEvent extends Event {
  static readonly type = 'update:completed' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly result: unknown;
  readonly error: string | undefined;

  constructor(updateId: string, workflowId: string, name: string, result: unknown, error?: string) {
    super(UpdateCompletedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.result = result;
    this.error = error;
  }
}

export class ReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];
  readonly timeout: string | undefined;

  constructor(
    workflowId: string,
    reviewId: string,
    reviewType: string,
    reviewers: string[],
    timeout?: string,
  ) {
    super(ReviewRequestedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.reviewType = reviewType;
    this.reviewers = reviewers;
    this.timeout = timeout;
  }
}

export class ReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: 'approved' | 'rejected' | 'partial';
  readonly reviewer: string;
  readonly feedback: string | undefined;
  readonly duration: number;

  constructor(
    workflowId: string,
    reviewId: string,
    decision: 'approved' | 'rejected' | 'partial',
    reviewer: string,
    duration: number,
    feedback?: string,
  ) {
    super(ReviewCompletedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.decision = decision;
    this.reviewer = reviewer;
    this.feedback = feedback;
    this.duration = duration;
  }
}

// Type map for addEventListener inference
export interface WeftEventMap {
  [WorkflowStartedEvent.type]: WorkflowStartedEvent;
  [WorkflowCompletedEvent.type]: WorkflowCompletedEvent;
  [WorkflowFailedEvent.type]: WorkflowFailedEvent;
  [ActivityStartedEvent.type]: ActivityStartedEvent;
  [ActivityCompletedEvent.type]: ActivityCompletedEvent;
  [TokenEvent.type]: TokenEvent;
  [SignalReceivedEvent.type]: SignalReceivedEvent;
  [WorkflowTimedOutEvent.type]: WorkflowTimedOutEvent;
  [AttributesChangedEvent.type]: AttributesChangedEvent;
  [UpdateReceivedEvent.type]: UpdateReceivedEvent;
  [UpdateCompletedEvent.type]: UpdateCompletedEvent;
  [ReviewRequestedEvent.type]: ReviewRequestedEvent;
  [ReviewCompletedEvent.type]: ReviewCompletedEvent;
}
```

#### Engine as EventTarget

```typescript
type Duration = number | string; // e.g., 30000, "30 seconds", "24 hours", "7 days"

interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration; // Max wall-clock time for the entire workflow
  searchAttributes?: Record<string, SearchAttributeValue>;
}

export class Engine extends EventTarget implements Disposable {
  #storage: Storage;
  #workers: WorkerPool;
  #scheduler: Scheduler;
  #abortController = new AbortController();

  constructor(options: EngineOptions) {
    super();
    this.#storage = options.storage ?? new MemoryStorage();
    this.#scheduler = new Scheduler(this.#storage, this);
    // Worker execution configured via options.workerExecution (workflows)
    // and options.activityExecution (activities), both optional.
  }

  async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle> {
    const id = options?.id ?? crypto.randomUUID();
    // ... create workflow in storage ...

    // Dispatch typed event — no .detail, no casting
    this.dispatchEvent(new WorkflowStartedEvent(id, type, input));

    return new WorkflowHandle(id, this, this.#storage);
  }

  // ─── Interceptors ───
  addInterceptor(interceptor: WorkflowInterceptor): void {
    /* ... */
  }
  addActivityInterceptor(interceptor: ActivityInterceptor): void {
    /* ... */
  }

  // ─── Synchronous updates ───
  async update<TPayload = unknown, TResult = unknown>(
    workflowId: string,
    name: string,
    payload: TPayload,
    options?: UpdateOptions,
  ): Promise<TResult> {
    /* ... */
  }

  // ─── Typed addEventListener overload ───
  addEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: any, options?: any): void {
    super.addEventListener(type, listener, options);
  }

  // ─── Symbol.dispose: deterministic cleanup ───
  [Symbol.dispose](): void {
    this.#abortController.abort();
    this.#workers[Symbol.dispose]();
    this.#scheduler[Symbol.dispose]();
  }

  // ─── Symbol.asyncDispose: async cleanup with flush ───
  async [Symbol.asyncDispose](): Promise<void> {
    this.#abortController.abort();
    await this.#scheduler.flush();
    await this.#workers[Symbol.asyncDispose]();
    if ('close' in this.#storage) await (this.#storage as any).close();
  }
}
```

**Usage with typed events:**

```typescript
const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

// Full TypeScript inference — no casts, no .detail
engine.addEventListener(WorkflowStartedEvent.type, (event) => {
  // event is WorkflowStartedEvent — TS knows this
  console.log(`Started: ${event.workflowId} (${event.workflowType})`);
});

engine.addEventListener(ActivityCompletedEvent.type, (event) => {
  // event is ActivityCompletedEvent
  console.log(`Activity ${event.activityName} took ${event.duration}ms`);
});

// AbortController-based listener cleanup (web standard since 2023)
const controller = new AbortController();
engine.addEventListener(
  WorkflowFailedEvent.type,
  (event) => {
    alertOps(event.workflowId, event.error);
  },
  { signal: controller.signal },
);

// Later: remove ALL listeners registered with this signal in one call
controller.abort();
```

#### WorkflowHandle as EventTarget

```typescript
export class WorkflowHandle extends EventTarget implements AsyncDisposable {
  #id: string;
  #engine: Engine;
  #storage: Storage;
  #resultPromise: PromiseWithResolvers<unknown>;
  #abortController = new AbortController();

  constructor(id: string, engine: Engine, storage: Storage) {
    super();
    this.#id = id;
    this.#engine = engine;
    this.#storage = storage;
    this.#resultPromise = Promise.withResolvers<unknown>();

    // Forward relevant engine events scoped to this workflow
    engine.addEventListener(
      WorkflowCompletedEvent.type,
      (event) => {
        if (event.workflowId === this.#id) {
          this.#resultPromise.resolve(event.result);
          this.dispatchEvent(event);
        }
      },
      { signal: this.#abortController.signal },
    );

    engine.addEventListener(
      WorkflowFailedEvent.type,
      (event) => {
        if (event.workflowId === this.#id) {
          this.#resultPromise.reject(event.error);
          this.dispatchEvent(event);
        }
      },
      { signal: this.#abortController.signal },
    );
  }

  get id(): string {
    return this.#id;
  }

  result(): Promise<unknown> {
    return this.#resultPromise.promise;
  }

  async signal(name: string, payload?: unknown): Promise<void> {
    await this.#engine.signal(this.#id, name, payload);
  }

  async cancel(): Promise<void> {
    await this.#engine.cancel(this.#id);
  }

  // ─── Symbol.observable: workflow events as an observable stream ───
  [Symbol.observable](): Observable<Event> {
    return new Observable((observer) => {
      const handler = (event: Event) => observer.next(event);
      const signal = new AbortController();

      for (const type of Object.keys(weftEventTypes)) {
        this.addEventListener(type, handler, { signal: signal.signal });
      }

      // Cleanup when unsubscribed
      return () => signal.abort();
    });
  }

  // ─── AsyncIterator: for-await-of workflow events ───
  async *[Symbol.asyncIterator](): AsyncIterator<Event> {
    // Convert EventTarget events to an async iterable stream
    // Uses a queue + Promise.withResolvers pattern
    const queue: Event[] = [];
    let waiter: PromiseWithResolvers<void> | null = null;
    const signal = new AbortController();

    const enqueue = (event: Event) => {
      queue.push(event);
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
    };

    this.addEventListener(WorkflowCompletedEvent.type, enqueue, { signal: signal.signal });
    this.addEventListener(WorkflowFailedEvent.type, enqueue, { signal: signal.signal });
    this.addEventListener(ActivityStartedEvent.type, enqueue, { signal: signal.signal });
    this.addEventListener(ActivityCompletedEvent.type, enqueue, { signal: signal.signal });
    this.addEventListener(TokenEvent.type, enqueue, { signal: signal.signal });

    try {
      while (true) {
        if (queue.length === 0) {
          waiter = Promise.withResolvers<void>();
          await waiter.promise;
        }
        const event = queue.shift()!;
        yield event;
        if (event instanceof WorkflowCompletedEvent || event instanceof WorkflowFailedEvent) {
          return;
        }
      }
    } finally {
      signal.abort();
    }
  }

  // ─── Symbol.asyncDispose ───
  async [Symbol.asyncDispose](): Promise<void> {
    this.#abortController.abort();
  }
}
```

**Three ways to consume workflow events:**

```typescript
// 1. Classic addEventListener (familiar to every web developer)
handle.addEventListener(ActivityCompletedEvent.type, (event) => {
  progressBar.update(event.activityName);
});

// 2. for-await-of (clearest imperative style)
for await (const event of handle) {
  if (event instanceof TokenEvent) {
    process.stdout.write(event.token);
  }
  if (event instanceof WorkflowCompletedEvent) {
    console.log('Done:', event.result);
  }
}

// 3. Observable (composable, RxJS-compatible via Symbol.observable)
import { from } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';

from(handle) // RxJS reads Symbol.observable automatically
  .pipe(
    filter((e): e is TokenEvent => e instanceof TokenEvent),
    map((e) => e.token),
  )
  .subscribe((token) => process.stdout.write(token));
```

### 4. Explicit Resource Management (`using` / `Symbol.dispose`)

Explicit Resource Management reached Stage 4 at TC39 in early 2026. Bun and TypeScript 5.2+ support it. This is the **correct** way to manage lifecycle in Weft — no more manual `.close()` / `.shutdown()` / `.destroy()` methods that developers forget to call.

#### Every Weft Resource is Disposable

```typescript
// ─── Engine ───
{
  using engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

  engine.register('order', orderWorkflow);
  const handle = await engine.start('order', { orderId: 'abc' });
  await handle.result();
} // engine[Symbol.dispose]() called automatically:
// - Aborts all pending operations
// - Terminates worker pool
// - Stops scheduler
// - Closes storage connection

// ─── Async disposal for graceful shutdown ───
{
  await using engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

  // ... run workflows ...
} // await engine[Symbol.asyncDispose]() called:
// - Flushes pending writes
// - Waits for in-flight activities to complete (with timeout)
// - Then cleans up everything

// ─── WorkflowHandle ───
{
  await using handle = await engine.start('order', input);

  handle.addEventListener(TokenEvent.type, (e) => {
    process.stdout.write(e.token);
  });

  const result = await handle.result();
} // handle[Symbol.asyncDispose](): detaches all event listeners

// ─── Storage Connections ───
{
  using storage = new BunSQLiteStorage('./weft.db');
  // ... use storage ...
} // storage[Symbol.dispose](): closes SQLite connection

// ─── Worker Pool ───
{
  using pool = new WorkerPool({ concurrency: 10 });
  // ... dispatch work ...
} // pool[Symbol.dispose](): terminates all workers

// ─── DisposableStack for multi-resource orchestration ───
async function runServer(port: number) {
  await using stack = new AsyncDisposableStack();

  const storage = stack.use(new BunSQLiteStorage('./weft.db'));
  const engine = stack.use(new Engine({ storage }));
  const server = stack.adopt(
    Bun.serve({ port, fetch: (request) => handleRequest(request, engine) }),
    (s) => s.stop(), // custom disposal logic
  );

  // stack.defer() for arbitrary cleanup (like Go's defer)
  stack.defer(() => console.log('Server shut down cleanly'));

  engine.register('order', orderWorkflow);

  console.log(`Weft running on port ${port}`);
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
} // AsyncDisposableStack disposes everything in reverse order:
// 1. Logs "Server shut down cleanly"
// 2. Stops HTTP server
// 3. Disposes engine (flushes, terminates workers)
// 4. Closes storage
```

#### Internal Disposal Contracts

```typescript
class WorkerPool implements Disposable, AsyncDisposable {
  #workers: Worker[] = [];
  #available: Worker[] = [];

  [Symbol.dispose](): void {
    // Immediate termination — for ungraceful shutdown
    for (const worker of this.#workers) {
      worker.terminate();
    }
    this.#workers.length = 0;
    this.#available.length = 0;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // Graceful: wait for in-flight tasks, then terminate
    await Promise.allSettled(this.#workers.map((w) => this.#drainWorker(w)));
    this[Symbol.dispose]();
  }
}

class Scheduler implements Disposable {
  #interval: ReturnType<typeof setInterval> | null = null;

  [Symbol.dispose](): void {
    if (this.#interval) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
  }
}
```

### 5. Memory Management: WeakRef, WeakMap, and FinalizationRegistry

These three primitives eliminate entire categories of memory leaks that plague long-running processes like workflow engines.

#### Checkpoint Cache (WeakRef + FinalizationRegistry)

When a workflow is actively being advanced, we cache its deserialized checkpoint in memory to avoid repeated deserialization. But we don't want to hold every checkpoint forever — that's a memory leak for an engine running thousands of workflows.

```typescript
class CheckpointCache {
  // WeakRef allows the GC to collect cached checkpoints when memory is tight.
  // The engine can always re-read from storage if the WeakRef is collected.
  #cache = new Map<string, WeakRef<GeneratorState>>();

  // FinalizationRegistry notifies us when a cached value has been GC'd,
  // so we can clean up the Map entry (otherwise the Map grows forever
  // with stale WeakRefs pointing to nothing).
  #registry = new FinalizationRegistry<string>((workflowId) => {
    this.#cache.delete(workflowId);
  });

  get(workflowId: string): GeneratorState | undefined {
    const ref = this.#cache.get(workflowId);
    if (!ref) return undefined;

    const state = ref.deref();
    if (!state) {
      // GC already collected it — clean up the dead entry
      this.#cache.delete(workflowId);
      return undefined;
    }
    return state;
  }

  set(workflowId: string, state: GeneratorState): void {
    // If there was an old entry, unregister it from the FinalizationRegistry
    const existing = this.#cache.get(workflowId);
    if (existing) {
      const old = existing.deref();
      if (old) this.#registry.unregister(old);
    }

    this.#cache.set(workflowId, new WeakRef(state));
    this.#registry.register(state, workflowId, state); // (target, heldValue, unregisterToken)
  }

  clear(): void {
    this.#cache.clear();
  }
}
```

> **Why not just a regular Map?** A regular `Map<string, GeneratorState>` would hold strong references to every checkpoint ever loaded. In a long-running server processing thousands of workflows, this would grow without bound. With `WeakRef`, the GC can reclaim checkpoints that aren't actively being used. If the engine needs the checkpoint again, it re-reads from storage. This gives us the performance benefit of a cache without the memory leak.

#### Activity Registry

Activities are registered by definition name and looked up at dispatch time. `Engine.register(activityDefinition)` delegates to the internal `ActivityRegistry`, which keeps a name index for dispatch and WeakMap-backed metadata for function references:

```typescript
class ActivityRegistry {
  #metadata = new WeakMap<object, ActivityMetadata>();
  #definitions = new Map<string, ActivityMetadata>();
  #nameIndex = new Map<string, object>();

  register(name: string, fn: Function, options?: ActivityRegistrationOptions): void {
    const metadata = buildActivityMetadata(name, fn, options);
    this.#metadata.set(fn, metadata);
    this.#definitions.set(name, metadata);
    this.#nameIndex.set(name, fn);
  }
}

class Engine {
  register(registration: WorkflowRegistration | ActivityDefinition): this {
    if (isActivityDefinition(registration)) {
      this.#internals.activityRegistry.register(registration.name, registration);
      return this;
    }

    registerWorkflow(this.#internals, registration);
    return this;
  }
}
```

In worker mode, activities must be registered before the engine starts processing. The engine resolves an activity by name: if the operation carries an inline function reference (library mode), it uses that directly; otherwise it looks up the name in the registry (remote worker mode).

#### Workflow Handle Registry (WeakRef)

When multiple parts of your code hold `WorkflowHandle` references, the engine shouldn't prevent GC of handles that are no longer needed:

```typescript
class HandleRegistry {
  // The engine tracks active handles to dispatch events to them,
  // but shouldn't prevent handles from being GC'd if the user drops them.
  #handles = new Map<string, WeakRef<WorkflowHandle>>();
  #finalization = new FinalizationRegistry<string>((id) => {
    this.#handles.delete(id);
  });

  track(handle: WorkflowHandle): void {
    this.#handles.set(handle.id, new WeakRef(handle));
    this.#finalization.register(handle, handle.id, handle);
  }

  get(id: string): WorkflowHandle | undefined {
    const ref = this.#handles.get(id);
    return ref?.deref();
  }
}
```

### 6. Observable Protocol (`Symbol.observable`)

The Observable proposal is at TC39 Stage 1, but `Symbol.observable` is a de facto standard used by RxJS, Most.js, Zen Observable, and others. Any object with a `[Symbol.observable]()` method is automatically consumable by `Observable.from()` in these libraries.

Weft implements this on both `WorkflowHandle` (shown above) and as a standalone observation function:

```typescript
import { Symbol as Sym } from './symbols.ts'; // polyfill Symbol.observable if needed

// Observe all engine events as an observable stream
engine[Sym.observable] = function (): Observable<Event> {
  return new Observable((observer) => {
    const controller = new AbortController();
    const forward = (event: Event) => observer.next(event);

    for (const EventClass of allWeftEvents) {
      this.addEventListener(EventClass.type, forward, { signal: controller.signal });
    }

    return () => controller.abort();
  });
};

// ─── Token stream as an observable (for UI rendering) ───
function observeTokens(handle: WorkflowHandle): Observable<string> {
  return new Observable((observer) => {
    const controller = new AbortController();

    handle.addEventListener(
      TokenEvent.type,
      (event) => {
        observer.next(event.token);
      },
      { signal: controller.signal },
    );

    handle.addEventListener(
      WorkflowCompletedEvent.type,
      () => {
        observer.complete();
      },
      { signal: controller.signal },
    );

    handle.addEventListener(
      WorkflowFailedEvent.type,
      (event) => {
        observer.error(event.error);
      },
      { signal: controller.signal },
    );

    return () => controller.abort();
  });
}
```

**Why both AsyncIterator AND Observable?**

- `for-await-of` (`Symbol.asyncIterator`) is imperative, pull-based. Best for: sequential processing, server-side consumption, scripts.
- Observable (`Symbol.observable`) is declarative, push-based. Best for: UI rendering, composition with operators, reactive pipelines.
- `addEventListener` is the escape hatch for maximum control and familiarity.

All three consume the same underlying event stream. Users choose the pattern that fits their use case.

### 7. The Database Decision: SQLite (via Bun.SQL) + LMDB Option

**The question was: SQLite vs LevelDB vs LMDB?**

**The answer: SQLite as default, LMDB as high-performance option. Not LevelDB.**

Here's the reasoning:

|                          | SQLite (Bun.SQL)                                | LMDB (lmdb-js)                                             | LevelDB                               |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| **Built into Bun**       | Yes — `Bun.SQL` ships with the runtime          | No — npm dependency with native addon                      | No — npm dependency with native addon |
| **Compiles into binary** | `bun build --compile` includes it automatically | Needs native addon bundled                                 | Needs native addon bundled            |
| **Read performance**     | Fast (~100K reads/sec)                          | Fastest possible (~1M+ reads/sec, memory-mapped zero-copy) | Good (~200K reads/sec)                |
| **Write performance**    | ~50K writes/sec (WAL mode)                      | ~100K+ writes/sec (batched async)                          | ~30K writes/sec                       |
| **Concurrent readers**   | Unlimited in WAL mode                           | Unlimited (MVCC, zero locks)                               | Single-process only                   |
| **Multi-process safe**   | Yes                                             | Yes (shared memory)                                        | No — single process lock              |
| **Browser equivalent**   | sql.js (WASM) or OPFS                           | No browser equivalent                                      | IndexedDB (via abstract-level)        |
| **Query flexibility**    | Full SQL — ad-hoc queries, JOINs, aggregation   | Key-value only, range scans                                | Key-value only, range scans           |
| **Bun support**          | First-class                                     | Official (uses Node-API)                                   | Unofficial                            |
| **Used in production**   | Everywhere                                      | Parcel, HarperDB, Kibana, Gatsby                           | Chrome (internal)                     |
| **Crash safety**         | ACID                                            | ACID, crash-proof by design                                | Good, but not full ACID               |

> **Why not LevelDB?** It's single-process only (no multi-process access), slower on writes than both alternatives, and its main advantage — the `abstract-level` ecosystem with browser backends — doesn't justify the tradeoffs when we already have a clean storage interface pattern. LMDB is strictly better for our server-side workload.

> **Why not LMDB as default?** Because `Bun.SQL` (SQLite) ships inside the Bun runtime. It compiles into single binaries with zero configuration. It requires no native addons. And it gives us SQL — which is invaluable for the dashboard, ad-hoc debugging queries, and the list/filter API. LMDB is faster for pure KV workloads, but the ergonomic and deployment advantages of built-in SQLite outweigh the raw performance difference for v1.

> **When should you use LMDB?** When you're running Weft in server mode at high scale (>30K workflows/sec) and you need maximum read throughput. LMDB's memory-mapped, zero-copy reads are unbeatable for hot-path operations like task claiming. The `lmdb-js` package officially supports Bun with Node-API bindings.

**The storage interface is KV-oriented** (not SQL-oriented) to support both:

```typescript
interface Storage {
  // Core KV operations
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;

  // Range scans (ordered by key)
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;

  // Atomic batch writes (multiple puts/deletes in one transaction)
  batch(operations: BatchOperation[]): Promise<void>;

  // Optional: SQL passthrough for dashboard/debugging (SQLite only)
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string; // greater than
  lt?: string; // less than
  gte?: string; // greater than or equal
  lte?: string; // less than or equal
}
```

**Key design pattern:** Hierarchical keys encode structure:

```
wf:{id}                                       → workflow state blob
wf:{id}:ckpt                                  → checkpoint blob
op:{queue}:{scheduled}:{id}                   → operation blob (sorted by queue + time)
ev:{workflow_id}:{seq}                         → event blob (sorted by workflow + sequence)
sig:{workflow_id}:{name}:{id}                  → signal blob
wf-deadline:{deadline}:{workflowId}            → timeout deadline entry (execution or run)
attr:{workflow_id}                             → search attribute blob (all attrs for a workflow)
idx:{attr_name}:{encoded_value}:{workflow_id}  → secondary index entry for search attributes
upd:{workflow_id}:{update_id}                  → pending update request
upr:{update_id}                                → update response
upk:{workflow_id}:{idempotency_key}            → update idempotency mapping
```

This key layout means `scan("op:default:")` returns all operations on the "default" queue in scheduled order — the core hot path is a single range scan, whether that's implemented as a SQLite `SELECT ... WHERE key >= ? AND key < ?` or an LMDB `cursor.getRange()`.

#### Bun.SQL Implementation (Default)

```typescript
import { SQL } from 'bun';

class BunSQLiteStorage implements Storage {
  private db: SQL;

  constructor(path: string = 'weft.db') {
    // Bun.SQL's unified API — tagged template literals
    this.db = new SQL(`sqlite://${path}`);
    this.#init();
  }

  async #init() {
    // Single KV table — simple, fast, indexes do the heavy lifting
    await this.db`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        expires_at INTEGER
      ) WITHOUT ROWID
    `;
    // WITHOUT ROWID: Tells SQLite to store data directly in the B-tree index.
    // For a KV table where the key IS the primary key, this avoids a level of
    // indirection and makes lookups ~2x faster.

    // Partial index: only index rows with an expiration (for TTL cleanup)
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_expires
      ON kv(expires_at) WHERE expires_at IS NOT NULL
    `;

    // Performance PRAGMAs
    await this.db`PRAGMA journal_mode = WAL`;
    await this.db`PRAGMA synchronous = NORMAL`;
    await this.db`PRAGMA cache_size = -64000`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const [row] = await this.db`SELECT value FROM kv WHERE key = ${key}`;
    return row?.value ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.db`
      INSERT INTO kv (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = ${value}
    `;
  }

  async delete(key: string): Promise<void> {
    await this.db`DELETE FROM kv WHERE key = ${key}`;
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    // Range scan: all keys starting with prefix
    const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = await this.db`
      SELECT key, value FROM kv
      WHERE key >= ${options?.gte ?? prefix} AND key < ${options?.lt ?? end}
      ORDER BY key ${options?.reverse ? this.db`DESC` : this.db`ASC`}
      ${options?.limit ? this.db`LIMIT ${options.limit}` : this.db``}
    `;
    for (const row of rows) {
      yield [row.key, row.value];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    await this.db.begin(async (tx) => {
      for (const op of operations) {
        if (op.type === 'put') {
          await tx`INSERT INTO kv (key, value) VALUES (${op.key}, ${op.value})
                   ON CONFLICT(key) DO UPDATE SET value = ${op.value}`;
        } else {
          await tx`DELETE FROM kv WHERE key = ${op.key}`;
        }
      }
    });
  }

  // Bonus: SQL passthrough for dashboard queries
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    // Only available on the SQL backend — LMDB and IndexedDB don't have this
    return (await this.db.unsafe(sql, params)) as T[];
  }
}
```

#### LMDB Implementation (High-Performance Option)

```typescript
import { open, RootDatabase } from 'lmdb';

class LMDBStorage implements Storage {
  private db: RootDatabase;

  constructor(path: string = './weft-data') {
    this.db = open({
      path,
      // LMDB is memory-mapped: reads are zero-copy pointers into mmap'd pages.
      // This is why it's so fast — no serialization/deserialization for reads.
      mapSize: 2 * 1024 * 1024 * 1024, // 2GB initial map (auto-grows)
      maxDbs: 1,
      // lmdb-js handles write batching automatically:
      // Multiple put() calls are coalesced into one transaction commit,
      // which happens asynchronously on a separate thread.
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    // Synchronous! LMDB reads are memory-mapped — no I/O, no event loop delay.
    // lmdb-js returns the value directly from mmap'd memory.
    return this.db.getBinary(key) ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    // Asynchronous: lmdb-js batches this write with others and commits
    // on a background thread. The promise resolves when flushed to disk.
    await this.db.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.db.remove(key);
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    // LMDB stores keys in sorted order — range scans are native and fast
    const range = this.db.getRange({
      start: options?.gte ?? prefix,
      end:
        options?.lt ??
        prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1),
      reverse: options?.reverse,
      limit: options?.limit,
    });
    for (const { key, value } of range) {
      yield [key as string, value as Uint8Array];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    // lmdb-js supports explicit atomic transactions
    await this.db.transaction(() => {
      for (const op of operations) {
        if (op.type === 'put') {
          this.db.putSync(op.key, op.value);
        } else {
          this.db.removeSync(op.key);
        }
      }
    });
  }
}
```

#### IndexedDB Implementation (Browser)

```typescript
class IndexedDBStorage implements Storage {
  private db: IDBDatabase | null = null;
  private dbName: string;

  constructor(dbName: string = 'weft') {
    this.dbName = dbName;
  }

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const request = tx.objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ... scan uses IDBKeyRange.bound() for range queries
  // ... batch uses a single readwrite transaction
}
```

### 8. Single Binary Distribution

`bun build --compile` produces standalone executables that include the Bun runtime, all your code, and embedded assets (including the web dashboard). End users download one file and run it.

```bash
# Build for all platforms from any OS
bun build --compile --target=bun-darwin-arm64  src/cli.ts --outfile dist/weft-darwin-arm64
bun build --compile --target=bun-darwin-x64    src/cli.ts --outfile dist/weft-darwin-x64
bun build --compile --target=bun-linux-x64     src/cli.ts --outfile dist/weft-linux-x64
bun build --compile --target=bun-linux-arm64   src/cli.ts --outfile dist/weft-linux-arm64
bun build --compile --target=bun-windows-x64   src/cli.ts --outfile dist/weft-windows-x64.exe

# Windows gets proper metadata
# (via Bun 1.2.21+ compile options for title, version, publisher, etc.)
```

**What ships inside the binary:**

- The Bun runtime (includes SQLite, HTTP server, WebSocket, etc.)
- Weft engine, server, worker code
- The web dashboard (pre-built React SPA, embedded as assets)
- Default configuration

**What does NOT ship inside the binary** (and shouldn't):

- LMDB native bindings (opt-in via `bun add lmdb` when using LMDB storage)
- Workflow and activity code (user's code, loaded at runtime or built into their own binary)

```typescript
// src/cli.ts — the entry point compiled into the binary
import { parseArgs } from 'util';
import { serve } from './server/index.ts';
import { Engine, BunSQLiteStorage } from './core/index.ts';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '7233' },
    data: { type: 'string', default: './weft-data' },
    ui: { type: 'boolean', default: true },
    storage: { type: 'string', default: 'sqlite' }, // "sqlite" | "lmdb"
  },
});

// Embed the dashboard as a file asset
import dashboardHTML from './ui/dist/index.html' with { type: 'file' };

const storage =
  values.storage === 'lmdb'
    ? new (await import('./storage/lmdb.ts')).LMDBStorage(values.data)
    : new BunSQLiteStorage(`${values.data}/weft.db`);

serve({
  port: parseInt(values.port),
  storage,
  dashboard: values.ui ? dashboardHTML : undefined,
});
```

**User distribution modes:**

```bash
# Mode 1: Standalone server (download and run)
curl -L https://github.com/weft/weft/releases/download/v1/weft-darwin-arm64 -o weft
chmod +x weft
./weft --port 7233

# Mode 2: Library (import into your project)
bun add @lostgradient/weft

# Mode 3: User compiles their own binary with workflows baked in
bun build --compile src/my-app.ts --outfile my-app
# my-app includes Weft engine + your workflow code in one binary
```

### 9. Service Worker: The Browser Runtime

> **What is a Service Worker?** A Service Worker is a special kind of Web Worker that acts as a proxy between your web app and the network. It intercepts `fetch` events, can cache responses, and crucially — **it runs in the background even when the tab is closed.** It has access to IndexedDB for persistent storage and `setTimeout`-like scheduling. It's how PWAs (Progressive Web Apps) work offline.

For Weft, a Service Worker is the **browser equivalent of the Bun server process**:

```
┌──────────────────────────────────────────────────────┐
│ Browser Tab (your app)                               │
│                                                      │
│  const weft = new WeftClient();                      │
│  await weft.start("order", { orderId: "abc" });      │
│                                                      │
│  // This fetch() is intercepted by the Service Worker│
│  fetch("/weft/v1/workflows", { method: "POST", ... })│
│                                                      │
└──────────────────┬───────────────────────────────────┘
                   │ fetch event
┌──────────────────▼───────────────────────────────────┐
│ Service Worker (weft-sw.ts)                          │
│                                                      │
│  self.addEventListener("fetch", (event) => {         │
│    if (event.request.url.includes("/weft/")) {       │
│      event.respondWith(engine.handleRequest(event)); │
│    }                                                 │
│  });                                                 │
│                                                      │
│  Engine(IndexedDBStorage) ← same engine code!        │
│                                                      │
│  // Durable timers via IndexedDB + periodic check    │
│  // Workflow execution in spawned Web Workers         │
│  // Survives tab close (Service Worker lifecycle)     │
└──────────────────────────────────────────────────────┘
```

**What this enables:**

- **Offline-first durable workflows.** An app starts a workflow (e.g., "sync these photos when online"). The Service Worker persists the workflow to IndexedDB. Even if the user closes the tab, the Service Worker can resume when the browser wakes it up.
- **Same API surface.** The Weft client library calls `fetch("/weft/v1/workflows", ...)`. In server mode, this goes over the network to a Weft server. In browser mode, the Service Worker intercepts it. The client code is identical.
- **Hybrid mode.** The Service Worker can be a local cache/queue that syncs with a remote Weft server. Start workflows locally, sync state when online.

```typescript
// weft-sw.ts — installed as a Service Worker
/// <reference lib="webworker" />

import { Engine } from '@lostgradient/weft';
import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';
import { handleRequest } from '@lostgradient/weft/server/handler'; // Pure request→response, no Bun.serve dependency

const engine = new Engine({
  storage: new IndexedDBStorage('weft'),
});

// Intercept fetch events — same API as the HTTP server
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/weft/')) {
    event.respondWith(handleRequest(event.request, engine));
  }
});

// Periodic timer check (Service Worker wakeup)
// Browsers can wake a Service Worker periodically via the Periodic Background Sync API
self.addEventListener('periodicsync', (event: PeriodicSyncEvent) => {
  if (event.tag === 'weft-timers') {
    event.waitUntil(engine.processExpiredTimers());
  }
});
```

> **Limitation:** Service Workers don't have unlimited background execution time. Browsers limit how long a Service Worker can run after the page is closed. For truly long-running workflows, you'd still need a server. The Service Worker is ideal for: queuing work, short workflows, offline caching, and syncing state with a remote server.

### 10. HTTP + WebSocket — No gRPC, No Protobuf

Modern Bun releases include route-based `Bun.serve()`, which is the most idiomatic way to define an HTTP API:

```typescript
import { serve } from 'bun';

const server = serve({
  port: 7233,

  routes: {
    // Workflow Management (JSON API)
    'POST /api/v1/workflows': async (req) => {
      const body = await req.json();
      const handle = await engine.start(body.type, body.input, {
        idempotencyKey: body.idempotencyKey,
        executionTimeout: body.executionTimeout,
        searchAttributes: body.searchAttributes,
      });
      return Response.json({ id: handle.id, status: 'running' }, { status: 201 });
    },

    'GET /api/v1/workflows/:id': async (req) => {
      const workflow = await engine.get(req.params.id);
      if (!workflow) return new Response('Not found', { status: 404 });
      return Response.json(workflow);
    },

    'DELETE /api/v1/workflows/:id': async (req) => {
      await engine.cancel(req.params.id);
      return new Response(null, { status: 204 });
    },

    'POST /api/v1/workflows/:id/signal/:name': async (req) => {
      const payload = await req.json();
      await engine.signal(req.params.id, req.params.name, payload);
      return Response.json({ delivered: true });
    },

    'GET /api/v1/workflows/:id/query/:name': async (req) => {
      const result = await engine.query(req.params.id, req.params.name);
      return Response.json(result);
    },

    // Search Attributes
    'GET /api/v1/workflows/:id/attributes': async (req) => {
      const attributes = await engine.getAttributes(req.params.id);
      if (!attributes) return new Response('Not found', { status: 404 });
      return Response.json(attributes);
    },

    'PATCH /api/v1/workflows/:id/attributes': async (req) => {
      const attributes = await req.json();
      await engine.setAttributes(req.params.id, attributes);
      return Response.json({ updated: true });
    },

    // Synchronous Updates
    'POST /api/v1/workflows/:id/update/:name': async (req) => {
      const { payload, timeout, idempotencyKey } = await req.json();
      try {
        const result = await engine.update(req.params.id, req.params.name, payload, {
          timeout: timeout ?? 30_000,
          idempotencyKey,
        });
        return Response.json({ result });
      } catch (error) {
        if (error instanceof UpdateTimeoutError) {
          return Response.json({ error: 'timeout', updateId: error.updateId }, { status: 408 });
        }
        throw error;
      }
    },

    'GET /api/v1/updates/:updateId': async (req) => {
      const response = await engine.getUpdateResponse(req.params.updateId);
      if (!response) return Response.json({ status: 'pending' }, { status: 202 });
      return Response.json({ status: 'completed', result: response.result, error: response.error });
    },

    'GET /api/v1/workflows': async (req) => {
      const url = new URL(req.url);
      const filter: ListFilter = {
        status: url.searchParams.get('status'),
        type: url.searchParams.get('type'),
        limit: parseInt(url.searchParams.get('limit') ?? '50'),
        cursor: url.searchParams.get('cursor'),
        attributes: [],
      };
      // Parse attribute filters: ?attr.customerId=abc&attr.priority.gte=8
      for (const [param, value] of url.searchParams) {
        if (!param.startsWith('attr.')) continue;
        const parts = param.slice(5).split('.');
        const key = parts[0];
        const operator = parts[1] ?? 'eq';
        const existing = filter.attributes!.find((a) => a.key === key) ?? { key };
        if (!filter.attributes!.includes(existing)) filter.attributes!.push(existing);
        switch (operator) {
          case 'eq':
            existing.value = value;
            break;
          case 'gte':
            existing.gte = value;
            break;
          case 'lte':
            existing.lte = value;
            break;
          case 'gt':
            existing.gt = value;
            break;
          case 'lt':
            existing.lt = value;
            break;
        }
      }
      const result = await engine.list(filter);
      return Response.json(result);
    },

    'GET /api/v1/reviews': async (req) => {
      const reviews = await engine.listReviews({
        status: req.query.status,
        workflowId: req.query.workflowId,
        reviewType: req.query.reviewType,
      });
      return Response.json(reviews);
    },

    'GET /api/v1/workflows/:id/review/:reviewId': async (req) => {
      // getReview() lives on HumanReviewCoordinator, not Engine directly
      const reviews = await engine.listReviews({ workflowId: req.params.id });
      const review = reviews.find(
        (r) => r.reviewId === req.params.reviewId && r.workflowId === req.params.id,
      );
      if (!review) return new Response('Not found', { status: 404 });
      return Response.json(review);
    },

    'POST /api/v1/reviews/:reviewId/decision': async (req) => {
      const { decision, reviewer, feedback } = await req.json();
      await engine.submitReview(req.params.reviewId, {
        decision,
        reviewer,
        feedback,
      });
      return Response.json({ submitted: true });
    },

    // Health + Metrics
    'GET /v1/health': () => Response.json({ status: 'ok' }),
    'GET /v1/metrics': async () =>
      new Response(await engine.metrics(), {
        headers: { 'Content-Type': 'text/plain' },
      }),

    // Dashboard (embedded SPA) — mounted at its specific top-level page
    // routes, never a blanket `/*` (which would shadow the API, since Bun
    // matches the `routes` map before the `fetch` fallback).
    '/': (req) => new Response(Bun.file(dashboardHTML)),
    '/workflows': (req) => new Response(Bun.file(dashboardHTML)),
    '/workflows/*': (req) => new Response(Bun.file(dashboardHTML)),
    '/reviews': (req) => new Response(Bun.file(dashboardHTML)),
    '/workers': (req) => new Response(Bun.file(dashboardHTML)),
  },

  // WebSocket upgrade handling
  async fetch(req, server) {
    const url = new URL(req.url);

    // Worker task stream
    if (url.pathname.match(/^\/v1\/tasks\/[\w-]+\/stream$/)) {
      const queue = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'worker', queue } })) return;
    }

    // Workflow observation stream
    if (url.pathname.match(/^\/v1\/workflows\/[\w-]+\/watch$/)) {
      const id = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'watch', workflowId: id } })) return;
    }

    // Token streaming
    if (url.pathname.match(/^\/v1\/workflows\/[\w-]+\/stream$/)) {
      const id = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'tokens', workflowId: id } })) return;
    }

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { type } = ws.data;
      if (type === 'worker') ws.subscribe(`tasks:${ws.data.queue}`);
      if (type === 'watch') ws.subscribe(`events:${ws.data.workflowId}`);
      if (type === 'tokens') ws.subscribe(`tokens:${ws.data.workflowId}`);
    },
    message(ws, msg) {
      /* task completion from workers */
    },
    close(ws) {
      /* cleanup subscriptions */
    },
  },
});
```

> **Note the `ws.subscribe()` / `ws.publish()` pattern.** Bun's WebSocket server has built-in pub/sub — you don't need Redis or any external message broker. `ws.subscribe("events:wf-abc")` means this connection receives any message published to that topic. This is how we fan out workflow events to multiple observers without maintaining subscriber lists ourselves.

### 11. Remote Workers

In library mode, workflows and activities run in-process via Web Workers. In server mode, **remote workers** connect to the Weft server over WebSocket and execute activities on separate machines or processes — the same model Temporal uses. This is how you scale activity execution horizontally: the Weft server owns scheduling, checkpointing, and coordination; remote workers own compute.

#### Activity Registration and Connection

A remote worker is a standalone process that connects to a Weft server, declares which task queue it serves and which activities it can execute, then loops waiting for tasks. The worker registers its activity functions locally — the server never sees or evaluates user code.

```typescript
// my-worker.ts — runs as a separate process, connects to a Weft server
import { RemoteWorker } from '@lostgradient/weft';

import { charge } from './activities/charge.ts';
import { ship } from './activities/ship.ts';
import { sendEmail } from './activities/email.ts';

const worker = new RemoteWorker({
  serverUrl: 'ws://weft-server:7233/api/v1/tasks/default/stream',
  queue: 'default',
  identity: `worker-${crypto.randomUUID()}`, // unique per process
  concurrency: 10, // max simultaneous activities
  activities: { charge, ship, sendEmail }, // name → function map
});

await worker.run(); // connects, registers, begins processing tasks
```

```bash
# Run 3 workers on different machines, all serving the same queue
bun run my-worker.ts  # machine A
bun run my-worker.ts  # machine B
bun run my-worker.ts  # machine C
```

The server doesn't need to know about workers in advance. Workers are ephemeral — they connect, process tasks, and can disconnect at any time. The server detects disconnection and reassigns in-flight tasks.

#### Task Claiming Protocol

Task dispatch is **server-push over WebSocket**, not client-poll. This eliminates the polling overhead and latency that come with pull-based models. The protocol works as follows:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Worker connects: WS /api/v1/tasks/:queue/stream                 │
│ 2. Worker sends REGISTER: { identity, activities, concurrency } │
│ 3. Server tracks worker capacity (concurrency - in_flight)      │
│ 4. Server pushes TASK to worker when capacity > 0               │
│ 5. Worker sends RESULT (success/failure) when done              │
│ 6. Server updates capacity, may push next task immediately      │
└─────────────────────────────────────────────────────────────────┘
```

**No race conditions.** The server assigns each task to exactly one worker. Unlike a pull model where multiple workers poll and race to claim, the server makes the assignment decision and pushes to a single connection. If the chosen worker disconnects before acknowledging, the server reassigns.

```typescript
// ─── WebSocket message types (server ↔ worker) ───

// Worker → Server
type WorkerMessage =
  | { type: 'register'; identity: string; activities: string[]; concurrency: number }
  | {
      type: 'result';
      operationId: string;
      outcome: 'completed' | 'failed';
      value?: unknown;
      error?: string;
    }
  | { type: 'heartbeat'; operationId: string; details?: unknown }
  | { type: 'updateResult'; updateId: string; result?: unknown; error?: string };

// Server → Worker
type ServerMessage =
  | {
      type: 'task';
      operationId: string;
      activityName: string;
      input: unknown;
      attempt: number;
      headers: Record<string, string>;
    }
  | { type: 'cancel'; operationId: string; reason: string }
  | { type: 'shutdown'; reason: string; gracePeriodMs: number }
  | { type: 'update'; updateId: string; name: string; payload: unknown };
```

**Queue-based routing.** When a workflow dispatches an activity with `yield* ctx.run(charge, order, { queue: "payments" })`, the server enqueues the task on the `"payments"` queue. Only workers subscribed to that queue receive it. This lets you route CPU-heavy work to beefy machines, GPU work to GPU nodes, and so on — without the workflow knowing or caring about the topology.

#### Visibility Timeout and Heartbeats

When the server pushes a task to a worker, it starts a **visibility timeout** — a deadline by which the worker must either complete the task or send a heartbeat proving it's still working. If the timeout expires with no heartbeat and no result, the server assumes the worker is dead and reassigns the task to another worker.

```typescript
// Server-side: visibility timeout management
const VISIBILITY_TIMEOUT_MS = 30_000; // 30 seconds default, configurable per activity

function dispatchTask(worker: WebSocket, operation: Operation) {
  worker.send(
    JSON.stringify({
      type: 'task',
      operationId: operation.id,
      activityName: operation.activityName,
      input: operation.input,
      attempt: operation.attempt,
    }),
  );

  // Start the visibility clock — stored in the database, not in memory,
  // so it survives server restarts too
  storage.batch([
    {
      type: 'put',
      key: `op:inflight:${operation.id}`,
      value: encode({
        workerId: worker.data.identity,
        assignedAt: Date.now(),
        visibilityDeadline: Date.now() + VISIBILITY_TIMEOUT_MS,
      }),
    },
  ]);
}

// Scheduler periodically scans for expired visibility timeouts
async function reclaimExpiredTasks() {
  for await (const [key, value] of storage.scan('op:inflight:')) {
    const info = decode(value);
    if (Date.now() > info.visibilityDeadline) {
      // Worker missed the deadline — reassign the task
      await requeueOperation(info);
      await storage.delete(key);
    }
  }
}
```

**Worker-side heartbeats.** For long-running activities (large file uploads, ML inference, multi-step API calls), the worker sends periodic heartbeats to extend the visibility deadline. Heartbeats can carry progress details that are queryable from the workflow.

```typescript
// Worker-side: heartbeat during a long activity
async function executeWithHeartbeat(
  ws: WebSocket,
  operationId: string,
  fn: Function,
  input: unknown,
  heartbeatIntervalMs: number = 10_000,
) {
  const controller = new AbortController();

  // Heartbeat loop — runs in parallel with the activity
  const heartbeatInterval = setInterval(() => {
    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        operationId,
        details: { timestamp: Date.now() },
      }),
    );
  }, heartbeatIntervalMs);

  // Listen for cancellation from server
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'cancel' && msg.operationId === operationId) {
      controller.abort(new Error(msg.reason));
    }
  });

  try {
    const result = await fn(input, { signal: controller.signal });
    return { outcome: 'completed' as const, value: result };
  } catch (error) {
    return { outcome: 'failed' as const, error: String(error) };
  } finally {
    clearInterval(heartbeatInterval);
  }
}
```

Each heartbeat resets the visibility deadline on the server:

```typescript
// Server-side: heartbeat extends the deadline
function handleHeartbeat(operationId: string, details?: unknown) {
  storage.put(
    `op:inflight:${operationId}`,
    encode({
      ...existingInfo,
      visibilityDeadline: Date.now() + VISIBILITY_TIMEOUT_MS,
      lastHeartbeat: Date.now(),
      heartbeatDetails: details,
    }),
  );
}
```

```typescript partial
const activityProgressQuery = query<void, { timestamp: number }>('activityProgress');
```

Heartbeat details are queryable from the workflow via `handle.query(activityProgressQuery)`, enabling progress UIs without custom plumbing.

#### Worker Identity and Routing

Every remote worker has a unique **identity** string (defaulting to a UUID). The server uses identity for:

- **Logging and debugging.** Every task assignment is logged with the worker identity, so you can trace exactly which machine ran which activity.
- **Sticky routing (opt-in).** For workflows that benefit from cache locality — e.g., an ML workflow where the first activity loads a model into GPU memory — the server can prefer routing subsequent activities from the same workflow to the same worker. This is opt-in via `ctx.run(fn, args, { sticky: true })`.
- **Graceful shutdown.** When a worker receives a `shutdown` message (e.g., during a rolling deploy), it stops accepting new tasks, finishes in-flight work, then disconnects. The server tracks which workers are draining and avoids routing to them.

```typescript
// Server-side: worker tracking
class WorkerRegistry {
  #workers = new Map<string, WorkerInfo>();

  register(ws: WebSocket, identity: string, activities: string[], concurrency: number) {
    this.#workers.set(identity, {
      ws,
      identity,
      activities: new Set(activities),
      concurrency,
      inFlight: 0,
      draining: false,
    });
  }

  // Find the best worker for a task on a given queue
  route(activityName: string, stickyWorkerId?: string): WorkerInfo | undefined {
    // Prefer sticky worker if healthy and available
    if (stickyWorkerId) {
      const sticky = this.#workers.get(stickyWorkerId);
      if (
        sticky &&
        !sticky.draining &&
        sticky.inFlight < sticky.concurrency &&
        sticky.activities.has(activityName)
      ) {
        return sticky;
      }
    }

    // Otherwise: least-loaded worker that supports this activity
    let best: WorkerInfo | undefined;
    for (const worker of this.#workers.values()) {
      if (worker.draining) continue;
      if (!worker.activities.has(activityName)) continue;
      if (worker.inFlight >= worker.concurrency) continue;
      if (!best || worker.inFlight < best.inFlight) {
        best = worker;
      }
    }
    return best;
  }

  deregister(identity: string) {
    this.#workers.delete(identity);
  }
}
```

#### Retry After Worker Failure

When a remote worker crashes (WebSocket closes unexpectedly) or misses its visibility timeout, the server must recover gracefully. The process is:

1. **Detect failure.** Either the WebSocket `close` event fires (immediate detection) or the visibility timeout expires (delayed detection for network partitions).
2. **Mark in-flight tasks as reclaimable.** The server scans `op:inflight:*` for tasks assigned to the dead worker and moves them back to the task queue. The `attempt` counter increments.
3. **Respect retry policy.** Each activity has a retry policy (`maxAttempts`, `initialBackoff`, `backoffMultiplier`, `maxBackoff`, `nonRetryableErrors`). If the attempt count exceeds `maxAttempts`, the activity is marked as permanently failed and the workflow is notified.
4. **Dispatch to another worker.** The requeued task goes through normal routing — any healthy worker on the same queue can pick it up.

```typescript
// Server-side: handle worker disconnection
function handleWorkerDisconnect(identity: string) {
  // Find all tasks assigned to this worker
  for (const [key, value] of storage.scanSync('op:inflight:')) {
    const info = decode(value);
    if (info.workerId !== identity) continue;

    const operationId = key.slice('op:inflight:'.length);
    const operation = decode(await storage.get(`op:pending:${operationId}`));

    if (operation.attempt >= operation.retryPolicy.maxAttempts) {
      // Exhausted retries — fail permanently
      storage.batch([
        { type: 'delete', key },
        {
          type: 'put',
          key: `op:failed:${operationId}`,
          value: encode({
            ...operation,
            error: `Worker ${identity} disconnected, max retries (${operation.retryPolicy.maxAttempts}) exhausted`,
          }),
        },
      ]);
      engine.dispatchEvent(
        new ActivityFailedEvent(operationId, operation.workflowId, operation.activityName),
      );
    } else {
      // Requeue with incremented attempt and backoff delay
      const backoff = calculateBackoff(operation.attempt, operation.retryPolicy);
      storage.batch([
        { type: 'delete', key },
        {
          type: 'put',
          key: `op:${operation.queue}:${Date.now() + backoff}:${operationId}`,
          value: encode({
            ...operation,
            attempt: operation.attempt + 1,
          }),
        },
      ]);
    }
  }

  workerRegistry.deregister(identity);
}
```

> **Key invariant:** A task is always in exactly one of three states: queued (waiting for a worker), in-flight (assigned to a worker with a visibility deadline), or resolved (completed or permanently failed). There is no state where a task is lost. The visibility timeout is the mechanism that prevents "assigned but forgotten" — the server-side equivalent of a dead letter queue.

#### Long-Poll Fallback

For environments where WebSocket connections aren't possible (restrictive proxies, serverless functions, simple scripts), the server provides an HTTP long-poll endpoint. The worker holds a `GET` request open until a task is available or the timeout expires.

```typescript
// Server route: long-poll task claiming
"GET /api/v1/tasks/:queue": async (req) => {
  const queue = req.params.queue;
  const url = new URL(req.url);
  const timeout = parseInt(url.searchParams.get("timeout") ?? "30000");
  const activities = url.searchParams.get("activities")?.split(",") ?? [];
  const identity = url.searchParams.get("identity") ?? crypto.randomUUID();

  // Check for an immediately available task
  const task = await claimNextTask(queue, activities, identity);
  if (task) return Response.json(task);

  // No task available — hold the connection until one arrives or timeout
  const { promise, resolve } = Promise.withResolvers<Response>();

  const signal = AbortSignal.timeout(timeout);
  const unsubscribe = taskNotifier.subscribe(queue, (task) => {
    if (activities.length && !activities.includes(task.activityName)) return;
    resolve(Response.json(task));
  });

  signal.addEventListener("abort", () => {
    resolve(Response.json({ type: "no_tasks" }, { status: 204 }));
  });

  try {
    return await promise;
  } finally {
    unsubscribe();
  }
},

// Result submission via POST (pairs with long-poll)
"POST /api/v1/tasks/:queue/result": async (req) => {
  const body = await req.json();
  await handleTaskResult(body.operationId, body.outcome, body.value, body.error);
  return Response.json({ accepted: true });
},
```

```typescript
// Minimal long-poll worker client — works anywhere fetch() works
async function longPollWorker(
  serverUrl: string,
  queue: string,
  activities: Record<string, Function>,
) {
  const activityNames = Object.keys(activities).join(',');

  while (true) {
    const response = await fetch(
      `${serverUrl}/api/v1/tasks/${queue}?timeout=30000&activities=${activityNames}`,
    );

    if (response.status === 204) continue; // No tasks, poll again

    const task = await response.json();
    const fn = activities[task.activityName];

    let outcome: 'completed' | 'failed';
    let value: unknown;
    let error: string | undefined;

    try {
      value = await fn(task.input);
      outcome = 'completed';
    } catch (err) {
      outcome = 'failed';
      error = String(err);
    }

    await fetch(`${serverUrl}/api/v1/tasks/${queue}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: task.operationId, outcome, value, error }),
    });
  }
}
```

The long-poll client is intentionally simple — it can run in Deno, Cloudflare Workers, Node.js, or even a browser. The tradeoff versus WebSocket is higher latency (up to the poll timeout) and no server-push cancellation. For most use cases, WebSocket is preferred; long-poll is the compatibility escape hatch.

### 12. Additional Platform Patterns

#### Promise.withResolvers() Throughout

```typescript
// Before: manual Promise construction
const signal = new Promise((resolve, reject) => {
  signalResolvers.set(key, { resolve, reject });
});

// After: Promise.withResolvers() — cleaner, no closure scope issues
const { promise, resolve, reject } = Promise.withResolvers<SignalPayload>();
signalResolvers.set(key, { resolve, reject });
const payload = await promise;
```

#### Transferable Objects in Worker Communication

```typescript
// When sending checkpoints to/from Web Workers, TRANSFER the ArrayBuffer
// instead of copying it. This is zero-copy — O(1) instead of O(n).

const checkpointBuffer = serializeCheckpoint(generatorState);

worker.postMessage(
  {
    type: 'run',
    workflowId: id,
    checkpoint: checkpointBuffer,
  },
  [checkpointBuffer],
); // Transfer list: ownership moves to worker, no copy
// checkpointBuffer is now detached (zero bytes) in the sender — enforced by the platform
```

#### AbortSignal.any() for Compound Cancellation

```typescript
// Activity execution has multiple cancellation sources:
// 1. Workflow-level cancellation
// 2. Activity-level timeout
// 3. Engine shutdown
// 4. Any caller-supplied signal (e.g. a userland budget guard)

async function executeActivity(
  fn: Function,
  input: unknown,
  signals: {
    workflow: AbortSignal;
    timeout: AbortSignal;
    shutdown: AbortSignal;
    extra?: AbortSignal; // optional caller-supplied signal, not an engine concept
  },
): Promise<unknown> {
  // AbortSignal.any() fires when ANY of the signals abort
  const combined = AbortSignal.any([
    signals.workflow,
    signals.timeout,
    signals.shutdown,
    ...(signals.extra ? [signals.extra] : []),
  ]);

  return await fn(input, { signal: combined });
}
```

#### AbortSignal.timeout() for Durable Timeouts

```typescript
// For activity-level timeouts — cleaner than manual setTimeout + AbortController
const result = await fetch(url, {
  signal: AbortSignal.timeout(30_000), // 30-second hard timeout
});
```

#### Private Fields (#) for True Encapsulation

All internal state uses `#private` fields — not `_underscore` convention. Private fields cannot be accessed from outside the class even with bracket notation or `Object.keys()`. This prevents users from depending on implementation details.

```typescript
class Engine extends EventTarget implements Disposable {
  // These are truly inaccessible from outside
  #storage: Storage;
  #workers: WorkerPool;
  #scheduler: Scheduler;
  #registry: ActivityRegistry;
  #handleRegistry: HandleRegistry;
  #checkpointCache: CheckpointCache;
  #abortController: AbortController;

  // Public API only exposes what users need
  get isRunning(): boolean { ... }
  start(type: string, input: unknown): Promise<WorkflowHandle> { ... }
  register(name: string, fn: WorkflowFunction): void { ... }
}
```

### 13. Workflow Versioning

When you deploy new workflow code while workflows are in-flight, you need to answer: which version of the code runs when a checkpointed workflow resumes?

Weft's checkpoint model makes this fundamentally simpler than Temporal. Since we resume from a checkpoint (not replay from the beginning), the compatibility requirement is explicit: the stored workflow version must match the registered version, the recorded version tuple must not drift, and the code must still understand the checkpoint shape at the specific step where execution paused. No patching API. No version gates in workflow code.

#### Registration API

```typescript
interface WorkflowRegistration {
  name: string;
  version: string; // Semver string, e.g., "2.0.0"
  handler: WorkflowFunction;
}

// Full registration with an explicit recovery boundary.
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
});

// Shorthand still works — defaults to version "0.0.0".
engine.register('order', orderWorkflow);
```

#### Resume Logic

1. **Version pinned at start.** When `engine.start()` is called, the workflow state blob records the version of the currently registered handler.
2. **On resume, versions are compared.** If they match and the version tuple has not drifted: resume normally. If they differ: throw `VersionMismatchError`.
3. **Checkpoint shape remains the operator's responsibility.** The new code must understand the stored checkpoint at the paused step.
4. **Incompatible checkpoint = clear error.** Version and tuple mismatches fail with `VersionMismatchError` that includes both versions and the workflow ID.

#### Why Simpler Than Temporal

In Temporal, version changes require `workflow.getVersion()` / `patched()` because replay must follow the exact same code path as the original execution. Every branching point needs a version gate. In Weft:

- No replay means no code-path determinism requirement.
- The checkpoint captures the complete state at the pause point.
- Recovery starts from the checkpoint instead of replaying the full event history.
- Developers think about "can my new code resume this checkpoint under the same recorded version tuple?" rather than "is my new code deterministically compatible with the old event history?"

#### Usage Examples

```typescript
// Simple case: checkpoint shape did not change, just the logic after the current step.
engine.register('order', {
  version: '1.0.0',
  handler: orderWorkflowV2,
});

// Breaking case: V2 added a required `region` field.
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
  // Running v1 checkpoints stop with VersionMismatchError until resolved.
});
```

### 14. Workflow-Level Timeouts

Activity timeouts exist but there is no mechanism to cap the total wall-clock time of an entire workflow execution. This is critical for SLA enforcement, runaway workflow detection, and resource budgeting.

#### API

```typescript
const handle = await engine.start('order', orderData, {
  executionTimeout: '24 hours',
});

try {
  const result = await handle.result();
} catch (error) {
  if (error instanceof WorkflowTimeoutError) {
    console.log(`Workflow timed out: ${error.timeoutType}`); // "execution" or "run"
  }
}
```

**Context access for runtime decisions:**

```typescript
interface Context {
  /** AbortSignal that fires when the workflow's timeout expires or cancel() is called. */
  readonly signal: AbortSignal;
  /** Remaining time before the execution timeout fires (milliseconds). */
  readonly executionTimeRemaining: number;
}

async function* orderWorkflow(ctx: Context, order: Order) {
  const payment = yield* ctx.run(charge, order);

  // Check if we have enough time for the slow path
  if (ctx.executionTimeRemaining > 60_000) {
    yield* ctx.run(enrichOrderData, order);
  }

  yield* ctx.run(ship, { order, payment });
  return { payment, shipped: true };
}
```

#### Mechanism

1. **Deadline stored in `wf:{id}` and indexed at `wf-deadline:{deadline}:{workflowId}`.** The scheduler scans deadline keys sorted by timestamp — only needs to check up to `Date.now()`.
2. **Timeout fires mid-activity.** The scheduler fires the workflow's `AbortController`, which cascades to all in-flight activities via the existing `AbortSignal.any()` compound cancellation pattern. The workflow is marked as `"timed-out"` and a `WorkflowTimedOutEvent` is dispatched.
3. **Cleanup.** Deadline keys are deleted when a workflow reaches any terminal state.

The `ctx.signal` property exposes the combined timeout + cancellation signal. Activities that already accept `{ signal }` automatically respect workflow timeouts with no code changes.

### 15. Search Attributes (Advanced Visibility)

Search attributes let workflows set custom indexed metadata that's queryable from the list API. The design uses KV-based secondary indexes that work identically on SQLite, LMDB, and IndexedDB — no SQL required.

#### Context API

```typescript
interface Context {
  /** Set a single search attribute. Persisted at next checkpoint boundary. */
  setAttribute(key: string, value: SearchAttributeValue): void;
  /** Set multiple attributes. Merge semantics: unmentioned keys are preserved. */
  setAttributes(attributes: SearchAttributes): void;
  /** Read the current value of an attribute. */
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined;
  /** Read all attributes. */
  getAttributes(): Readonly<SearchAttributes>;
}

type AttributeValue = string | number | boolean | Date;
type SearchAttributeValue = AttributeValue | string[]; // string[] for multi-value tags

type SearchAttributeDefinition =
  | { type: 'string'; format?: 'date-time' }
  | { type: 'number' | 'integer' | 'boolean' }
  | { type: 'array'; items: { type: 'string' } };
```

`setAttribute` and `setAttributes` are **synchronous in-workflow calls** — they do not yield. Persistence happens at the next checkpoint boundary, batched with the checkpoint write. This keeps the hot path to a single `batch()` operation.

#### Schema at Registration

```typescript
engine.register('order', orderWorkflow, {
  searchAttributes: {
    customerId: { type: 'string' },
    orderTotal: { type: 'number' },
    region: { type: 'string' },
    priority: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
});
```

Unknown attribute keys are rejected at set time. This prevents typos and enforces a discoverable schema.

#### Usage

```typescript
async function* orderWorkflow(ctx: Context, order: Order) {
  ctx.setAttributes({
    customerId: order.customerId,
    region: order.region,
    orderTotal: order.total,
    tags: ['new', 'needs-review'],
  });

  const payment = yield* ctx.run(charge, order);

  ctx.setAttribute('tags', ['charged', 'processing']);
  ctx.setAttribute('paymentId', payment.id);

  const shipment = yield* ctx.run(ship, { order, payment });

  ctx.setAttribute('tags', ['completed', 'shipped']);
  ctx.setAttribute('trackingNumber', shipment.tracking);

  return { payment, shipment };
}
```

**Querying:**

```typescript
// Find all workflows for a specific customer
const result = await engine.list({
  attributes: [{ key: 'customerId', value: 'cust-123' }],
});

// Find high-priority orders in a specific region
const result = await engine.list({
  type: 'order',
  attributes: [
    { key: 'region', value: 'us-east' },
    { key: 'priority', gte: 8 },
  ],
});
```

**HTTP API:**

```
GET /api/v1/workflows?attr.customerId=cust-123
GET /api/v1/workflows?attr.region=us-east&attr.priority.gte=8
GET /api/v1/workflows?attr.orderTotal.gte=100&attr.orderTotal.lte=500
```

#### Index Mechanism

**Forward map:** `attr:{workflow_id}` stores all attributes for a workflow as a single blob.

**Inverted index:** `idx:{attr_name}:{encoded_value}:{workflow_id}` — one entry per attribute value per workflow. A range scan on `idx:region:s:us-east:` returns all matching workflow IDs.

**Sortable value encoding:** Index keys must sort correctly as strings so range scans produce correct results:

```typescript
function encodeAttributeValue(value: AttributeValue): string {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') {
    // IEEE 754 float-to-sortable-string: ensures -1 < 0 < 1 < 100 lexicographically
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value);
    const bytes = new Uint8Array(buffer);
    if (value >= 0) bytes[0] ^= 0x80;
    else for (let i = 0; i < 8; i++) bytes[i] ^= 0xff;
    return `n:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof value === 'boolean') return `b:${value ? '1' : '0'}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  throw new Error(`Unsupported attribute value type: ${typeof value}`);
}
```

**String-array attributes:** Each element gets its own index entry. Setting `tags: ["charged", "processing"]` creates `idx:tags:s:charged:{id}` and `idx:tags:s:processing:{id}`.

**Atomic updates at checkpoint boundary:** The engine diffs previous vs current attributes, computing add/delete index operations, and writes everything in the same `batch()` call as the checkpoint. No partial index states.

**External mutation:** `handle.setAttributes()` and `PATCH /api/v1/workflows/:id/attributes` allow setting attributes from outside the workflow. Index updates happen atomically.

### 16. Synchronous Updates

Signals are fire-and-forget — the caller sends a message and doesn't wait for the workflow to process it. Updates are **request-response** — the caller blocks until the workflow processes the message and returns a result.

Use case: "Validate this coupon code against the current cart state before accepting it." The caller needs the workflow to inspect its internal state and respond with a yes/no.

#### Two Patterns

**Callback-style (`ctx.onUpdate`):** Register a handler that runs at any checkpoint boundary whenever an update of that name arrives. The handler is a plain function (not a generator) — it cannot yield. It can read/modify workflow state via closure over local variables.

```typescript
async function* cartWorkflow(ctx: Context, cart: Cart) {
  let appliedCoupons: string[] = [];
  let cartTotal = cart.total;

  ctx.onUpdate('validate_coupon', (payload: { code: string }) => {
    if (appliedCoupons.includes(payload.code)) {
      return { valid: false, reason: 'Coupon already applied' };
    }
    const discount = lookupCoupon(payload.code, cartTotal);
    if (!discount) {
      return { valid: false, reason: 'Invalid coupon code' };
    }
    appliedCoupons.push(payload.code);
    cartTotal -= discount.amount;
    return { valid: true, discount: discount.amount, newTotal: cartTotal };
  });

  ctx.onUpdate('get_cart_state', () => ({
    total: cartTotal,
    appliedCoupons,
    itemCount: cart.items.length,
  }));

  yield* ctx.waitForSignal('checkout');
  const payment = yield* ctx.run(charge, { amount: cartTotal });
  return { payment, total: cartTotal };
}
```

**Yield-style (`ctx.waitForUpdate`):** Explicitly suspends the workflow until a specific update arrives. Returns `{ payload, respond }` where `respond()` sends the result back.

```typescript
async function* approvalWorkflow(ctx: Context, document: Document) {
  const prepared = yield* ctx.run(prepareForReview, document);

  const { payload, respond } = yield* ctx.waitForUpdate<ReviewDecision>('review_decision');

  if (payload.approved) {
    respond({ accepted: true, message: 'Document will be published.' });
    yield* ctx.run(publish, prepared);
  } else {
    respond({ accepted: true, message: 'Document returned for revision.' });
    yield* ctx.run(notifyAuthor, { document, feedback: payload.feedback });
  }
}
```

#### Caller API

```typescript
const handle = engine.getHandle('wf-cart-abc');
const validateCoupon = update<{ code: string }, ValidationResult>('validate_coupon');

// Blocks until the workflow processes the update and responds
const result = await handle.update(
  validateCoupon,
  { code: 'SAVE20' },
  {
    timeout: 5000, // 5 seconds max wait
  },
);

if (result.valid) {
  showToast(`Coupon applied! New total: $${result.newTotal}`);
} else {
  showError(result.reason);
}
```

#### Mechanism

1. **Caller writes update request** to `upd:{workflowId}:{updateId}`.
2. **Engine detects pending updates** at the checkpoint boundary (same phase as pending signals). For `onUpdate` handlers: runs the handler, collects the result. For `waitForUpdate`: resumes the generator with `{ payload, respond }`.
3. **Response written atomically** with the checkpoint: `batch([delete upd:..., put upr:..., put wf:...:ckpt])`.
4. **Caller notified** via `BroadcastChannel` (`update:completed` message). The caller's `Promise.withResolvers` resolves without polling.
5. **Timeout handling.** The caller races against `AbortSignal.timeout()`. On timeout: `UpdateTimeoutError` with the `updateId`. The update is still pending — the caller can poll `GET /api/v1/updates/:updateId` later to retrieve the eventual response.
6. **Durability.** If the server crashes between receiving the request and delivering the response, the update request is already in storage. After recovery, the workflow processes it and writes the response. The caller retrieves via the poll endpoint.

**Idempotency:** An optional `idempotencyKey` maps to the `updateId` via `upk:{workflowId}:{key}`. Duplicate requests return the existing response.

**Response cleanup:** `upr:*` entries are deleted after a configurable TTL (default 5 minutes) to prevent unbounded storage growth.

### 17. Interceptors / Middleware

Interceptors are composable hooks that wrap workflow context operations for cross-cutting concerns. They are the foundation for observability (section 18), and can be used independently for validation, encryption, auth propagation, and more.

#### Design Principles

1. **Interceptors wrap context operations, not the generator itself.** Each `ctx.run()`, `ctx.sleep()`, etc. passes through a chain of interceptors. Workflow code is never modified.
2. **Interceptors compose via `next()` delegation.** Like Koa middleware. Each interceptor can modify inputs, modify outputs, handle errors, or skip `next()` entirely.
3. **Registered on the Engine.** Not on individual workflows.
4. **Two categories:** Workflow interceptors (wrap ctx operations in the workflow Worker) and activity interceptors (wrap activity execution in the activity Worker).

#### Interfaces

```typescript
// ─── Workflow Interceptor ───
interface WorkflowInterceptor {
  activity?<TInput, TOutput>(
    input: ActivityInterception<TInput>,
    next: (input: ActivityInterception<TInput>) => Generator<unknown, TOutput>,
  ): Generator<unknown, TOutput>;

  sleep?(
    input: SleepInterception,
    next: (input: SleepInterception) => Generator<unknown, void>,
  ): Generator<unknown, void>;

  waitForSignal?(
    input: SignalInterception,
    next: (input: SignalInterception) => Generator<unknown, unknown>,
  ): Generator<unknown, unknown>;

  workflowStart?(
    input: WorkflowStartInterception,
    next: (input: WorkflowStartInterception) => Generator<unknown, unknown>,
  ): Generator<unknown, unknown>;

  signalReceived?(
    input: SignalReceivedInterception,
    next: (input: SignalReceivedInterception) => void,
  ): void;

  query?(input: QueryInterception, next: (input: QueryInterception) => unknown): unknown;
}

// ─── Activity Interceptor ───
interface ActivityInterceptor {
  execute?<TInput, TOutput>(
    input: ActivityExecutionInterception<TInput>,
    next: (input: ActivityExecutionInterception<TInput>) => Promise<TOutput>,
  ): Promise<TOutput>;
}
```

All hooks are optional. Workflow interceptor hooks return generators (preserving `yield*` checkpoint semantics). Activity interceptor hooks return Promises (matching async activity execution).

#### Interception Context Types

```typescript
interface ActivityInterception<TInput = unknown> {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly activityName: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly queue: string;
  input: TInput; // mutable: interceptors can transform input
  headers: Map<string, string>; // propagated metadata (trace context, scoped claims)
}

interface SleepInterception {
  readonly workflowId: string;
  readonly workflowType: string;
  duration: string | number; // mutable
}

interface WorkflowStartInterception {
  readonly workflowId: string;
  readonly workflowType: string;
  input: unknown; // mutable
  headers: Map<string, string>;
}

interface ActivityExecutionInterception<TInput = unknown> {
  readonly activityName: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  input: TInput;
  headers: Map<string, string>; // received from workflow-side propagation
}
```

#### The `headers` Map: Cross-Boundary Metadata Propagation

The `headers` field is a `Map<string, string>` that travels with each operation across thread and network boundaries:

- Workflow interceptor sets headers on `ActivityInterception` before calling `next()`.
- Engine serializes headers into `postMessage` (local Workers) or the WebSocket `task` message (remote Workers).
- Activity interceptor reads headers from `ActivityExecutionInterception`.

This is how trace context (W3C `traceparent`/`tracestate`), short-lived authorization claims, and opaque credential references propagate without special-casing any of them. Do not put raw bearer tokens, encryption keys, or long-lived secrets in interceptor headers; resolve those inside the worker after validating the propagated claim.

#### Composition

Interceptors chain in registration order (first registered = outermost):

```typescript
function composeActivityHooks(
  interceptors: WorkflowInterceptor[],
  final: (input: ActivityInterception) => Generator<unknown, unknown>,
): (input: ActivityInterception) => Generator<unknown, unknown> {
  let chain = final;
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i];
    if (!interceptor.activity) continue;
    const next = chain;
    chain = (input) => interceptor.activity!(input, next);
  }
  return chain;
}
```

The chain is constructed once per engine, not per operation. Zero overhead when no interceptors are registered.

#### Code Examples

**Input validation interceptor:**

```typescript
import { z, type ZodSchema } from 'zod';

function validationInterceptor(schemas: Record<string, ZodSchema>): WorkflowInterceptor {
  return {
    *activity(input, next) {
      const schema = schemas[input.activityName];
      if (schema) input.input = schema.parse(input.input);
      return yield* next(input);
    },
  };
}

engine.addInterceptor(
  validationInterceptor({
    charge: z.object({ amount: z.number().positive(), currency: z.string().length(3) }),
  }),
);
```

**Encryption interceptor:**

```typescript
function encryptionInterceptor(
  encrypt: (data: unknown) => unknown,
  decrypt: (data: unknown) => unknown,
): WorkflowInterceptor {
  return {
    *activity(input, next) {
      input.input = encrypt(input.input);
      const result = yield* next(input);
      return decrypt(result);
    },
  };
}
```

#### Interceptors vs EventTarget

These systems are complementary:

- **EventTarget** is for _observation_. Listeners receive events after things happen. They cannot modify inputs, outputs, or control flow.
- **Interceptors** are for _interception_. They wrap execution, can modify inputs/outputs, can skip or retry operations, and participate in the control flow.

### 18. Observability (OpenTelemetry Integration)

Observability is implemented as a pre-built interceptor pair. It uses standard OpenTelemetry APIs (`@opentelemetry/api`) and propagates context through the interceptor `headers` mechanism.

#### Design Principles

1. **Uses `@opentelemetry/api` directly.** No custom tracing layer. The API package is a lightweight no-op unless an SDK is configured — zero overhead if you don't enable tracing.
2. **Opt-in, not built-in.** Import from `@lostgradient/weft/observability`. If you don't import it, no OpenTelemetry code is loaded.
3. **Auto-created spans** for all context operations.
4. **W3C Trace Context propagation** via the interceptor `headers` Map.

#### API

```typescript
import { createObservabilityInterceptors } from '@lostgradient/weft/observability';

interface ObservabilityOptions {
  tracerName?: string; // Defaults to "weft"
  tracerVersion?: string;
  recordPayloads?: boolean; // Record activity inputs/outputs as span attributes. Off by default.
  maxPayloadSize?: number; // Truncate recorded payloads. Default: 1024 bytes.
  attributeExtractor?: (
    interception: WorkflowStartInterception | ActivityInterception,
  ) => Record<string, string | number | boolean>;
}

function createObservabilityInterceptors(options?: ObservabilityOptions): {
  workflow: WorkflowInterceptor;
  activity: ActivityInterceptor;
};
```

#### Usage

```typescript
const { workflow, activity } = createObservabilityInterceptors();

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });
engine.addInterceptor(workflow);
engine.addActivityInterceptor(activity);

// Remote workers get the activity interceptor
const worker = new Worker({
  serverUrl: 'ws://weft-server:7233/api/v1/tasks/default/stream',
  activities: { charge, ship },
  interceptors: [activity],
});
```

#### Span Hierarchy

Each workflow execution creates a root span. Context operations create child spans:

```
workflow:order (root span)
├── activity:charge (child span)
│   └── activity:execute:charge (child span, on the worker side)
│       └── fetch POST api.stripe.com (child span, from user code)
├── sleep (child span)
├── signal:wait:approval (child span)
└── activity:ship (child span)
    └── activity:execute:ship (child span, on the worker side)
```

Child workflows use **span links** (not parent-child) because they have independent lifecycle and can outlive their parent.

#### Trace Context Flow

**Local Workers:** The workflow interceptor injects `traceparent`/`tracestate` into the `headers` Map. These travel via `postMessage` to the activity Worker. The activity interceptor extracts the context and creates a child span.

**Remote Workers:** Same mechanism, but headers travel via the WebSocket `task` message's `headers` field.

```
Workflow Worker                         Activity Worker
───────────────                         ───────────────
creates span A                          extracts traceparent from headers
injects traceparent into headers        creates span B (child of A)
yields ctx.run(...)                     executes activity function
   ──── postMessage/WebSocket ────►     any fetch() calls → child spans of B
   (includes headers map)
   ◄── result ────
span A ends                             span B ends
```

#### Structured Logging

The interceptor sets span attributes (`weft.workflow.id`, `weft.workflow.type`, `weft.activity.name`, `weft.activity.operation_id`, `weft.activity.attempt`) that any OpenTelemetry-aware logger can read. No separate logging integration needed — if your logger reads OTel context, it automatically gets correlation IDs.

#### Metrics

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('weft');

const workflowDuration = meter.createHistogram('weft.workflow.duration', { unit: 'ms' });
const activityDuration = meter.createHistogram('weft.activity.duration', { unit: 'ms' });
const activityAttempts = meter.createCounter('weft.activity.attempts');
const activeWorkflows = meter.createUpDownCounter('weft.workflow.active');
```

These OTel metrics can be exported to Prometheus via `@opentelemetry/exporter-prometheus`, replacing the hand-rolled `/v1/metrics` endpoint with a standards-based approach.

#### Composing with Other Interceptors

```typescript
engine.addInterceptor(authInterceptor); // 1. Check auth
engine.addInterceptor(validationInterceptor); // 2. Validate inputs
engine.addInterceptor(observabilityWorkflow); // 3. Trace the validated, authorized call
engine.addInterceptor(encryptionInterceptor); // 4. Encrypt before sending to worker
```

---

## Performance Profile

### Weft vs Temporal

| Dimension                | Temporal                           | Weft (SQLite)                           | Weft (LMDB)                             |
| ------------------------ | ---------------------------------- | --------------------------------------- | --------------------------------------- |
| **Recovery**             | O(n) replay                        | O(1) checkpoint                         | O(1) checkpoint                         |
| **Storage read**         | ~1ms (network)                     | ~10μs (in-process)                      | ~1μs (memory-mapped)                    |
| **Storage write**        | ~2ms (network)                     | ~20μs (WAL)                             | ~10μs (batched)                         |
| **Task claim**           | gRPC round-trip                    | 1 SQL statement                         | 1 range read + put                      |
| **Cold start**           | seconds (Go + DB pool)             | <50ms (Bun + SQLite)                    | <50ms (Bun + mmap)                      |
| **Memory / workflow**    | ~50KB (history cache)              | ~2KB (checkpoint)                       | ~2KB (checkpoint)                       |
| **Single binary?**       | No                                 | Yes                                     | No (native addon)                       |
| **Browser?**             | No                                 | No                                      | No                                      |
| **Browser (IndexedDB)?** | —                                  | Yes (same engine)                       | —                                       |
| **History growth**       | O(n) with activity count           | O(1) fixed-size                         | O(1) fixed-size                         |
| **Dev environment**      | Docker Compose (~minutes)          | `bun add @lostgradient/weft` (~seconds) | `bun add @lostgradient/weft` (~seconds) |
| **Bundle step**          | Webpack per workflow change        | None                                    | None                                    |
| **Max workflow length**  | ~50K events (then `continueAsNew`) | Unlimited                               | Unlimited                               |

### Platform Primitive Performance Wins

| Primitive                       | Performance Impact                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Transferable` in `postMessage` | Zero-copy checkpoint transfer between threads. A 10KB checkpoint moves in O(1) instead of O(n) copy.                                       |
| `WeakRef` checkpoint cache      | GC-friendly caching — memory usage stays bounded under load instead of growing linearly with workflow count.                               |
| `FinalizationRegistry`          | Automatic cleanup of dead cache entries — no periodic sweep needed, no timer overhead.                                                     |
| `Symbol.dispose` / `using`      | Deterministic resource release — prevents file handle leaks, dangling DB connections, orphaned Workers that plague long-running processes. |
| `AbortSignal.any()`             | Single signal for compound cancellation — no manual bookkeeping of multiple abort sources.                                                 |
| `structuredClone` with transfer | Zero-copy deep clone when transferring data to Workers.                                                                                    |
| `Promise.withResolvers()`       | Avoids closure allocation for deferred promises. Marginal per-call, significant at 50K+ workflows/sec.                                     |
| `EventTarget` over EventEmitter | Native C++ implementation in Bun — lower overhead than userland EventEmitter for dispatch.                                                 |
| `#private` fields               | V8/JSC can optimize access to private fields more aggressively than string-keyed properties.                                               |
| `BroadcastChannel`              | Kernel-level IPC between Workers — faster than manual postMessage routing through the main thread.                                         |
| `WITHOUT ROWID` tables          | SQLite stores data directly in the B-tree for KV workloads — eliminates rowid lookup indirection.                                          |
| Prepared statements             | SQL compilation happens once, execution happens millions of times. Critical for the task-claim hot path.                                   |

---

## The Module Map

```
weft/
├── core/                  # ZERO platform dependencies (web standards only)
│   ├── engine.ts          # Workflow lifecycle, state machine
│   ├── context.ts         # ctx.run, ctx.sleep, ctx.signal, ctx.all,
│   │                      # ctx.setAttribute, ctx.onUpdate, ctx.waitForUpdate,
│   │                      # ctx.review, ctx.state
│   ├── checkpoint.ts      # Generator serialization via structuredClone
│   ├── scheduler.ts       # Timer/retry scheduling logic (no I/O)
│   ├── interceptor.ts     # WorkflowInterceptor, ActivityInterceptor interfaces + chain composition
│   ├── search-attributes.ts # Attribute index encoding, diff logic, sortable key encoding
│   ├── updates.ts         # Synchronous update request/response coordination
│   ├── codec.ts           # MessagePack encode/decode (pure JS)
│   ├── atomic-state.ts    # AtomicState primitive: durable concurrent KV with optimistic concurrency
│   └── types.ts           # TypeScript types
│
├── storage/               # Storage adapters (one per platform)
│   ├── interface.ts       # KV-oriented Storage interface
│   ├── bun-sql.ts         # Bun.SQL (SQLite) — default, ships in binary
│   ├── lmdb.ts            # LMDB — high-performance server option
│   ├── indexeddb.ts        # Browser IndexedDB
│   ├── memory.ts          # In-memory (testing, WASM)
│   └── turso.ts           # Turso/libSQL (distributed SQLite)
│
├── workers/               # Web Worker executors
│   ├── workflow-runner.ts # Worker script: runs workflow generators
│   ├── activity-runner.ts # Worker script: runs activity functions
│   └── pool.ts            # Worker pool management (spawn, reuse, terminate)
│
├── server/                # Bun.serve() HTTP + WebSocket server
│   ├── index.ts           # Server entry point (Bun-specific)
│   ├── handler.ts         # Pure request→response handler (platform-agnostic!)
│   ├── auth.ts            # API keys, JWT, Bun.password
│   └── ui/                # Pre-built React dashboard
│
├── service-worker/        # Browser deployment target
│   ├── sw.ts              # Service Worker entry point
│   └── timer-sync.ts      # Periodic Background Sync for durable timers
│
├── worker/                # Remote activity worker client
│   ├── index.ts           # WebSocket-based worker (primary)
│   ├── long-poll.ts       # HTTP long-poll worker (fallback)
│   ├── heartbeat.ts       # Visibility timeout keepalive
│   └── registry.ts        # Server-side worker tracking and routing
│
├── observability/          # Opt-in OpenTelemetry integration
│   ├── index.ts           # createObservabilityInterceptors() factory
│   ├── propagation.ts     # W3C trace context helpers (headerMapGetter/Setter)
│   └── metrics.ts         # OpenTelemetry metrics definitions (histograms, counters)
│
├── client/                # Client SDK (library/server parity — same API, two modes)
│   ├── index.ts           # HTTP/WS client (server mode: network calls to Weft server)
│   └── local.ts           # Direct engine client (library mode: in-process, no network)
│
├── testing/               # First-class test utilities
│   ├── test-engine.ts     # TestEngine: real engine with MemoryStorage + time control
│   ├── time-control.ts    # Deterministic time advancement (no real timers in tests)
│   └── mocks.ts           # Type-safe activity mocking + invocation recording
│
├── cli.ts                 # CLI entry point (compiled into standalone binary)
└── index.ts               # Main library export
```

**Key structural note:** `server/handler.ts` contains the pure `(Request) → Response` logic with zero Bun dependencies. The Bun-specific `server/index.ts` wraps it in `Bun.serve()`. The Service Worker's `sw.ts` wraps the exact same handler in `self.addEventListener("fetch", ...)`. One handler, two deployment targets.

**Library/server parity:** The library mode and server mode examples below use different deployment wrappers, but the workflow code, engine API, and client interface are identical. Moving between modes is a configuration change, not a code change.

---

## Hello World

```typescript
// Library mode — embed in your app
import { Engine, BunSQLiteStorage } from '@lostgradient/weft';

const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
});

async function greet(name: string) {
  return `Hello, ${name}!`;
}
async function notify(msg: string) {
  await fetch('https://hooks.slack.com/...', {
    method: 'POST',
    body: JSON.stringify({ text: msg }),
  });
}

async function* welcomeWorkflow(ctx: Context, user: { name: string }) {
  const greeting = yield* ctx.run(greet, user.name);
  yield* ctx.sleep('1 hour');
  yield* ctx.run(notify, `${user.name} completed onboarding`);
  return { greeting, onboarded: true };
}

engine.register('welcome', welcomeWorkflow);
const handle = await engine.start('welcome', { name: 'Steve' });
console.log(await handle.result()); // { greeting: "Hello, Steve!", onboarded: true }
```

```bash
# Server mode — single binary
curl -L https://releases.weft.dev/v1/weft-darwin-arm64 -o weft && chmod +x weft
./weft --port 7233

# That's it. SQLite database created automatically. Dashboard at localhost:7233/
# Register workflows by connecting a worker:
bun run my-workflows.ts  # connects to weft server via WebSocket
```

### Compared to Temporal

The equivalent workflow in Temporal's TypeScript SDK:

```typescript
// activities.ts — must be a separate file
import Stripe from 'stripe';
export async function greet(name: string) {
  return `Hello, ${name}!`;
}
export async function notify(msg: string) {
  await fetch('https://hooks.slack.com/...', {
    method: 'POST',
    body: JSON.stringify({ text: msg }),
  });
}
```

```typescript
// workflows.ts — runs in Webpack sandbox, cannot import activities directly
import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet, notify } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
});

export async function welcomeWorkflow(user: {
  name: string;
}): Promise<{ greeting: string; onboarded: boolean }> {
  const greeting = await greet(user.name);
  await sleep('1 hour'); // Must be Temporal's deterministic sleep
  await notify(`${user.name} completed onboarding`);
  return { greeting, onboarded: true };
}
```

```typescript
// worker.ts — separate process required
import { Worker } from '@temporalio/worker';
const worker = await Worker.create({
  workflowsPath: require.resolve('./workflows'), // Webpack bundles this
  activities: await import('./activities'),
  taskQueue: 'default',
});
await worker.run();
```

```bash
# Server — requires Docker or Temporal Cloud
docker compose up -d   # PostgreSQL + Elasticsearch + 4 Temporal services
# ... or temporal server start-dev
```

Three files. Webpack bundling. `proxyActivities` ceremony. Separate worker process. Docker for the server. Compare to Weft's single file above.

---

## Open Questions — Resolved

1. **Checkpoint serialization format:** `structuredClone` semantics. Enforced. `ctx.memo()` for derived values.

2. **Generator depth:** Child workflows independently checkpointed via separate KV entries. Max depth 10 (configurable).

3. **Determinism:** Not required. Opt-in `deterministic` mode available for testing.

4. **SQLite write bottleneck:** LMDB adapter for high-throughput deployments. Turso for distributed. v1 ships SQLite; documented scaling path.

5. **Database choice:** SQLite (via Bun.SQL) as default for zero-config + single-binary. LMDB as opt-in for max perf. Not LevelDB (LMDB is strictly better for our workload, LevelDB is single-process only).

6. **Single binary:** `bun build --compile` with cross-compilation targets. Dashboard embedded as file assets. SQLite included via runtime.

7. **Web Workers:** Yes — workflow and activity execution isolated in Workers. BroadcastChannel for coordination. Same model works in browser.

8. **Service Workers:** Yes — the browser deployment target. Same engine, IndexedDB storage, fetch event interception. Limited by browser background execution budget.

9. **Naming:** Weft. Ship it.

10. **Workflow versioning:** Version pinned at start and stored in workflow state; recovery stops on workflow-version or version-tuple drift. No patching API needed — checkpoint model avoids replay compatibility concerns.

11. **Workflow timeouts:** Execution timeout (maximum wall-clock time for a workflow), stored as absolute deadline in storage, enforced by the scheduler via AbortController.

12. **Search attributes:** KV-based secondary indexes (`idx:{attr}:{value}:{wfId}`), works identically on all storage backends, updated atomically with checkpoint writes.

---

## Acceptance Criteria Checklist

### Core Engine

- [x] **Workflows are AsyncGenerator functions.** `async function*` is the only way to define a workflow. No decorator magic, no class-based API, no code transformation.
- [x] **Each `yield*` creates a checkpoint.** Checkpoint contains: step index, local variable snapshot (via `structuredClone` semantics), accumulated results.
- [x] **Recovery is O(1).** Loading a checkpoint from storage and resuming the generator does not replay previous steps. Verified by benchmark: recovery time is constant regardless of workflow history length.
- [x] **No determinism requirement.** `Date.now()`, `Math.random()`, `crypto.randomUUID()`, and network calls are permitted inside workflows between checkpoint boundaries.
- [x] **`ctx.run(fn, input?, options?)` dispatches a durable activity.** Activity results survive process crashes. Idempotency keys prevent double-execution.
- [x] **`ctx.sleep(duration)` is a durable timer.** Survives process restarts. Fires within 1 second of scheduled time after recovery.
- [x] **`ctx.signal(name)` / `ctx.waitForSignal(name)` support durable signals.** Signals persist in storage and are delivered even if the workflow is not currently loaded in memory.
- [x] **`ctx.all([...])` runs operations in parallel.** Equivalent to `Promise.all` but each branch is independently checkpointed.
- [x] **`ctx.race([...])` runs operations with first-wins semantics.** Losing branches are cancelled via `AbortController`.
- [x] **`ctx.memo(key, fn)` caches derived values in the checkpoint.** On recovery, returns cached value without re-executing `fn`.
- [x] **Cancellation uses `AbortController`.** `handle.cancel()` propagates an abort signal through the workflow. `finally` blocks execute cleanup. Cleanup can yield to durable operations.
- [x] **Retry policy supports exponential backoff.** Configurable per-activity: `maxAttempts`, `initialBackoff`, `backoffMultiplier`, `maxBackoff`, `nonRetryableErrors`.
- [x] **Child workflows are independently checkpointed.** Parent stores child workflow ID reference, not child state.
- [x] **Max nesting depth is configurable.** Default: 10 levels. Exceeding throws a clear error.

### Event System

- [x] **`Engine` extends `EventTarget`.** All events dispatched via `dispatchEvent()`.
- [x] **All events are `Event` subclasses.** No use of `CustomEvent`. Properties are directly on the event object, not in `.detail`.
- [x] **Typed `addEventListener` overloads.** TypeScript infers correct event type from the event name string.
- [x] **`AbortSignal`-based listener cleanup.** Passing `{ signal }` to `addEventListener` removes the listener when the signal aborts.
- [x] **`WorkflowHandle` extends `EventTarget`.** Receives events scoped to its workflow.
- [x] **`WorkflowHandle` implements `Symbol.asyncIterator`.** `for await (const event of handle)` works.
- [x] **`WorkflowHandle` implements `Symbol.observable`.** RxJS `from(handle)` works without adapters.
- [x] **Event types defined:** `workflow:started`, `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`, `activity:started`, `activity:completed`, `activity:failed`, `stream:token`, `signal:received`, `signal:delivered`, `attributes:changed`, `update:received`, `update:completed`.

### Resource Management

- [x] **`Engine` implements `Disposable` and `AsyncDisposable`.** Both `using` and `await using` work.
- [x] **`WorkflowHandle` implements `AsyncDisposable`.** `await using handle = ...` cleans up listeners.
- [x] **`WorkerPool` implements `Disposable` and `AsyncDisposable`.** Sync: immediate termination. Async: graceful drain.
- [x] **`BunSQLiteStorage` implements `Disposable`.** Closes database connection.
- [x] **`LMDBStorage` implements `Disposable`.** Closes LMDB environment.
- [x] **`Scheduler` implements `Disposable`.** Clears intervals and timers.
- [x] **`AsyncDisposableStack` used in server setup.** All server resources cleaned up in reverse order on shutdown.
- [x] **Zero resource leaks under test.** `resource-leaks.test.ts` runs 1000 create/run/dispose cycles and asserts heap growth under 2MB after a warmup period.

### Memory Management

- [x] **Checkpoint cache uses `WeakRef`.** Cached checkpoints are GC-eligible. Cache miss triggers storage re-read.
- [x] **`FinalizationRegistry` cleans up dead cache entries.** No periodic sweep timer needed.
- [x] **Activity registry uses a simple name-to-callable map.** Activities are keyed by name; registered via `engine.register(activityDefinition)`.
- [x] **Handle registry uses `WeakRef`.** Engine doesn't prevent GC of dropped handles.
- [x] **`Transferable` used for Worker communication.** Checkpoint `ArrayBuffer` is transferred, not copied, to/from Workers.
- [x] **Memory per idle workflow ≤ 2KB.** Verified by benchmark with 100K concurrent workflows; `src/benchmarks/memory-per-workflow.test.ts` reports a max durable footprint of ~743 bytes/workflow and a max current checkpoint size of ~132 bytes/workflow.
- [x] **No unbounded growth under load.** Short sustained-load regression benchmark keeps post-warmup RSS within a bounded band under load driven at 10K workflows/sec. `src/benchmarks/load-growth-memory.test.ts` now runs three fresh-subprocess trials against the SQLite storage backend, using zero terminal retention to isolate steady-state engine churn from intentionally retained history. The gate asserts median RSS slope below 1MB/sec, median post-warmup RSS delta below 8MB, median post-warmup RSS band below 8MB, and every trial's post-warmup RSS delta/band below 64MB. Throughput is the _pacing_ rate the load is driven at, not a pass/fail bar: it is logged for diagnostics (the GC-sampled sustained path runs well below an unthrottled run, so an absolute floor would conflate hardware speed with memory health), and a low workload-completion precondition (at least 25% of the ideal dispatch count) invalidates a run whose load generation collapsed.

### Storage

- [x] **`Storage` interface is KV-oriented.** `get`, `put`, `delete`, `scan`, `batch`.
- [x] **`BunSQLiteStorage` uses `Bun.SQL` tagged templates.** Not raw `bun:sqlite`.
- [x] **`BunSQLiteStorage` uses `WITHOUT ROWID` tables.** Verified in schema.
- [x] **`BunSQLiteStorage` sets WAL mode, `synchronous = NORMAL`, 64MB cache.** Verified by `PRAGMA` queries in tests.
- [x] **`LMDBStorage` uses `lmdb-js` with async write batching.** Reads are synchronous zero-copy.
- [x] **`IndexedDBStorage` works in browsers.** Tested in Chrome, Firefox, Safari.
- [x] **`MemoryStorage` exists for testing.** Fast, no I/O, no dependencies.
- [x] **Turso adapter exists for distributed deployments.** Same interface, connection string change.
- [x] **All storage adapters implement `Disposable`.** `using storage = new XStorage(...)` works.
- [x] **50K+ writes/sec on SQLite.** Benchmarked on commodity hardware (M1 MacBook or equivalent).
- [x] **Batch operations are atomic.** All-or-nothing semantics verified by crash injection tests.

### Web Workers

- [x] **Workflow execution runs in Web Workers.** Not on the main thread.
- [x] **Activity execution runs in Web Workers.** Configurable pool size.
- [x] **Worker crash doesn't crash the engine.** Main thread detects termination, marks workflow/activity as failed, spins up replacement.
- [x] **`BroadcastChannel` used for cross-worker coordination.** Signal delivery, event fan-out.
- [x] **`postMessage` uses transfer lists for `ArrayBuffer` data.** Zero-copy verified.
- [x] **Worker pool implements concurrency limits.** Configurable per queue.
- [x] **`smol: true` option available.** For high-workflow-count scenarios with constrained memory.
- [x] **Same Worker code runs in browser Web Workers.** Verified by browser integration test.

### HTTP / WebSocket Server

- [x] **Uses `Bun.serve()` routes syntax.** Not manual URL parsing.
- [x] **JSON by default, MessagePack opt-in.** `Accept: application/msgpack` header.
- [x] **WebSocket upgrade for worker streams.** `WS /v1/tasks/:queue/stream`.
- [x] **WebSocket upgrade for workflow observation.** `WS /api/v1/workflows/:id/watch`.
- [x] **WebSocket upgrade for token streaming.** `WS /api/v1/workflows/:id/stream`.
- [x] **Bun's built-in pub/sub (`ws.subscribe` / `server.publish`).** No external message broker.
- [x] **Long-poll fallback for non-WebSocket environments.** `GET /api/v1/tasks/:queue` with timeout.
- [x] **Prometheus metrics at `/v1/metrics`.** All counters, gauges, histograms defined.
- [x] **Built-in web dashboard at `/`.** Pre-built SPA embedded in binary.
- [x] **Auth: API keys, JWT, optional mTLS.** Configurable in `serve()` options.

### Library/Server Parity

- [x] **Every HTTP endpoint has a corresponding `Engine` method.** `POST /v1/workflows` → `engine.start()`, `GET /v1/workflows/:id` → `engine.get()`, etc. No server-only features.
- [x] **Every `Engine` method is exposed via HTTP.** No library-only features that server-mode users cannot access.
- [x] **`client/local.ts` and `client/index.ts` export the same interface.** Switching from library to server mode is a constructor change, not an API change.
- [x] **Workflow code is identical across modes.** The same `async function*` runs in library mode, server mode, and browser/Service Worker mode without modification.
- [x] **Event observation works in both modes.** Library mode uses `EventTarget` directly; server mode bridges events over WebSocket. Same event types, same semantics.
- [x] **Human review works in both modes.** `ctx.review()` and its review-resolution endpoints behave identically in library, server, and browser modes.

### Remote Workers

- [x] **Workers connect via `WS /v1/tasks/:queue/stream`.** Server-push task dispatch, not client-poll.
- [x] **Worker sends `register` on connect.** Includes: identity, activity names, concurrency limit.
- [x] **Server tracks worker capacity.** `concurrency - inFlight` determines whether to push tasks.
- [x] **Each task assigned to exactly one worker.** No client-side race conditions. Server makes assignment decision.
- [x] **Queue-based routing.** `ctx.run(fn, args, { queue })` routes the task to workers subscribed to that queue.
- [x] **Sticky routing opt-in.** `ctx.run(fn, args, { sticky: true })` prefers the same worker for cache locality.
- [x] **Least-loaded routing by default.** Server picks the worker with the lowest `inFlight` count.
- [x] **Visibility timeout on every in-flight task.** Default 30 seconds, configurable per activity. Stored in database (survives server restart).
- [x] **Worker heartbeats extend visibility deadline.** `heartbeat` message resets the timeout clock.
- [x] **Heartbeat details are queryable.** Progress info from heartbeats available via `handle.query(activityProgressQuery)`.
- [x] **Worker disconnection triggers task reassignment.** WebSocket `close` event → scan in-flight tasks → requeue with incremented attempt.
- [x] **Visibility timeout expiry triggers task reassignment.** Scheduler scans `op:inflight:*` for expired deadlines.
- [x] **Retry policy respected on reassignment.** `maxAttempts` exceeded → permanent failure. Backoff delay applied between attempts.
- [x] **Graceful shutdown via `shutdown` message.** Worker stops accepting tasks, finishes in-flight work, then disconnects.
- [x] **Task is always in exactly one state.** Queued, in-flight (with visibility deadline), or resolved. No lost tasks.
- [x] **Long-poll fallback at `GET /v1/tasks/:queue`.** Returns a task or `null` after timeout. Paired with `POST /v1/tasks/:queue/complete`.
- [x] **Long-poll client works in any `fetch()` environment.** `LongPollWorker` uses `fetch()` only — Deno, Node.js, Cloudflare Workers, browsers.
- [x] **Server cancellation propagated to workers.** Server sends `cancel` message over WebSocket; worker aborts via `AbortController`.

### Single Binary

- [x] **`bun build --compile` produces standalone executables.** For `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`.
- [x] **Binary includes Bun runtime + SQLite + dashboard assets.** No external dependencies.
- [x] **CLI flags: `--port`, `--database`, `--no-ui`, `--storage`.** Configurable at launch.
- [x] **Binary size < 100MB.** Target: ~60MB (Bun runtime is ~50MB, Weft + dashboard ~10MB).
- [x] **Cold start to first workflow < 100ms.** Measured from process start to HTTP 201 on workflow creation.
- [x] **Cross-compilation from single CI pipeline.** One `build.ts` script, five output binaries.

### Browser / Service Worker

- [x] **Core engine runs in browser Web Workers.** Same workflow code, IndexedDB storage.
- [x] **Service Worker intercepts `/weft/` fetch events.** Same `handleRequest()` function as server.
- [x] **IndexedDB storage passes all storage interface tests.** Same test suite as SQLite.
- [x] **Client library works with both remote server and local Service Worker.** Same `fetch()` calls, different routing.
- [x] **Service Worker handles Periodic Background Sync for timers.** (Where browser supports it.)

### Workflow Versioning

- [x] **Workflow version stored in `wf:{id}` state blob.** Set at workflow start from the currently registered version.
- [x] **`engine.register()` accepts a version.** Shorthand registration defaults to version `"0.0.0"`.
- [x] **Version mismatch stops recovery.** Stored and registered workflow versions must match before a checkpoint resumes.
- [x] **Version-tuple drift stops recovery.** Workflow, agent, and tool version metadata must remain aligned with the stored tuple.
- [x] **Version mismatch produces a `VersionMismatchError`.** Error includes both versions, workflow ID, and workflow type.
- [x] **Version visible in API and dashboard.** `GET /v1/workflows/:id` returns the version field.

### Workflow-Level Timeouts

- [x] **`executionTimeout` on `engine.start()` caps total workflow wall-clock time.** Includes all sleeps, signal waits, and activity executions.
- [x] **Timeout stored as absolute deadline in storage.** Survives process restarts. Scheduler detects expired deadline on recovery.
- [x] **Timeout fires mid-activity via `AbortController`.** In-flight activities receive abort signal. No orphaned work.
- [x] **`WorkflowTimeoutError` thrown on timeout.** Includes `timeoutType` and elapsed duration.
- [x] **`WorkflowTimedOutEvent` dispatched on timeout.** Added to `WeftEventMap`. Listeners receive `timeoutType` and `elapsed`.
- [x] **`ctx.signal` exposes the combined cancellation + timeout signal.** Activities that accept `{ signal }` automatically respect workflow timeouts.
- [x] **`ctx.executionTimeRemaining` returns milliseconds.** Workflows can make decisions based on remaining budget.
- [x] **Deadline keys are cleaned up on workflow completion.** `wf-deadline:*` entries deleted when workflow reaches terminal state.
- [x] **HTTP API accepts `executionTimeout` parameter.** `POST /v1/workflows` body includes `executionTimeout`.
- [x] **Dashboard shows timeout configuration and remaining time.** `execution-deadline.svelte` displays deadline with real-time remaining countdown.

### Search Attributes

- [x] **`ctx.setAttribute(key, value)` sets a single search attribute.** Value persisted at next checkpoint boundary. Supported types: `string`, `number`, `boolean`, `Date`, `string[]`.
- [x] **`ctx.setAttributes(attrs)` sets multiple attributes in one call.** Merge semantics: existing attributes not mentioned are preserved.
- [x] **`ctx.getAttribute(key)` reads the current value.** Returns the in-memory value, even if not yet checkpointed.
- [x] **`ctx.getAttributes()` returns all attributes.** Returns a readonly copy.
- [x] **Attribute schema declared at registration time.** `engine.register("type", fn, { searchAttributes: { ... } })`. Unknown attribute keys rejected at set time.
- [x] **Index entries created atomically with checkpoint.** `idx:{attr}:{value}:{wfId}` keys written in the same `batch()` call as the checkpoint.
- [x] **Index entries diffed on update.** When an attribute value changes, old index entries deleted and new entries created in the same batch.
- [x] **String-array attributes create one index entry per element.** Setting `tags: ["a", "b"]` creates two index keys.
- [x] **Numeric values sort correctly in index keys.** IEEE 754 float-to-sortable-string encoding ensures correct lexicographic order.
- [x] **Date values sort correctly in index keys.** ISO 8601 encoding preserves chronological order.
- [x] **`engine.list({ attributes: [...] })` filters by attributes.** Equality: `{ key, value }`. Range: `{ key, gte, lte }`.
- [x] **Multiple attribute filters are AND-combined.** All conditions must match.
- [x] **HTTP API supports `attr.*` query parameters.** `?attr.customerId=abc`, `?attr.priority.gte=8`.
- [x] **`PATCH /v1/workflows/:id/attributes` sets attributes externally.** Merge semantics. Index updated atomically.
- [x] **`GET /v1/workflows/:id/attributes` reads attributes.** Returns JSON object.
- [x] **`handle.setAttributes()` and `handle.getAttributes()` work from the client SDK.**
- [x] **`AttributesChangedEvent` dispatched on Engine and WorkflowHandle.** Includes workflow ID and changed keys.
- [x] **Attribute cleanup on workflow completion/deletion.** All `attr:` and `idx:` entries removed atomically.
- [x] **Works identically across storage backends.** `src/core/search-attributes-multibackend.test.ts` and `src/core/search-attributes-integration.test.ts` iterate `storageBackends` to verify consistent behavior.
- [x] **Index scan performance: <1ms for single-attribute equality filter on 100K workflows.** Benchmarked on SQLite.

### Synchronous Updates

- [x] **`ctx.onUpdate(name, handler)` registers an update handler.** Handler is a function (not a generator). Receives payload, returns result.
- [x] **`ctx.waitForUpdate(name)` suspends until an update arrives.** Returns `{ payload, respond }`. `respond()` sends the result back.
- [x] **`engine.update(workflowId, name, payload, options)` sends an update and waits for the response.** Returns a promise that resolves with the handler's return value.
- [x] **`handle.update(name, payload, options)` is a convenience method.** Delegates to `engine.update()`.
- [x] **Timeout semantics.** Default 30 seconds, configurable via `options.timeout`. On timeout, rejects with `UpdateTimeoutError` containing `updateId` for later retrieval.
- [x] **HTTP endpoint: `POST /v1/workflows/:id/update/:name`.** Body: `{ payload, timeout?, idempotencyKey? }`. Returns result or 408 on timeout.
- [x] **HTTP endpoint: `GET /v1/updates/:updateId`.** Returns `{ status: "pending" }` (202) or `{ status: "completed", result }` (200).
- [x] **Update request persisted to storage before acknowledging caller.** Key: `upd:{workflowId}:{updateId}`. Survives server crash.
- [x] **Update response persisted atomically with checkpoint.** Key: `upr:{updateId}`. Written in same `batch()` as checkpoint.
- [x] **Update handler runs at checkpoint boundary.** Processed in the same phase as pending signals.
- [x] **Update handler cannot yield.** Attempting to use `yield*` inside an `onUpdate` handler throws a clear error.
- [x] **Paused workflows are woken for pending updates.** If waiting on a timer or signal, a pending update triggers a wake-up.
- [x] **Idempotency key prevents duplicate processing.** Same key returns existing response. Key stored at `upk:{workflowId}:{key}`.
- [x] **BroadcastChannel notification on response completion.** Caller's waiting promise resolves without polling.
- [x] **WebSocket observers receive `UpdateCompletedEvent`.** Published on the workflow's watch channel.
- [x] **`UpdateReceivedEvent` and `UpdateCompletedEvent` dispatched on Engine and WorkflowHandle.**
- [x] **Response cleanup after TTL.** `upr:*` entries deleted after 5 minutes (configurable).
- [x] **Durability: crash between request and response.** After recovery, workflow processes the pending update. Caller retrieves via `GET /v1/updates/:updateId`.
- [x] **Multiple concurrent updates to the same workflow.** Each processed independently at the next checkpoint boundary.
- [x] **Update to a completed/failed workflow returns an error.** 422 status with clear message.
- [x] **Works identically across storage backends.** The same test suite passes for every backend covered by `storageBackends`. (`src/core/updates-multibackend.test.ts` A7 suite: parametrizes inline `onUpdate`, `waitForUpdate`, timeout, FIFO, and post-cancel rejection over `storageBackends`.)

### Interceptors

- [x] **`WorkflowInterceptor` interface defined with typed hooks.** Hooks: `activity`, `sleep`, `waitForSignal`, `workflowStart`, `signalReceived`, `query`.
- [x] **`ActivityInterceptor` interface defined.** Hook: `execute`.
- [x] **All interceptor hooks are optional.** An interceptor can implement only the hooks it cares about.
- [x] **`engine.addInterceptor(interceptor)` registers workflow interceptors.** Multiple registrations compose in order.
- [x] **`engine.addActivityInterceptor(interceptor)` registers activity interceptors for local workers.**
- [x] **Remote `Worker` accepts `interceptors` option.** Activity interceptors apply on the remote worker side.
- [x] **Interceptors compose via `next()` delegation.** First registered = outermost wrapper.
- [x] **Workflow interceptor hooks return generators.** Preserves `yield*` checkpoint semantics.
- [x] **Activity interceptor `execute` hook returns a Promise.**
- [x] **`headers` Map propagates across Worker boundaries.** Set in workflow interceptor, serialized into `postMessage`/WebSocket, read in activity interceptor.
- [x] **`headers` Map propagates across network boundaries (remote workers).** Serialized as part of the WebSocket `task` message.
- [x] **Interceptor errors propagate naturally.** An exception in an interceptor fails the operation as if the underlying operation failed.
- [x] **Zero overhead when no interceptors are registered.** Context operations call the underlying implementation directly.
- [x] **Workflow code does not need modification.** Interceptors are transparent to workflow definitions.
- [x] **Interceptor chain is constructed once per engine, not per operation.** Composition is cached.
- [x] **Interceptors cannot modify the checkpoint mechanism.** They wrap operations, not serialization.

### Observability

- [x] **`createObservabilityInterceptors()` returns both a `WorkflowInterceptor` and an `ActivityInterceptor`.**
- [x] **Uses `@opentelemetry/api` exclusively.** No custom tracing layer. No vendor-specific code. Uses `getOtelApi()` which provides a no-op fallback when SDK not installed.
- [x] **Zero overhead when no OpenTelemetry SDK is configured.** No-op implementations in `no-op-telemetry.ts` are empty functions the JIT can inline.
- [x] **Zero overhead when the observability interceptor is not imported.** No code loaded, no interception.
- [x] **Each workflow execution creates a root span.** Named `workflow:{workflowType}`. Attributes: `weft.workflow.id`, `weft.workflow.type`.
- [x] **Each `ctx.run()` creates a child span.** Named `activity:{activityName}`. Attributes: `weft.activity.operation_id`, `weft.activity.attempt`, `weft.activity.queue`.
- [x] **Each `ctx.sleep()` creates a child span.** Named `sleep`. Attributes: `weft.sleep.duration`.
- [x] **Each `ctx.waitForSignal()` creates a child span.** Named `signal:wait:{signalName}`.
- [x] **Trace context propagates to local Activity Workers via `postMessage`.** W3C `traceparent` in the `headers` map.
- [x] **Trace context propagates to remote Activity Workers via WebSocket.** `headers` field in the `task` message. Validated by `remote-propagation.test.ts`.
- [x] **Activity-side interceptor extracts trace context and creates a child span.** Named `activity:execute:{activityName}`.
- [x] **Child workflow spans use OpenTelemetry span links, not parent-child.** Independent lifecycle.
- [x] **`recordPayloads` option records activity inputs/outputs as span attributes.** Off by default.
- [x] **`maxPayloadSize` truncates recorded payloads.** Prevents unbounded attribute sizes.
- [x] **`attributeExtractor` allows custom span attributes.** User-provided function receives interception context via `ObservabilityOptions`.
- [x] **Error spans record exception details.** `span.recordException()` called. `span.setStatus({ code: ERROR })` set.
- [x] **Span hierarchy is correct.** Workflow span > activity/sleep/signal spans > user spans inside activities.
- [x] **OpenTelemetry metrics defined.** `weft.workflow.duration`, `weft.activity.duration`, `weft.activity.attempts`, `weft.workflow.active`.
- [x] **Metrics exportable to Prometheus via standard OTel exporter.** `/v1/metrics` backed by OTel metrics.
- [x] **Remote worker example in documentation.** Shows `interceptors: [activity]` on remote worker constructor. (See `documentation/guides/remote-workers.md`; search for `const { activity } = createObservabilityInterceptors()` and the nearby `new RemoteWorker({ … interceptors: [activity] })` example.)
- [x] **Composable with other interceptors.** Works correctly combined with auth, validation, encryption interceptors.

### DX

- [x] **Zero config to start.** `import { Engine } from "@lostgradient/weft"; new Engine()` works with defaults (in-memory storage).
- [x] **`bun add @lostgradient/weft` is the only install step.** No codegen, no proto files, no Docker.
- [x] **TypeScript types infer everything.** Event listeners, workflow context, activity return types — all inferred.
- [x] **`using` / `await using` works for all resources.** No manual cleanup ever required.
- [x] **Testing: `MemoryStorage` + `TestEngine.advanceTime()`.** No real timers in tests. `TestEngine` provides deterministic time control via `TimeControl`.
- [x] **Error messages reference the user's code, not Weft internals.** Stack traces are clean. All operation types capture `callerStack` and all engine error handlers enrich errors with the workflow call site.
- [x] **Documentation: every public API has JSDoc with examples.** Visible in IDE hover.
- [x] **Dashboard shows real-time workflow state.** WebSocket-powered via `websocket-client.svelte.ts`, updates without refresh.

### Temporal Differentiation

- [x] **Development mode detects non-cloneable checkpoint values.** Serializes/deserializes at each boundary, reports exact field paths that fail with fix suggestions.
- [x] **Stack-trace-preserving errors.** Activity failure errors include the original workflow call site, not just the remote worker stack.
- [x] **`weft version:check` CLI command.** Analyzes registered workflows against existing database, reports checkpoint compatibility before deployment.
- [x] **Automatic checkpoint schema inference.** Actionable error messages on version mismatch naming exact fields that changed. `VersionMismatchError` accepts shape descriptors and includes field-level diffs (added, removed, type-changed). `inferShape()` and `diffCheckpointShapes()` are exported utilities.
- [x] **`ctx.step()` sugar for non-generator workflows.** Progressive disclosure — wraps checkpoint boundaries in a familiar async function.
- [x] **`ctx.explain()` development mode.** Logs what each context operation does and why at runtime via `#explainMode` flag.
- [x] **`weft doctor` diagnostic command.** Reports database health, workflow statistics, queue depths, performance metrics, and recommendations.
- [x] **Built-in alerting with zero external dependencies.** Alert rules as engine event listeners, webhook notifications via `fetch()`.
- [x] **Automatic checkpoint size warnings.** `CheckpointSizeWarningEvent` emitted when checkpoints exceed configurable threshold (default: 64KB).
- [x] **`ctx.offload()` stores large data separately.** Leaves only a lightweight reference in the checkpoint. `ctx.load()` retrieves on demand.
- [x] **Built-in profiling mode.** `MemoryProfiler` class provides interval-based memory profiling with stability analysis. Exported from index.
- [x] **Typed workflow registry.** `Engine<WorkflowRegistry>` provides compile-time type safety on `engine.start()`, `handle.result()`, `handle.signal()`.
- [x] **`@lostgradient/weft/testing` module with `TestEngine`.** Real engine with `MemoryStorage`, deterministic time control, crash simulation via `engine.recover()`.
- [x] **`ctx.archive()` moves old state out of checkpoint.** Preserved at `archive:{workflowId}:{key}` for auditing, queryable via dashboard and API.
- [x] **`ctx.expose()` for live workflow inspection.** Accessor functions evaluated at each checkpoint, rendered on dashboard without pre-registered query handlers.
- [x] **Checkpoint history (last N).** Configurable number of retained checkpoints per workflow for time-travel debugging.
- [x] **`activity()` helper with colocated configuration.** Retry, timeout, queue, and idempotency declared on the activity definition.
- [x] **`ctx.runAll()` with named concurrent branches.** Per-branch error handling policies (`onError: "continue"`).
- [x] **`ctx.stream()` for large payloads.** Writes data to storage as chunks via `ReadableStream`, leaves lightweight reference in checkpoint.
- [x] **Automatic payload compression.** Transparent gzip/brotli compression above configurable threshold.
- [x] **Pluggable serialization.** `Serializer` interface in `src/core/types.ts` with `serialize`/`deserialize` methods, passable to Engine options.

### Competitive Parity & Gap Closure

The Temporal-derived pain points above are architecturally solved. This section tracks the remaining gaps versus the newer AI-native alternatives documented in the "Competitive Landscape" and "Honest Gaps" sections earlier in this document. Each item is a binary acceptance criterion, flipped to `[x]` when implemented and verified.

- [x] **Serverless suspension primitive.** `ctx.suspendUntil(resumeToken)` in `src/core/context.ts` yields to `waitForSignal(resumeToken)`, persisting a checkpoint so the engine can drop the in-memory workflow until the resume signal arrives. Resume is via the existing `POST /v1/workflows/:id/signal/:token` endpoint (or `engine.signal(workflowId, resumeToken, payload)`). See tests in `src/core/suspend.test.ts` for multi-suspension flows. Worker execution also releases its active worker on a durable `wait-signal` checkpoint, letting the same worker process another workflow while the parked generator state stays in that worker process.
- [x] **Routing policies.** `RoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share'` in `src/worker/registry.ts`. `WorkerRegistry` constructor accepts `{ policy }`; `findWorker(activity, { fairShareKey })` consults per-worker per-key counts. All three policies are plumbed end-to-end: `TaskDispatch.fairShareKey` is threaded through `dispatchTaskImpl` → `findWorker` → `assignTask` in `src/server/index.ts`, and a server-level integration test asserts fair-share distributes across keys when dispatched via `serve()`.
- [x] **Task queue scheduling policies.** `TaskQueueOptions.schedulingPolicy: 'priority' | 'fifo' | 'lifo'` in `src/server/task-queue.ts`, default `'priority'` (current behavior). Plumbed through `serve({ schedulingPolicy })`.
- [x] **Virtual-Object-style session state.** `ctx.state.session(key)` co-located with the sticky worker. Builds on existing `workerAffinity` in `src/server/index.ts`; session state survives worker restart via checkpoint.
- [x] **OTel standard Prometheus exporter.** `PrometheusExporter` interface in `src/observability/metrics.ts` with a default `createMetricsCollectorExporter(collector)` implementation. `/v1/metrics` delegates to the single `prometheusExporter` server option when provided, letting projects plug in `@opentelemetry/exporter-prometheus` (or any OTel reader) without forcing it as a runtime dependency. When omitted, `serve()` uses a server-owned collector for runtime diagnostics and the default text exposition.
- [x] **Index scan benchmark.** `src/benchmarks/search-attributes-scan.test.ts` seeds 100K workflows with a `customerId` attribute against `BunSQLiteStorage`; median latency measured at ~0.14ms (p95 ~0.2ms). Implementation fix: `engine.list()` now loads constrained IDs directly from storage instead of full-scanning `wf:*`, turning the operation from O(total workflows) into O(matches).
- [x] **JSDoc examples on public API.** Every public export carries hover-visible JSDoc, verified mechanically by the manifest-backed gates in `scripts/check-declaration-jsdoc.ts` and `scripts/audit-jsdoc-manifest.ts`. The manifest is built fresh in-memory at the start of each gate run by `scripts/lib/jsdoc-manifest.ts` (no on-disk artifact — see "Why no committed manifest" below). It classifies entries into three buckets: `example-required` entries (user-facing values, argument/return types, event classes, error classes) carry both prose AND at least one `@example` block; `prose-only` entries (engine-returned shapes users observe but don't construct, e.g. `WorkflowState`, `BulkCancelResult`, `ScheduleSummary`) carry prose JSDoc, with `@example` optional; `not-public` entries are out of scope for this requirement. The prose-only bucket is determined by a single regex (`PROSE_ONLY_NAME_PATTERN` in `scripts/lib/jsdoc-manifest.ts`) — edit that regex when reclassifying a type. Every example block is compiled by `scripts/extract-doctests.ts` + `bunx tsc --noEmit` against the package's source `paths`, so snippets that drift from the real API fail the gate. Coverage status: 482 public-face triples across 21 entry points satisfy their classification rule.

  **Why no committed manifest:** the manifest used to live at `reference/jsdoc-manifest.json` (~7,600 lines) plus a textual snapshot at `documentation/public-api.snapshot.txt`. Both files were 100% derived from `package.json` exports + source `.ts` + the regex above, and any change to a public symbol re-sorted both files — turning every parallel branch into a merge conflict. They are now built on demand: developers can run `bun run scripts/build-jsdoc-manifest.ts` (writes `tmp/jsdoc-manifest.json`) or `bun run scripts/snapshot-public-api.ts` (writes `tmp/public-api.snapshot.txt`) for local inspection. CI builds the same structures in-memory and never persists them.

- [~] **Performance targets measured against spec.** Every benchmark in `src/benchmarks/` was re-run after Item 3 optimizations (activity completions recalibrated 2026-04-29, memory footprint realigned 2026-04-30, worker spawn re-isolated 2026-05-01, workflow start admission re-isolated and re-shaped around aggregate durable admission throughput 2026-05-03). Workflow start admission now meets spec at ~75.5K/sec via `src/benchmarks/workflow-starts.test.ts` + `src/benchmarks/workflow-starts-runner.ts`, which measure fresh-subprocess batched durable-admission throughput while inline execution launch drains after durable admission through a `MessageChannel` queue. Activity completions (~22.3K/sec vs 30K/sec) still remain below spec. Memory per workflow now meets spec at ~132 bytes for the current checkpoint blob and ~743 bytes for the total durable idle-workflow footprint across 100K parked workflows. Worker spawn now meets spec via the fresh-subprocess benchmark harness in `src/benchmarks/worker-spawn.test.ts` + `src/benchmarks/worker-spawn-runner.ts`, which reports an isolated median around ~2.3ms and keeps the default non-coverage gate at `<5ms`. Full numbers in `reference/IMPORTANT.md`.

### Performance Targets

- [x] **Workflow start admission: >50K/sec** (single node, SQLite) — measured ~75.5K/sec via the fresh-subprocess batched durable-admission benchmark in `src/benchmarks/workflow-starts.test.ts`
- [ ] **Activity completions: >30K/sec** (single node, SQLite) — measured ~22.3K/sec isolated subprocess median (post-optimization, up from ~9K/sec)
- [x] **Workflow recovery: <1ms** (O(1) checkpoint load) — measured ~0.08ms median
- [x] **Memory per workflow: ≤2KB** (checkpoint blob) — measured ~0.13KB current checkpoint blob and ~0.73KB total durable idle-workflow footprint across 100K parked workflows
- [x] **Cold start: <100ms** (binary mode), <50ms (library mode) — measured ~36ms binary (warm-cache median, 5 runs), ~0.14ms library
- [x] **Token stream latency: <10ms** (engine to WebSocket client)
- [x] **Event dispatch: <100μs** (EventTarget overhead per event) — measured ~0.18μs per dispatch
- [x] **Worker spawn: <5ms** (Web Worker creation in Bun) — `src/benchmarks/worker-spawn.test.ts` now shells into `src/benchmarks/worker-spawn-runner.ts`, isolating the measurement from suite noise; current isolated median is ~2.3ms, so the default non-coverage gate now enforces the actual `<5ms` spec
- [ ] **10x faster than Temporal on workflow start** (benchmarked head-to-head)
- [x] **100x faster on workflow recovery** (O(1) vs O(n) replay) — recovery target met
- [x] **5x lower memory per workflow** (~2KB vs ~50KB+) — measured ~0.73KB durable idle-workflow footprint, comfortably below the ~10KB threshold implied by the claim

---

## Research

The long-form research synthesis moved to [./architecture/research.md](./architecture/research.md). That document captures the paper-by-paper analysis, the performance-gap framing, and the distilled sequencing rationale that originally lived inline here.

The roadmap below carries forward the implementation work derived from that research. It is intentionally checklist-first, and it preserves one architectural constraint throughout: every transport-facing addition remains an adapter over the existing `Engine` methods, typed `EventTarget` events, `BroadcastChannel` coordination, and Worker `postMessage` protocols rather than a second orchestration system.

## Acceptance criteria (verifiable checklist)

### Track 1 — Foundations

- [x] `src/core/effect-log/index.ts` exists, exports `EffectLog` with `record(semanticHash, effectName)`, `lookup(semanticHash)`, `commit(semanticHash, effectName, output)`, `abort(semanticHash, effectName, reason)`. (Note: named for behavior, not a paper acronym; `computeSemanticHash` and `EffectReplayConflictError` also exported.)
- [x] An effect can supply an optional `identity: (input) => { semanticHash: string; intentCriticalFields: string[] }` to key its effect-log record.
- [x] The effect runner consults the effect log before every effect and short-circuits on `committed` matches, so a crash-and-restore replays the effect at most once.
- [x] `bun test src/core/effect-log/index.test.ts` passes tests that crash mid-effect, restore, and assert the effect ran exactly once (mock call count verified).
- [x] `src/core/event-log.ts` exists, exports `EventLog` with `append(event)`, `scan(workflowId)`, `replay(workflowId, toStep)`.
- [x] Event log entries are written in the same `storage.batch()` call as the checkpoint they correspond to (assertable by reading the storage backend's write log).
- [x] Each event entry contains `prevHash: string` chained from the previous entry; `EventLog.verify(workflowId)` returns `{ valid: boolean; firstInvalidSequence?: number }` and detects tampered logs.
- [x] `bun test src/core/__tests__/event-log.test.ts` passes a test that reconstructs state by replaying events and asserts deep equality with the live checkpoint.
- [x] `src/core/activity.ts` supports `{ run, compensate, resourceScope, idempotencyKey }` activity definitions; `compensate` is optional but, if present, is registered.
- [x] `src/core/context.ts` exposes `ctx.saga(steps)` that runs activities in order and, on failure, runs `compensate` in reverse for every successfully-completed step.
- [x] `bun test src/core/__tests__/saga.test.ts` passes a 3-step saga test where step 3 fails and compensators for step 1 and step 2 run exactly once each, verified across an engine restart.
- [x] `bun run typecheck` and `bun test` both exit 0 after Track 1 lands.

### Track 2 — Testing and diagnosis

- [x] `src/testing/chaos.ts` exists with `ChaosScenario` type and `withChaos(mock, scenario)` combinator.
- [x] `TestEngine.runN(workflow, input, { runs: N, chaos })` returns `{ passRate: number; consistency: number; categories: Record<FailureCategory, number> }`.
- [x] `bun test src/testing/__tests__/chaos.test.ts` passes a suite asserting `passRate < 1.0` on a known-flaky workflow under a documented scenario.
- [x] `WorkflowState.failureCategory: 'memory' | 'reflection' | 'planning' | 'action' | 'system' | null` is populated on all failed workflows.
- [x] Search attributes include `failureCategory` so `engine.list({ attributes: { failureCategory: { equals: 'planning' }}})` works.
- [x] `weft validate <entry.ts>` CLI command exists; exits 0 on a clean workflow registration and non-zero when it detects any of: non-serializable closure in a workflow, stateful activity without a compensator, unbounded retry policy.
- [x] `src/core/constraint.ts` exists and exports `constraint(name, { scope, check, onViolation })`.
- [x] `engine.register(workflow, { constraints: [...] })` attaches constraints; constraints are evaluated at every checkpoint commit; `ConstraintViolatedEvent` fires on violation.
- [x] `bun test src/core/__tests__/constraints.test.ts` passes a test that a violated constraint with `onViolation: 'compensate'` triggers the workflow's saga compensators.

### Track 3 — Latency and throughput

- [x] `Activity` definitions support an optional `verify: (result) => Promise<boolean>` hook.
- [x] `ctx.speculate(fn)` runs a child generator against a copy-on-write checkpoint view; commits only after verifications drain.
- [x] On verification failure, the speculative branch is discarded and compensators (Track 1) run for any externalized effects.
- [x] Activity completions benchmark: `src/benchmarks/activity-completions.test.ts` reports a stable ≥13K/sec regression floor under benchmark-suite concurrency and high-18K/sec isolated direct runs (up from ~9K/sec; spec is >30K/sec).
- [x] Memory per workflow: `src/benchmarks/memory-per-workflow.test.ts` reports ~0.13KB current checkpoint blobs and ~0.73KB total durable footprint on 100K parked workflows (spec is ≤2KB).
- [x] `bun run typecheck` and `bun test` both exit 0 after Track 3 lands.

### Track 4 — Reliability and versioning

- [x] `src/observability/metrics.ts` exposes `weft.dpmo.defects` and `weft.dpmo.operations`, with a derived `weft_dpmo` gauge exported via the existing Prometheus path.
- [x] Event log entries (Track 1) record `(workflowVersion, toolVersions[])` on every event.
- [x] Resuming a workflow whose recorded version tuple is incompatible with the currently registered versions throws `VersionMismatchError` with a structured breakdown of which component mismatched.
- [x] `bun test` passes a test that rejects a mid-flight workflow across a tool-schema version bump.

### Track 6 — Storage ergonomics

The `Storage` interface is the right primitive for Weft internals (binary KV with range scans and atomic batch). But consumers building higher-level abstractions on top — application state, caches, session stores, configuration — hit friction that should be smoothed out at the Weft level rather than reimplemented by every consumer.

- [x] **`has(key)` method on `Storage`.** Returns `Promise<boolean>`. Adapters implement efficiently: SQLite uses `SELECT 1 … LIMIT 1`, LMDB checks key existence without value copy, Memory checks `Map.has()`. Avoids deserializing the full value just to check existence. Default implementation falls back to `get(key) !== null` so existing adapters aren't broken.
- [x] **`deletePrefix(prefix)` method on `Storage`.** Returns `Promise<number>` (count of deleted keys). SQLite uses `DELETE FROM kv WHERE key >= ? AND key < ?` in one statement. LMDB uses range delete. Memory iterates and deletes. Avoids the `scan()` → collect all keys → `batch(deletes)` round-trip that forces holding all keys in memory.
- [x] **`keys(prefix, options?)` method on `Storage`.** Returns `AsyncIterable<string>` (keys only, no values). Same signature as `scan()` minus the value in the tuple. SQLite uses `SELECT key FROM kv WHERE …` (no blob read). LMDB iterates keys without value materialization. Useful when consumers only need to list or count entries without reading payloads.
- [x] **`count(prefix)` method on `Storage`.** Returns `Promise<number>`. SQLite uses `SELECT COUNT(*) FROM kv WHERE …`. Avoids streaming every entry through an async iterator just to count. Useful for dashboards, health checks, and queue depth monitoring.
- [x] **`storage.scoped(prefix)` namespace utility.** Returns a `Storage` instance where all operations are transparently prefixed with `${prefix}:` and `scan()`/`keys()` results have the prefix stripped. Composes: `storage.scoped('a').scoped('b')` produces keys under `a:b:`. Shipped as a utility alongside `CompressedStorage`, with optional `storage.scoped(prefix)` support on Weft's built-in adapters and `ScopedStorage` itself, so third-party adapters are not required to implement it.
- [x] **`TypedStorage<T>` codec wrapper.** `withCodec(storage, codec)` returns a higher-level interface: `get(key): Promise<T | null>`, `put(key, value: T): Promise<void>`, with `scan`, `batch`, etc. forwarding through the codec. Ships with `jsonCodec` (JSON string round-trip) and `msgpackCodec` (MessagePack round-trip via the existing codec module). Eliminates `TextEncoder`/`TextDecoder` boilerplate for every consumer that stores structured data.
- [x] **All new methods are optional on the `Storage` interface.** Marked with `?` so existing third-party adapters aren't broken. Weft's built-in adapters (BunSQLite, LMDB, Memory, IndexedDB, Turso) implement all of them. The `scoped()` and `withCodec()` utilities work with any `Storage` that implements the core five methods.
- [x] **Tests cover all new methods across all built-in adapters.** The existing parametrized storage test factory (`src/testing/storage-backends.test-support.ts`) is extended with cases for `has`, `deletePrefix`, `keys`, and `count`. The `scoped()` and `withCodec()` utilities have dedicated test files.
- [x] `bun run typecheck` and `bun test` both exit 0 after Track 6 lands.

### Track 7 — Platform completeness

#### 7a. Scheduled and recurring workflows

Weft has durable `ctx.sleep()` for delays within a running workflow, but no way to express "run this workflow every hour" or "start this workflow at 3am on Tuesdays." Every durable execution platform eventually needs cron — Temporal has it, and consumers who don't get it from the engine build it themselves on top (usually badly).

- [x] **`engine.schedule(type, input, cronExpression, options?)` registers a recurring workflow.** Accepts a standard cron expression (5-field or 6-field with seconds). Returns a `ScheduleHandle` with `pause()`, `resume()`, `cancel()`, `update(newCron)`, and `describe()`.
- [x] **Schedules are durable.** Stored in storage under `schedule:{id}`. Survive process restarts. The scheduler scans for due schedules on startup and resumes ticking.
- [x] **Overlap policy is configurable.** `{ overlap: 'skip' | 'queue' | 'cancel-running' | 'allow' }`. Default: `'skip'` (if the previous run is still executing, don't start another). `'queue'` waits for the previous run to complete before starting. `'cancel-running'` cancels the previous run. `'allow'` starts regardless.
- [x] **Schedules support backfill.** If the engine was down and missed 3 ticks, `{ backfill: true }` runs them all on recovery. `{ backfill: false }` (default) skips missed ticks and resumes from the next future tick.
- [x] **Schedules are listable and queryable.** `engine.listSchedules(filter?)` returns all active schedules with their next fire time, last fire time, and status.
- [x] **`GET /v1/schedules` and `POST /v1/schedules` HTTP endpoints.** Full CRUD via REST. Dashboard shows schedule state, history, and next fire time.
- [x] **`weft schedule` CLI subcommand.** `weft schedule list`, `weft schedule create`, `weft schedule pause <id>`, `weft schedule cancel <id>`.
- [x] Tests cover: create/fire/cancel cycle, overlap policies, backfill after downtime, cron edge cases (Feb 29, DST transitions).

#### 7b. Delayed start

- [x] **`engine.start(type, input, { startAt: timestamp })` defers execution to a future time.** Workflow enters `'pending'` status immediately, transitions to `'running'` at the specified time. The pending workflow is visible via `engine.get()` and `engine.list()` before it starts.
- [x] **`engine.start(type, input, { startAfter: duration })` accepts a relative delay.** Converted to absolute timestamp at submission time. Uses the same `Duration` type as `ctx.sleep()` (number or string like `'30m'`).
- [x] **Delayed starts survive restarts.** Stored as `wf-delayed:{startAt}:{id}` in storage. Scheduler picks them up on recovery.
- [x] **Delayed starts are cancellable before execution.** `handle.cancel()` on a pending-but-not-yet-started workflow cancels without ever running.

#### 7c. Workflow composition operators

Child workflows exist, but composing them into pipelines, fan-out/fan-in DAGs, or conditional branches requires manual boilerplate.

- [x] **`ctx.pipe(stages)` runs a sequence of workflows where each stage's output is the next stage's input.** `stages` is an array of `{ type, options? }` or workflow functions. Returns the final stage's output. Each stage is independently checkpointed as a child workflow. If the pipeline fails at stage 3, recovery skips stages 1–2.
- [x] **`ctx.map(items, workflowType, options?)` runs a workflow for each item in parallel.** Like `ctx.all()` but parameterized over a collection. Supports `{ concurrency: number }` to limit parallelism. Returns results in input order.
- [x] **`ctx.reduce(items, workflowType, initialValue, options?)` sequentially folds items through a workflow.** Each invocation receives `{ accumulator, item, index }`. Returns the final accumulator. Checkpointed after each fold step.
- [x] Tests cover: 3-stage pipeline, pipeline failure at middle stage with compensation, map with concurrency limit, reduce over empty array, nested composition (pipe inside map).

#### 7d. Workflow garbage collection and TTL

- [x] **`EngineOptions.retention` configures automatic cleanup of terminal workflows.** Accepts `{ completed?: Duration, failed?: Duration, cancelled?: Duration, timedOut?: Duration }`. Default: no retention (keep forever). When set, a background sweep deletes workflows whose `updatedAt + TTL < now`.
- [x] **Retention sweep runs on a configurable interval.** Default: every 5 minutes. Deletes in batches (default 1000 per sweep) to avoid blocking storage.
- [x] **Retention is per-workflow-type overridable.** `engine.register(type, { handler, retention: { completed: '7d' } })` overrides the engine-level default for that type.
- [x] **Retention deletes all associated data.** Workflow state, checkpoints, checkpoint history, events, search attribute indexes, offloaded data, archived data, and stream chunks. One `batch()` call per workflow.
- [x] **`engine.purge(filter)` manually triggers cleanup.** For one-off housekeeping outside the automatic sweep.
- [x] Dashboard shows retention policy per workflow type and next scheduled sweep.

#### 7e. Lightweight tagging

- [x] **`StartOptions.tags` accepts `string[]`.** Tags are stored alongside workflow state and indexed for filtering. Unlike search attributes, tags require no schema declaration — they're free-form labels.
- [x] **`handle.addTags(...tags)` and `handle.removeTags(...tags)` mutate tags on a running workflow.** Changes are durable immediately when the tag mutation is persisted.
- [x] **`engine.list({ tags: ['nightly', 'v2'] })` filters by tag intersection.** A workflow matches if it has all specified tags.
- [x] **Tags are distinct from search attributes.** Search attributes are typed, schema-declared, and support range queries. Tags are untyped, schema-free, and support only equality/intersection. Both are useful; neither replaces the other.
- [x] Tags visible in dashboard workflow list as badges. Filterable via tag chips in the UI.

#### 7f. Bulk operations

- [x] **`engine.cancelAll(filter)` cancels all workflows matching a filter.** Returns `{ cancelled: number, failed: number, errors: Array<{ id, error }> }`. Filter supports the same shape as `engine.list()` (type, status, attributes, tags).
- [x] **`engine.signalAll(filter, name, payload?)` sends a signal to all matching workflows.** Returns `{ signalled: number, failed: number }`.
- [x] **`engine.deleteAll(filter)` permanently removes all matching terminal workflows.** Only operates on terminal statuses (completed, failed, cancelled, timed-out). Returns `{ deleted: number }`. Rejects if filter would match running workflows.
- [x] **`engine.tagAll(filter, tags)` and `engine.untagAll(filter, tags)` bulk-modify tags.** Returns `{ modified: number }`.
- [x] **All bulk operations have HTTP equivalents.** `POST /v1/workflows/bulk/cancel`, `POST /v1/workflows/bulk/signal`, `DELETE /v1/workflows/bulk`, `PATCH /v1/workflows/bulk/tags`.
- [x] **Bulk operations are batched internally.** Process in chunks of 1000 to avoid holding storage locks. Progress is observable via returned counts.
- [x] **Bulk operations support dry-run previews.** Passing `{ dryRun: true }` returns matched counts, scope summaries, sampled workflow IDs, and a confirmation token without mutating workflow state.
- [x] **Confirmed bulk operations reject stale scopes.** Committed cancel, signal, delete, and tag mutations validate the dry-run confirmation token against the current matched workflow set before mutating state.
- [x] **Confirmed bulk operations persist audit records.** Audit events capture the credential-safe caller principal, action, request ID, filter summary, affected count, sampled IDs, and confirmation token.
- [x] **Dashboard bulk actions require preview before commit.** Cancel, signal, delete, and tag mutations show the active scope and affected count before enabling confirmation.

#### 7g. Workflow forking

- [x] **`engine.fork(workflowId, options?)` creates a new workflow from an existing workflow's checkpoint.** The forked workflow starts from the same step with the same accumulated results, but gets a new ID and can diverge from that point. Original workflow is unaffected.
- [x] **Fork options include `{ fromStep?: number }`.** Default: fork from the latest checkpoint. `fromStep` allows forking from a historical checkpoint (if checkpoint history is retained).
- [x] **Fork records lineage.** Forked workflow state includes `forkedFrom: { workflowId, step }`. Queryable via search attribute `weft:forkedFrom`.
- [x] **`POST /v1/workflows/:id/fork` HTTP endpoint.** Returns the new workflow handle.
- [x] Tests cover: fork and diverge, fork from historical step, fork a completed workflow (starts from last checkpoint, re-runs terminal step), fork lineage chain (A → B → C).

#### 7h. Event replay and time-travel debugging

Weft already has a hash-chained event log — the data is there, but there's no query interface for inspecting or replaying it.

- [x] **`engine.getTimeline(workflowId)` returns a structured timeline.** Each entry includes: step number, operation type, input summary, output summary, duration, timestamp, and version tuple. This is a high-level view — not raw events, but a human-readable execution trace.
- [x] **`engine.replayTo(workflowId, step)` reconstructs workflow state at a historical step.** Returns the checkpoint, accumulated results, and event log up to that point. Read-only — does not modify the workflow.
- [x] **Dashboard timeline view.** Visual execution trace showing each step as a node: what operation ran, what it returned, how long it took, and what the checkpoint looked like at that point. Clicking a step shows the full checkpoint state (locals, accumulated results, search attributes).
- [x] **Dashboard diff view.** Select two steps and see what changed between them: new locals, changed search attributes, budget consumption delta, conversation growth.
- [x] **`GET /v1/workflows/:id/timeline` HTTP endpoint.** Returns the structured timeline as JSON.
- [x] **`weft timeline <workflowId>` CLI subcommand.** Prints the execution trace to stdout. `--step N` shows checkpoint state at step N. `--diff N M` shows the delta between two steps.

#### 7i. Streaming resumption tokens

Weft streams tokens over WebSocket with a reconnection buffer, but if the buffer has been flushed before the client reconnects, there's a gap.

- [x] **Every streamed chunk includes a monotonic `sequence: number`.** The sequence is persisted alongside the chunk in storage (`blob:{workflowId}:{key}:chunk:{sequence}`).
- [x] **Client reconnection accepts `{ resumeFrom: sequence }`.** Server replays all chunks with `sequence > resumeFrom` from storage, then switches to live streaming. No gaps, no duplicates.
- [x] **`GET /v1/workflows/:id/streams/:key?after=N` HTTP endpoint.** Returns chunks after sequence N as a JSON array (for non-WebSocket clients) or SSE stream.
- [x] **Resumption works across server restarts.** Since chunks are in storage, a client can reconnect to a different server instance and resume without loss.
- [x] Tests cover: disconnect and resume mid-stream, resume after server restart, resume with sequence=0 (replay all), resume after stream completion (returns all chunks immediately).

#### Final

- [x] `bun run typecheck` and `bun test` both exit 0 after Track 7 lands.

### Track 8 — Transport parity, shared contracts, and authorization

Track 8 extends the runtime surface without creating a second execution system. Every external transport remains an adapter over the existing `Engine` methods, typed `EventTarget` events, `BroadcastChannel` coordination, and Worker `postMessage` protocols (`WorkerInboundMessage` and `WorkerOutboundMessage`).

- [x] **The runtime API has one transport-neutral operation catalog.** It covers runtime operations only, not authoring APIs. Each entry defines the `Engine` method mapping, JSON Schema for params and result, auth requirement, authorization policy hook, REST route metadata, JSON-RPC method name, and shared error mappings.
- [x] **Authoring APIs remain intentionally TypeScript-only.** `engine.register()`, workflow/activity declarations, providers, storage adapters, interceptors, and execution-strategy wiring are documented as in-process authoring surfaces rather than transport-parity endpoints.
- [x] **Both `/openapi.json` and `/openrpc.json` are generated from the same operation catalog.** JSON-RPC is not inferred from OpenAPI, and OpenAPI is not treated as a lossy source for JSON-RPC.
- [x] **`rpc.discover` returns the same OpenRPC document exposed at `/openrpc.json`.** Clients can fetch the machine-readable JSON-RPC contract over JSON-RPC itself without a second documentation pipeline.
- [x] **`/openapi.json` is a full OpenAPI 3.1 contract for the REST-ish HTTP surface.** It includes path and query parameters, request bodies, response schemas by status code, shared error objects, and security declarations.
- [x] **REST and JSON-RPC requests dispatch into the same `Engine` methods.** No runtime feature lands on one transport without being modeled in the shared operation catalog first.
- [x] **The parity surface covers all data-driven runtime operations.** Workflow lifecycle, signals, updates, queries, review flows, attributes, checkpoints, events and timeline access, schedules, fork and bulk operations, and stream retrieval are all transport-addressable.

#### 8a. Eventing and stream projection

- [x] **Track 8 does not introduce a second orchestration layer or event bus.** External transports adapt the current engine/runtime primitives instead of replacing them.
- [x] **External subscriptions project from existing typed `EventTarget` events.** `Engine` and `WorkflowHandle` events remain the source of truth for watch and stream semantics.
- [x] **`BroadcastChannel` remains the internal cross-worker coordination primitive.** Transport-specific publish-subscribe machinery does not replace the current internal coordination model.
- [x] **Worker `postMessage` remains the internal worker execution protocol.** `WorkerInboundMessage` and `WorkerOutboundMessage` stay internal runtime messages; external JSON-RPC does not become a second worker protocol.
- [x] **One server-side event projection layer feeds every live transport.** WebSocket watch and token messages, SSE responses, JSON-RPC subscription notifications, and cursor-based replay all project from the same event stream model.
- [x] **All live views share the same sequence and cursor semantics.** Replay, resume, and ordering rules are identical across HTTP, WebSocket, and the Track 8 runtime stdio JSON-RPC transport.

#### 8b. JSON-RPC transport surface

- [x] **JSON-RPC 2.0 is supported over three runtime transports.** `POST /jsonrpc`, WebSocket upgrade on `/jsonrpc`, and newline-delimited JSON over a dedicated stdio runtime entrypoint. This stdio runtime surface is distinct from the existing MCP stdio transport exported from `@lostgradient/weft/mcp`; they may share framing or codec helpers if useful, but they are different protocol surfaces with different method namespaces and semantics.
- [x] **Runtime JSON-RPC methods use stable namespaced names.** Examples: `weft.workflows.start`, `weft.workflows.get`, `weft.workflows.signal`. These names belong to the runtime API surface and are not MCP method names.
- [x] **JSON-RPC uses named params only.** The OpenRPC contract documents `paramStructure: "by-name"` so generated clients and manual callers converge on one request shape.
- [x] **Batch requests are supported.** The shared dispatcher validates and executes JSON-RPC batches without inventing transport-specific behavior.
- [x] **Notifications are opt-in per call.** Per JSON-RPC 2.0, the caller opts in to fire-and-forget by omitting the `id` field; an id-present request always produces a wire response. Every cataloged operation runs the same pipeline (schema validation, authorization, invoke) regardless of id presence, so authorization failures and validation errors are recorded server-side either way. Mutating operations therefore default to request-response — every standard JSON-RPC client library includes `id` automatically; notifications are an explicit caller opt-in by omitting it.

  > **Drafting history**: this criterion was originally drafted as "opt-in per method" before the spec-compliance review surfaced that returning a wire error for id-less calls would itself violate JSON-RPC 2.0. The criterion text was amended in Wave 3 round 5 to match the actual spec-compliant semantic.

- [x] **Subscription notifications reuse the shared event projection layer.** Watch and stream APIs are documented as projections of current engine events rather than bespoke server-side state machines.

#### 8c. Error handling

- [x] **Reserved JSON-RPC protocol errors follow the specification exactly.** `-32700`, `-32600`, `-32601`, `-32602`, and `-32603` keep their standard meanings.
- [x] **Weft domain failures use a separate stable application error range outside the reserved protocol band.** Business and workflow errors do not overload the reserved JSON-RPC codes.
- [x] **JSON-RPC `error.data` carries structured machine-readable detail.** At minimum it includes the canonical Weft application code and the related HTTP status when the same failure is exposed over REST.
- [x] **REST and JSON-RPC share one engine-error mapping layer.** The same engine failure produces equivalent transport-level semantics across both surfaces.

#### 8d. Authentication and authorization

- [x] **The design documents current state accurately.** HTTP authentication already exists, and `serve()` authenticates the incoming `Request` before a WebSocket upgrade is accepted.
- [x] **Track 8 adds transport-neutral authorization for runtime operations.** REST, JSON-RPC over HTTP, JSON-RPC over WebSocket, SSE, and future transports all call the same per-operation authorization hook after authentication and before dispatch.
- [x] **WebSocket sessions bind authenticated identity at upgrade time.** Every JSON-RPC call on that socket reuses the established principal instead of re-authenticating per frame.
- [x] **stdio is a separate opt-in local entrypoint, disabled by default.** It is not implicitly enabled by `serve()` and is not treated as a public unauthenticated surface.
- [x] **stdio authorization uses the same operation-level policy hook once a session exists.** Local process boundaries are the default guard, with optional startup-token hardening for stricter deployments.

### Final verification

> Coverage rule: each behavioral or cross-cutting structural criterion has a real, non-skipped Bun test whose `it(...)` (or `test(...)` — the Bun aliases are equivalent) title contains, as a substring, the exact post-colon sentence of the matching bullet in `reference/track-8-criteria.md`. The bullet's leading slug id and the colon are not part of the quoted span; backticks may be stripped. The title is what `bun test` prints on failure, so this satisfies `final-6`'s "failure message names the criterion" phrasing. Design-invariant criteria are reviewed via the traceability matrix in `reference/track-8-traceability.md` and the rationale paragraphs in `reference/architecture/runtime-and-deployment.md`, not via runtime tests, because no runtime assertion can prove "we did not build a second orchestration layer."

- [x] `bun test` passes across the whole repo.
- [x] `bun run typecheck` exits 0.
- [x] `bun run lint` (oxlint) exits 0.
- [x] `bun run build` succeeds.
- [x] `bun build --compile src/cli-main.ts --outfile weft` produces a working binary.
- [x] `weft validate examples/**/*.ts` exits 0 on the bundled examples.
- [x] Every new primitive from this document has a dedicated test file under `src/` (either as a colocated `src/**/*.test.ts` file or under `src/**/__tests__/`) and every acceptance criterion above is covered by at least one `test(...)` call whose failure message names the criterion.
