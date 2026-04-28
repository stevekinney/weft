# Weft: A Bun-Native Durable Execution Engine

> _Weft_ — the cross-threads in weaving that bind the warp together.

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

5. **Agent-native.** The engine is designed around agent workloads: dynamic execution graphs, durable streaming, cost enforcement, human oversight, multi-agent coordination, context window management, and model routing are built into the core — not bolted on as wrappers around generic activities.

6. **Library/server parity.** Every capability exposed by the server's HTTP and WebSocket API is also available through the library's in-process `Engine` API — and vice versa. A developer who starts with `bun add weft` and later moves to the standalone server (or the reverse) should not lose features or change workflow code. The server is a deployment wrapper around the engine, not a superset of it.

---

## Why Not Temporal: Ten Design Failures Weft Eliminates

Temporal's replay-based architecture creates a cascade of constraints — determinism, versioning, history limits, sandbox, payload sensitivity — that manifest as developer experience pain. These are not bugs to fix; they are architectural consequences. Weft's checkpoint-based architecture eliminates the root cause, which means all the downstream constraints dissolve simultaneously.

Here is what a developer must learn to write their first workflow:

| Concept                | Temporal                          | Weft                                               |
| ---------------------- | --------------------------------- | -------------------------------------------------- |
| Core mental model      | Replay determinism                | Generators pause and resume                        |
| Activity invocation    | `proxyActivities()` + type import | `yield* ctx.run(fn, args)`                         |
| Timer                  | Deterministic `workflow.sleep()`  | `yield* ctx.sleep("1 hour")`                       |
| Signal                 | `setHandler` + `condition`        | `yield* ctx.waitForSignal(name)`                   |
| Versioning             | `patched()` / `deprecatePatch()`  | Deploy new code (migration optional)               |
| Long-running workflows | `continueAsNew()`                 | Nothing (checkpoints are fixed-size)               |
| Agent declaration      | N/A (build from primitives)       | `weft.agent()` top-level or `ctx.agent()` embedded |
| Dev environment        | Docker Compose + Temporal server  | `bun add weft`                                     |
| Bundling               | Webpack for workflow sandbox      | None                                               |

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

**Going further: stack-trace-preserving errors.** Every context method (`ctx.run`, `ctx.sleep`, `ctx.agent`) captures the caller's stack trace at call time — before the generator yields. When an activity fails after being dispatched to a remote worker and retried three times, the error shown to the developer includes the original call site in their workflow code:

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

**The Weft answer.** Checkpointing means code before the current checkpoint never re-executes. Changing steps after the current checkpoint is inherently safe. Versioning only matters for the step you are currently on — and even then, the migration path is a pure data transformation on the checkpoint, not code-path branching. (See: [Workflow Versioning](#14-workflow-versioning).)

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

**The Weft answer.** `bun add weft` or download a single binary. SQLite is the default database, embedded in the runtime. No external dependencies for development or small production deployments. (See: [Single Binary Distribution](#8-single-binary-distribution).)

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

**The Weft answer.** `yield* ctx.run(myFunction, args)`. You pass the actual function reference. The `yield*` makes the durable boundary explicit — no proxies, no type stubs, no magic. "Go to definition" takes you to the implementation. (See: [Checkpoint, Don't Replay](#1-checkpoint-dont-replay).)

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

**The Weft answer.** `ctx.agent()` as a first-class primitive with durable tool execution, token streaming, budget enforcement, and human-in-the-loop built in. (See: [AI-First Primitives](#12-ai-first-primitives).)

**Why this cannot be bolted onto Temporal.** Temporal's determinism constraint means LLM API calls must be activities. But activities are opaque to the workflow — you cannot stream tokens from an activity back to the workflow in real time. You cannot checkpoint mid-tool-call within an activity. Temporal's model forces agent loops into one of two bad choices:

1. **Fully in-activity:** The entire ReAct loop runs as one activity. Tool calls within it are not individually checkpointed. If the process crashes mid-loop, the entire agent conversation restarts from scratch.
2. **Fully in-workflow:** Each LLM call is a separate activity. But now every LLM response must be deterministically replayable — and LLM APIs are inherently non-deterministic. You need to store and replay every token, defeating the purpose of having a live model.

Weft's generator model avoids this dilemma. Each tool call is a separate `yield*` boundary, independently checkpointed. Token streaming flows through the standard `EventTarget` and `WebSocket` systems. The agent loop is durable _and_ live.

**Going further: multi-agent composition via existing primitives.** Agents are just activities with special configuration. The existing `ctx.run()` / `ctx.all()` / `ctx.race()` composition works naturally:

```typescript
async function* researchWorkflow(ctx: Context, topic: string) {
  // Sequential: researcher → critic → writer
  const research = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Research: ${topic}`,
    tools: [webSearch],
  });
  const critique = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Review:\n${research}`,
    tools: [factCheck],
  });
  const report = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Write report:\n${research}\n\nAddressing:\n${critique}`,
  });

  // Parallel: run multiple agents simultaneously
  const [legal, technical] = yield* ctx.all([
    ctx.agent({ model: 'claude-sonnet-4-20250514', prompt: `Legal review: ${report}` }),
    ctx.agent({ model: 'claude-sonnet-4-20250514', prompt: `Technical review: ${report}` }),
  ]);

  return { report, reviews: { legal, technical } };
}
```

Beyond fan-out, the agent-native engine supports `ctx.handoff()` for delegation with context transfer, `ctx.debate()` for adversarial multi-agent review, and `SharedState` for concurrent mutable state. See [Agent-Native Engine: Multi-Agent Coordination](#127-multi-agent-coordination) for the full treatment.

**Going further: cost observability with `ctx.setBudget()`.** Budget state is stored in the checkpoint and enforced via `AbortController`. Each `ctx.agent()` call reports token usage back to the budget tracker:

```typescript
async function* costAwareWorkflow(ctx: Context, input: Input) {
  ctx.setBudget({
    maxTokens: 100_000,
    maxCost: 5.0,
    models: {
      'claude-sonnet-4-20250514': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
    },
  });

  const draft = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Write analysis...',
  });

  const usage = ctx.budgetRemaining();
  // { tokensRemaining: 72_000, costRemaining: 3.42, breakdown: [...] }

  if (usage.costRemaining < 1.0) {
    // Switch to cheaper model
    return yield* ctx.agent({ model: 'claude-haiku-4-5-20251001', prompt: 'Summarize...' });
  }
}
```

This is just the per-workflow surface. The agent-native engine adds organization-level real-time budget enforcement, cost-aware retry policies, cost projection, and budget events through `EventTarget`. See [Agent-Native Engine: Cost as Execution Constraint](#123-cost-as-execution-constraint).

**Going further: tool result caching across agent turns.** When an agent calls the same tool with the same arguments across turns, Weft caches the result:

```typescript
const analysis =
  yield *
  ctx.agent({
    tools: [fetchCustomerData, queryDatabase],
    toolCache: true, // Default: true for idempotent tools
    toolCacheTTL: '5m', // Cache expires after 5 minutes
  });
```

On cache hit, the tool is not re-executed and no checkpoint boundary is created. This reduces both latency and cost for agent workflows that repeatedly access the same data. Beyond local function tools, the agent-native engine supports MCP server URLs as tool sources with dynamic discovery and schema validation. See [Agent-Native Engine: MCP-Native Tool Execution](#125-mcp-native-tool-execution).

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

**How Weft eliminates this.** Checkpoints store only the current state—not the history of every activity result. A workflow that processed 100 large LLM responses but only keeps the current conversation in a local variable has a checkpoint containing only that conversation. No history bloat, no payload caps, no `continueAsNew`. For streaming, `ctx.agent()` returns a `ReadableStream<string>` that bridges to `EventTarget`, WebSocket observers, and SSE endpoints natively. No Redis sidecar, no infrastructure outside the durability model. (See: [First-Class Streaming](#agent-native-engine-first-class-streaming), [ctx.offload()](#5-performance-issues-out-of-the-box), [Payload Compression](#10-payload-size-sensitivity).)

### 2. The Activity Boundary Is Too Coarse for Agent Loop Durability

This is the most architecturally significant friction. When teams integrate agent frameworks (OpenAI Agents SDK, PydanticAI, LangGraph) with Temporal, they face a fundamental question: _who controls the agent's execution loop?_

Today, the agent framework runs inside a Temporal activity. Temporal cannot provide durability, signals, child workflows, or timers within the agent's tool-calling cycle. If the agent makes 10 tool calls inside a single activity, Temporal sees one opaque operation—it can retry the whole thing, but cannot checkpoint between tool calls 5 and 6.

The alternative—decomposing the agent loop into individual Temporal activities—preserves durability at the right granularity but forces teams to abandon the framework and reimplement the loop in workflow code. A community member authored an extensive analysis of this dilemma ("The Lord of the Loop"), arguing that current integrations force agents to be "extremely narrow in scope—with only a few tools available." Temporal's response was candid: "You would need to find a way of breaking LangGraph up into serializable payloads...Until then, executing your LangGraph agents as one Temporal activity will work."

**How Weft eliminates this.** There is no dilemma because Weft's generator model makes each tool call a `yield*` boundary—independently checkpointed, individually retryable, observable at the right granularity. The agent loop _is_ the workflow. `defineAgent()` provides the durable ReAct loop as a first-class primitive: each LLM turn is a checkpoint, each tool call is a checkpoint, budget enforcement fires at turn boundaries, and token streaming flows through standard `ReadableStream` and `EventTarget`. No framework wrapping, no opaque activities, no forced choice between durability and agent ecosystem compatibility. (See: [Agent-Native Engine](#12-agent-native-engine), [Dynamic Execution Shape](#agent-native-engine-dynamic-execution-shape).)

### 3. The Python Sandbox Conflicts with Every Major AI/ML Library

Temporal's Python SDK sandbox—designed to enforce determinism via import isolation—conflicts with virtually every major AI/ML library. PyTorch, httpx, Pydantic V2, cryptography, debugpy, Loguru, and Protobuf all have documented sandbox conflicts. A GitHub issue requesting a "make option for all passthrough" is upvoted by an OpenAI employee. The practical result is that most AI teams either maintain extensive custom passthrough lists or disable the sandbox entirely with `UnsandboxedWorkflowRunner()`.

Nearly every AI/ML Python library depends on Pydantic V2, and the sandbox's re-importing causes models to be created with incorrect field types. An official Pydantic contrib module has been requested but not yet shipped.

**How Weft sidesteps this entirely.** Weft is TypeScript-native. There is no Python sandbox, no import isolation, no passthrough lists. The isolation that Temporal achieves through Webpack + sandbox, Weft achieves through Web Workers—OS-level process boundaries that don't restrict the language. You do not need to hobble the runtime to get safety. (See: [Web Worker Execution Model](#2-web-worker-execution-model), [TypeScript SDK-Specific Pain](#6-typescript-sdk-specific-pain-webpack-bundling-and-sandbox).)

---

## Competitive Landscape

Three durable execution platforms explicitly target Temporal's AI workload gaps. Teams evaluating Weft will encounter all of them. Here is how they compare architecturally—not as feature checklists, but as design trade-offs.

### Inngest

Inngest has the most complete AI-specific feature set among Temporal alternatives. `step.ai.infer()` provides native AI inference as a durable step with automatic token counting. `step.ai.wrap()` wraps any AI SDK with observability. `useAgent` provides a React hook for parts-based streaming from durable workflows to frontends via their Realtime feature. AgentKit provides first-class agent/network/router abstractions. Their observability dashboard offers SQL-queryable token usage and cost analysis.

**Where Inngest leads:** Serverless suspension during LLM inference waits. When `step.ai.infer()` calls an LLM API, the function doesn't run (or charge) while waiting for the response. Weft workers must remain running during all LLM wait times—this is a genuine capability gap.

**Where Weft leads:** Durability model. Inngest uses an event-driven step function model, not checkpoint-based recovery. Weft's O(1) checkpoint recovery, constant-size state regardless of history length, and no event/history limits provide stronger durability guarantees for long-running agent workflows. Weft's generator-based agent loop provides finer-grained checkpointing than Inngest's step-level boundaries. Weft also runs as a self-contained library or single binary with embedded storage—no cloud dependency required.

### Restate

Restate competes on architecture and latency. Virtual Objects provide session-scoped stateful entities—a natural fit for multi-turn AI conversations where each session maintains state. Their durable AI loops approach demonstrates wrapping existing AI SDKs (Vercel AI SDK, OpenAI Agent SDK, Google ADK, Pydantic AI) via simple middleware. Single-binary, zero-dependency deployment targets Temporal's infrastructure complexity.

**Where Restate leads:** Virtual Objects provide built-in session affinity with co-located state—no sticky routing configuration needed. User code suspension during async waits (similar to Inngest) allows processes to be shut down during LLM calls.

**Where Weft leads:** Agent-native primitives. Restate provides durable execution primitives; Weft provides agent-level abstractions (budget enforcement, context window management, model routing, human-in-the-loop, multi-agent coordination) built into the core. Restate requires building these from scratch. Weft's `SharedState` with optimistic concurrency provides similar concurrent state access to Virtual Objects but within the checkpoint model.

### Hatchet

Hatchet positions as simpler Temporal with AI-first design. Native result streaming, FIFO/LIFO/Round Robin/Priority queue policies for multi-tenant fairness, built-in human-in-the-loop eventing, and Postgres-only self-hosting.

**Where Hatchet leads:** Queue scheduling policies (priority, FIFO, round-robin) are more sophisticated than Weft's current least-loaded routing.

**Where Weft leads:** Weft exceeds Hatchet on streaming (multiplexed ReadableStream with backpressure vs. result streaming), storage flexibility (SQLite, LMDB, Turso, IndexedDB vs. Postgres-only), agent primitives (budgets, model routing, context strategies, MCP integration), and deployment flexibility (library mode, single binary, browser via Service Worker).

### Summary

| Capability                | Temporal           | Inngest            | Restate            | Hatchet           | Weft                     |
| ------------------------- | ------------------ | ------------------ | ------------------ | ----------------- | ------------------------ |
| Durability model          | Event replay       | Step functions     | Journal replay     | Event-driven      | Checkpoint               |
| Recovery cost             | O(n) history       | Step-level         | O(n) journal       | Step-level        | O(1) checkpoint          |
| Native streaming          | No (Redis sidecar) | Realtime + hooks   | No                 | Result streaming  | ReadableStream           |
| Agent loop durability     | Activity-level     | Step-level         | Context call-level | Step-level        | Yield-level              |
| AI observability          | External only      | Built-in dashboard | External only      | Basic             | Events + OTel            |
| Budget enforcement        | DIY                | Token counting     | DIY                | DIY               | Per-agent + org          |
| Human-in-the-loop         | DIY                | DIY                | DIY                | Built-in eventing | Built-in protocol        |
| Context window management | DIY                | DIY                | DIY                | DIY               | Pluggable strategies     |
| Multi-agent coordination  | DIY                | AgentKit           | DIY                | DIY               | Handoff/Debate/Supervise |
| Model routing             | DIY                | DIY                | DIY                | DIY               | Fallback/Cost-tier/A-B   |
| Serverless suspension     | No                 | Yes                | Yes                | No                | No                       |
| Self-hosted single binary | No                 | No                 | Yes                | No (Postgres)     | Yes (SQLite)             |
| Browser runtime           | No                 | No                 | No                 | No                | Yes (Service Worker)     |

---

## Honest Gaps

Weft addresses the majority of Temporal's AI workload pain points through architectural choices (checkpoint vs. replay) and built-in agent primitives. Three gaps remain. Each is tracked as an acceptance criterion in the "Competitive Parity & Gap Closure" section of the Roadmap later in this document.

**Serverless suspension during LLM inference waits.** When a Weft activity calls an LLM API, the worker process sits idle waiting for the response—often for seconds to minutes. Inngest's `step.ai.infer()` and Restate's journal-based suspension offload inference and suspend the function entirely, meaning the function doesn't run (or charge) while waiting. Weft workers must remain running and consuming resources during all LLM wait times. A future yield-and-resume pattern for remote workers could address this, but it isn't implemented. _Tracked in Competitive Parity & Gap Closure: "Serverless suspension primitive" and "Agent-loop suspension integration."_

**AI observability dashboard.** The _data_ is comprehensive: `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`, `AgentBudgetWarningEvent`, per-turn cost waterfall, conversation history queries, OTel spans with agent attributes. What's missing is a dedicated AI dashboard view for prompt/response inspection, token usage visualization over time, cost analytics, and model performance comparison. The built-in dashboard shows workflow-level state; it doesn't yet surface the agent-specific observability data in a purpose-built UI. _Tracked in Competitive Parity & Gap Closure: "AI dashboard detail view."_

**Multi-tenant workflow behavior customization.** Weft provides namespace-scoped budget enforcement (`BudgetPolicyEnforcer` with daily/monthly limits), search attributes for tenant filtering, and task queue names for routing. But per-tenant tool sets, custom validation logic, or conditional workflow steps require application-level parameterization—there's no built-in mechanism for multi-tenant workflow behavior branching beyond what you'd build yourself with configuration objects. _Tracked in Competitive Parity & Gap Closure: "Multi-tenant context" and "Per-tenant agent customization."_

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

**Agent:** A durable LLM-powered execution loop (ReAct pattern) that calls tools, manages context, and respects budgets and human review. Registered via `weft.agent()` as a standalone workflow or invoked via `ctx.agent()` as a step within a larger workflow.

**Turn:** A single iteration of an agent loop: one LLM call and its resulting tool calls. Each turn is a checkpoint boundary.

**Model Router:** A pluggable component that selects which LLM model to use for each turn based on conversation state, cost constraints, and quality requirements.

**Context Strategy:** A pluggable component that manages conversation history within the LLM's context window using techniques like sliding window, summarization, or RAG.

**MCP (Model Context Protocol):** A standard protocol for discovering and invoking LLM tools from external servers. Supports stdio and HTTP+SSE transports.

**Shared State:** A CAS-backed durable mutable state primitive that multiple concurrent agents can read from and write to without clobbering each other's writes.

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
  static readonly type = 'agent:token' as const;
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

// ─── Agent Event Definitions ───

export class AgentTurnStartedEvent extends Event {
  static readonly type = 'agent:turn:started' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly inputTokenEstimate: number;
  readonly conversationLength: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    inputTokenEstimate: number,
    conversationLength: number,
  ) {
    super(AgentTurnStartedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.inputTokenEstimate = inputTokenEstimate;
    this.conversationLength = conversationLength;
  }
}

export class AgentTurnCompletedEvent extends Event {
  static readonly type = 'agent:turn:completed' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly selectedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly cumulativeCost: number;
  readonly duration: number;
  readonly toolCallCount: number;
  readonly fallbackAttempts: number;
  readonly reasoningTrace: string | undefined;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    model: string,
    selectedModel: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    cumulativeCost: number,
    duration: number,
    toolCallCount: number,
    fallbackAttempts: number,
    reasoningTrace?: string,
  ) {
    super(AgentTurnCompletedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.model = model;
    this.selectedModel = selectedModel;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cost = cost;
    this.cumulativeCost = cumulativeCost;
    this.duration = duration;
    this.toolCallCount = toolCallCount;
    this.fallbackAttempts = fallbackAttempts;
    this.reasoningTrace = reasoningTrace;
  }
}

export class AgentToolCalledEvent extends Event {
  static readonly type = 'agent:tool:called' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly source: 'local' | 'mcp';
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    toolInput: unknown,
    source: 'local' | 'mcp',
    operationId: string,
  ) {
    super(AgentToolCalledEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.toolInput = toolInput;
    this.source = source;
    this.operationId = operationId;
  }
}

export class AgentToolReturnedEvent extends Event {
  static readonly type = 'agent:tool:returned' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly duration: number;
  readonly success: boolean;
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    duration: number,
    success: boolean,
    operationId: string,
  ) {
    super(AgentToolReturnedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.duration = duration;
    this.success = success;
    this.operationId = operationId;
  }
}

export class AgentBudgetWarningEvent extends Event {
  static readonly type = 'agent:budget:warning' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly budgetUsedPercent: number;
  readonly tokensRemaining: number;
  readonly costRemaining: number;
  readonly threshold: number;

  constructor(
    workflowId: string,
    agentId: string,
    budgetUsedPercent: number,
    tokensRemaining: number,
    costRemaining: number,
    threshold: number,
  ) {
    super(AgentBudgetWarningEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.budgetUsedPercent = budgetUsedPercent;
    this.tokensRemaining = tokensRemaining;
    this.costRemaining = costRemaining;
    this.threshold = threshold;
  }
}

export class AgentBudgetExceededEvent extends Event {
  static readonly type = 'agent:budget:exceeded' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly tokenBudget: number;
  readonly maxCost: number;

  constructor(
    workflowId: string,
    agentId: string,
    tokensUsed: number,
    costUsed: number,
    tokenBudget: number,
    maxCost: number,
  ) {
    super(AgentBudgetExceededEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.tokensUsed = tokensUsed;
    this.costUsed = costUsed;
    this.tokenBudget = tokenBudget;
    this.maxCost = maxCost;
  }
}

export class AgentContextCompactedEvent extends Event {
  static readonly type = 'agent:context:compacted' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesDropped: number;

  constructor(
    workflowId: string,
    agentId: string,
    strategy: string,
    tokensBefore: number,
    tokensAfter: number,
    messagesDropped: number,
  ) {
    super(AgentContextCompactedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.strategy = strategy;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.messagesDropped = messagesDropped;
  }
}

export class AgentModelFallbackEvent extends Event {
  static readonly type = 'agent:model:fallback' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly failedModel: string;
  readonly failedReason: string;
  readonly nextModel: string;
  readonly attemptIndex: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    failedModel: string,
    failedReason: string,
    nextModel: string,
    attemptIndex: number,
  ) {
    super(AgentModelFallbackEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.failedModel = failedModel;
    this.failedReason = failedReason;
    this.nextModel = nextModel;
    this.attemptIndex = attemptIndex;
  }
}

export class AgentProviderCircuitOpenEvent extends Event {
  static readonly type = 'agent:provider:circuit-open' as const;
  readonly provider: string;
  readonly errorRate: number;
  readonly threshold: number;
  readonly windowDuration: number;
  readonly cooldownDuration: number;

  constructor(
    provider: string,
    errorRate: number,
    threshold: number,
    windowDuration: number,
    cooldownDuration: number,
  ) {
    super(AgentProviderCircuitOpenEvent.type);
    this.provider = provider;
    this.errorRate = errorRate;
    this.threshold = threshold;
    this.windowDuration = windowDuration;
    this.cooldownDuration = cooldownDuration;
  }
}

export class HumanReviewRequestedEvent extends Event {
  static readonly type = 'human:review:requested' as const;
  readonly workflowId: string;
  readonly agentId: string | undefined;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];
  readonly timeout: string | undefined;

  constructor(
    workflowId: string,
    agentId: string | undefined,
    reviewId: string,
    reviewType: string,
    reviewers: string[],
    timeout?: string,
  ) {
    super(HumanReviewRequestedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.reviewId = reviewId;
    this.reviewType = reviewType;
    this.reviewers = reviewers;
    this.timeout = timeout;
  }
}

export class HumanReviewCompletedEvent extends Event {
  static readonly type = 'human:review:completed' as const;
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
    super(HumanReviewCompletedEvent.type);
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
  [AgentTurnStartedEvent.type]: AgentTurnStartedEvent;
  [AgentTurnCompletedEvent.type]: AgentTurnCompletedEvent;
  [AgentToolCalledEvent.type]: AgentToolCalledEvent;
  [AgentToolReturnedEvent.type]: AgentToolReturnedEvent;
  [AgentBudgetWarningEvent.type]: AgentBudgetWarningEvent;
  [AgentBudgetExceededEvent.type]: AgentBudgetExceededEvent;
  [AgentContextCompactedEvent.type]: AgentContextCompactedEvent;
  [AgentModelFallbackEvent.type]: AgentModelFallbackEvent;
  [AgentProviderCircuitOpenEvent.type]: AgentProviderCircuitOpenEvent;
  [HumanReviewRequestedEvent.type]: HumanReviewRequestedEvent;
  [HumanReviewCompletedEvent.type]: HumanReviewCompletedEvent;
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
    Bun.serve({ port, fetch: (req) => handleHTTP(engine, req) }),
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

Activities are registered by string name and looked up at dispatch time. The registry is a simple `Map<string, Function>` — straightforward and predictable:

```typescript
// Actual implementation in engine.ts
#activityRegistrations: Map<string, (...arguments_: unknown[]) => unknown>;

registerActivity(name: string, fn: (...arguments_: unknown[]) => unknown): void {
  this.#activityRegistrations.set(name, fn);
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
bun add weft

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

import { Engine } from 'weft/core';
import { IndexedDBStorage } from 'weft/storage/indexeddb';
import { handleHTTP } from 'weft/server/handler'; // Pure request→response, no Bun.serve dependency

const engine = new Engine({
  storage: new IndexedDBStorage('weft'),
});

// Intercept fetch events — same API as the HTTP server
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/weft/')) {
    event.respondWith(handleHTTP(engine, event.request));
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

Bun 1.3 introduced route-based `Bun.serve()` which is the most idiomatic way to define an HTTP API:

```typescript
import { serve } from 'bun';

const server = serve({
  port: 7233,

  routes: {
    // Workflow Management (JSON API)
    'POST /v1/workflows': async (req) => {
      const body = await req.json();
      const handle = await engine.start(body.type, body.input, {
        idempotencyKey: body.idempotencyKey,
        executionTimeout: body.executionTimeout,
        searchAttributes: body.searchAttributes,
      });
      return Response.json({ id: handle.id, status: 'running' }, { status: 201 });
    },

    'GET /v1/workflows/:id': async (req) => {
      const workflow = await engine.get(req.params.id);
      if (!workflow) return new Response('Not found', { status: 404 });
      return Response.json(workflow);
    },

    'DELETE /v1/workflows/:id': async (req) => {
      await engine.cancel(req.params.id);
      return new Response(null, { status: 204 });
    },

    'POST /v1/workflows/:id/signal/:name': async (req) => {
      const payload = await req.json();
      await engine.signal(req.params.id, req.params.name, payload);
      return Response.json({ delivered: true });
    },

    'GET /v1/workflows/:id/query/:name': async (req) => {
      const result = await engine.query(req.params.id, req.params.name);
      return Response.json(result);
    },

    // Search Attributes
    'GET /v1/workflows/:id/attributes': async (req) => {
      const attributes = await engine.getAttributes(req.params.id);
      if (!attributes) return new Response('Not found', { status: 404 });
      return Response.json(attributes);
    },

    'PATCH /v1/workflows/:id/attributes': async (req) => {
      const attributes = await req.json();
      await engine.setAttributes(req.params.id, attributes);
      return Response.json({ updated: true });
    },

    // Synchronous Updates
    'POST /v1/workflows/:id/update/:name': async (req) => {
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

    'GET /v1/updates/:updateId': async (req) => {
      const response = await engine.getUpdateResponse(req.params.updateId);
      if (!response) return Response.json({ status: 'pending' }, { status: 202 });
      return Response.json({ status: 'completed', result: response.result, error: response.error });
    },

    'GET /v1/workflows': async (req) => {
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

    // Agent-Specific Endpoints
    'GET /v1/workflows/:id/conversation': async (req) => {
      const conversation = await engine.query(req.params.id, 'agentConversation');
      if (!conversation) return new Response('Not found', { status: 404 });
      return Response.json(conversation);
    },

    'GET /v1/workflows/:id/cost': async (req) => {
      const cost = await engine.query(req.params.id, 'agentCostWaterfall');
      if (!cost) return new Response('Not found', { status: 404 });
      return Response.json(cost);
    },

    'GET /v1/reviews': async (_req) => {
      // Note: listReviews() does not yet accept a filter argument; status filtering is planned
      const reviews = await engine.listReviews();
      return Response.json(reviews);
    },

    'GET /v1/workflows/:id/review/:reviewId': async (req) => {
      // getReview() lives on HumanReviewCoordinator, not Engine directly
      const reviews = await engine.listReviews();
      const review = reviews.find(
        (r) => r.reviewId === req.params.reviewId && r.workflowId === req.params.id,
      );
      if (!review) return new Response('Not found', { status: 404 });
      return Response.json(review);
    },

    'POST /v1/workflows/:id/review/:reviewId': async (req) => {
      const { decision, reviewer, feedback } = await req.json();
      await engine.submitReview(req.params.reviewId, {
        decision,
        reviewer,
        feedback,
        workflowId: req.params.id,
      });
      return Response.json({ submitted: true });
    },

    // Health + Metrics
    'GET /v1/health': () => Response.json({ status: 'ok' }),
    'GET /v1/metrics': async () =>
      new Response(await engine.metrics(), {
        headers: { 'Content-Type': 'text/plain' },
      }),

    // Dashboard (embedded SPA)
    '/ui/*': (req) => new Response(Bun.file(dashboardHTML)),
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

    // Agent-specific streaming (turns + tokens + tool calls)
    if (url.pathname.match(/^\/v1\/workflows\/[\w-]+\/agent-stream$/)) {
      const id = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'agent', workflowId: id } })) return;
    }

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { type } = ws.data;
      if (type === 'worker') ws.subscribe(`tasks:${ws.data.queue}`);
      if (type === 'watch') ws.subscribe(`events:${ws.data.workflowId}`);
      if (type === 'tokens') ws.subscribe(`tokens:${ws.data.workflowId}`);
      if (type === 'agent') ws.subscribe(`agent:${ws.data.workflowId}`);
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
import { Worker } from 'weft/worker';

import { charge } from './activities/charge.ts';
import { ship } from './activities/ship.ts';
import { sendEmail } from './activities/email.ts';

const worker = new Worker({
  serverUrl: 'ws://weft-server:7233/v1/tasks/default/stream',
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
│ 1. Worker connects: WS /v1/tasks/:queue/stream                 │
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

Heartbeat details are queryable from the workflow via `handle.query("activityProgress")`, enabling progress UIs without custom plumbing.

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
"GET /v1/tasks/:queue": async (req) => {
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
"POST /v1/tasks/:queue/result": async (req) => {
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
      `${serverUrl}/v1/tasks/${queue}?timeout=30000&activities=${activityNames}`,
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

    await fetch(`${serverUrl}/v1/tasks/${queue}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: task.operationId, outcome, value, error }),
    });
  }
}
```

The long-poll client is intentionally simple — it can run in Deno, Cloudflare Workers, Node.js, or even a browser. The tradeoff versus WebSocket is higher latency (up to the poll timeout) and no server-push cancellation. For most use cases, WebSocket is preferred; long-poll is the compatibility escape hatch.

### 12. Agent-Native Engine

The current `ctx.agent()` could be mistaken for "a durable LLM API call with some options." That is agent-_compatible_, not agent-_native_. Agent execution has a fundamentally different shape (dynamic loops, not static DAGs), a different output mode (streams, not values), a different cost model (tokens, not compute), a different interaction model (human conversation, not fire-and-forget), and a different coordination model (handoff and debate, not just fan-out/fan-in). This section describes how each of these differences is reflected in the engine's primitives, storage model, event system, and observability layer.

#### Why AI Agents Cannot Be Bolted Onto Temporal

Temporal's determinism constraint creates a fundamental tension with LLM-based agent loops. LLM API calls must be activities (since they are non-deterministic network calls). But activities are opaque to the workflow — the workflow dispatches an activity and waits for the result. This forces agent loops into one of two bad choices:

1. **Fully in-activity.** The entire ReAct loop (LLM call → tool selection → tool execution → LLM call) runs as a single activity. Tool calls within it are not individually checkpointed. If the process crashes mid-loop after executing 5 of 10 tool calls, the entire agent conversation restarts from scratch — including re-executing all tool calls with their side effects.

2. **Fully in-workflow.** Each LLM call is a separate activity. But Temporal's replay model requires every activity result to be deterministically reproducible from the event history. LLM APIs are inherently non-deterministic — the same prompt can produce different outputs. Storing and replaying every LLM response defeats the purpose of having a live model and creates enormous event histories.

Weft's generator model avoids this dilemma entirely. Each tool call within an agent loop is a separate `yield*` checkpoint boundary. Token streaming flows through the standard `EventTarget` and `WebSocket` systems in real time. The agent loop is simultaneously durable (each tool call is individually checkpointed) and live (tokens stream as they arrive). No other durable execution engine offers this combination.

---

#### 12.1 Dynamic Execution Shape

Traditional workflows are **static DAGs** — you know the steps at compile time. "Charge card, reserve inventory, send email." The graph is fixed. Temporal was designed for this: you define the sequence, it executes it durably.

Agent loops are **dynamic, emergent graphs**. The LLM decides what to do next based on what it learned from the last step. You don't know at workflow-definition time whether the agent will make 3 tool calls or 30. You don't know which tools it will call. The "workflow" is a loop where the control flow is determined at runtime by a probabilistic model.

Weft's generator model handles this naturally. A `while` loop with `yield*` inside it creates checkpoints at each tool call without declaring the graph shape upfront:

```typescript
async function* researchAgent(ctx: Context, topic: string) {
  let findings: string[] = [];
  let confidence = 0;

  // The loop runs until the agent is confident enough.
  // We don't know how many iterations this will take.
  while (confidence < 0.8) {
    const result = yield* ctx.agent({
      model: 'claude-sonnet-4-20250514',
      prompt: `Research "${topic}". Current findings:\n${findings.join('\n')}`,
      tools: [webSearch, readDocument, analyzeData],
      maxTurns: 5,
    });

    findings.push(result.summary);
    confidence = result.confidence;

    // Each iteration creates checkpoints at every tool call.
    // If we crash after 7 iterations, we resume at iteration 7 — not restart from 0.
    // The checkpoint contains only: { findings, confidence } — bounded size.
  }

  return { findings, confidence };
}
```

**Storage implications.** The checkpoint stores only the current state — `wf:{id}:ckpt` is a single key containing the generator's local variables at the pause point. Whether the agent executed 3 tool calls or 300, the checkpoint size depends only on what's in scope, not on execution history. The step index is a monotonic counter that increments with each `yield*` regardless of origin — no step-count pre-declaration required.

This is the fundamental advantage over static DAG engines (Airflow, Prefect, Step Functions) where the graph shape must be known at declaration time. Agent workloads are inherently dynamic, and the engine must embrace that dynamism rather than forcing agents into a fixed structure.

**Going further: bounded checkpoint growth.** Even though checkpoint size is independent of step count, the conversation history accumulated by an agent loop grows linearly with turns. The engine monitors this: `CheckpointSizeWarningEvent` fires when an agent's checkpoint exceeds a configurable threshold (default: 64KB). The [Context Window Management](#126-context-window-management) strategy determines how old conversation history is compacted or archived. `ctx.offload()` and `ctx.archive()` let the workflow explicitly move large intermediate state out of the checkpoint.

---

#### 12.2 First-Class Streaming

In traditional workflows, the result is a structured object returned at the end. In agent workflows, the result is **a stream of tokens being generated in real-time**, and users need to see them as they're generated. This is not "nice to have" — it is the core UX. An interface that waits 45 seconds for a complete response and then dumps it all at once is unusable.

The engine treats `ReadableStream` as a first-class data type — not just a convenience bridge to WebSocket observers.

**Stream multiplexer.** A single LLM response stream fans out to multiple consumers without duplicating the API call:

```typescript
// Inside the engine's agent runner:
// One LLM API call, multiple consumers.
const llmStream = await provider.stream(messages, { signal });

// Fan out to: checkpoint accumulator, EventTarget, all WebSocket subscribers
const [checkpointStream, observerStream] = llmStream.tee();

// Checkpoint accumulator: builds up the turn's text for crash recovery
const turnText = await accumulateStream(checkpointStream);

// Observer stream: bridges to EventTarget and WebSocket
observerStream.pipeTo(
  new WritableStream({
    write(token) {
      // Dispatch to EventTarget (local listeners)
      handle.dispatchEvent(new TokenEvent(workflowId, token, model));
      // Publish to WebSocket subscribers (remote observers)
      server.publish(`workflow:${workflowId}:stream`, JSON.stringify({ type: 'token', token }));
    },
  }),
);
```

**Crash recovery mid-stream.** When a process crashes while tokens are streaming, the engine resumes from the last completed tool call or turn boundary — not the beginning of the agent loop. The partial token output from the interrupted turn is discarded, and the LLM call is re-issued for that turn only. Clients reconnect and receive the accumulated output from prior turns:

```typescript
// Client reconnection protocol:
// 1. Client connects to WS /v1/workflows/:id/stream
// 2. Server sends accumulated output from completed turns (replay buffer)
// 3. Server streams live tokens from the current turn

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'replay':
      // Accumulated output from turns completed before the crash/reconnect
      appendToUI(msg.content);
      break;
    case 'token':
      // Live token from the current turn
      appendToUI(msg.token);
      break;
    case 'turn:completed':
      // A full turn finished — tool calls, results, everything
      updateTurnUI(msg.turn);
      break;
  }
});
```

**Backpressure.** `ReadableStream`'s built-in backpressure mechanism propagates from slow consumers. If a WebSocket client cannot keep up, the stream's `desiredSize` on the controller drops to zero, signaling the producer to slow down. The engine buffers up to a configurable limit (default: 64KB). If the buffer fills, the slow client is disconnected with a `stream:backpressure` close frame rather than allowing unbounded memory growth:

```typescript
const engine = new Engine({
  streaming: {
    maxBufferSize: 64 * 1024, // 64KB per client
    replayBufferTurns: 5, // Keep last 5 turns for reconnecting clients
  },
});
```

**SSE fallback.** For environments where WebSocket is unavailable, `GET /v1/workflows/:id/stream` with `Accept: text/event-stream` returns a Server-Sent Events stream. Same multiplexer, different transport. The SSE stream supports `Last-Event-ID` for reconnection.

**Going further: accumulated turn text in checkpoint.** The text generated so far in the current turn is included in the checkpoint state. On recovery, the engine knows exactly what has been streamed to clients, enabling seamless replay without re-requesting completed content from the LLM.

---

#### 12.3 Cost as Execution Constraint

In traditional workflows, "cost" is compute time — linear, predictable, and cheap. In agent workflows, cost is **token consumption**: non-linear (a single bad tool call can trigger a 50,000-token context window), unpredictable (the LLM decides how many turns to take), expensive (a single agent run can cost $5–50), and per-model (different models in the same workflow have different pricing).

Cost is not a metric to observe after the fact. It is an **execution constraint** enforced in the hot path of every LLM call.

**Workflow-level budgets** span all agent calls within a single workflow execution, including child workflows:

```typescript
async function* analysisWorkflow(ctx: Context, input: Input) {
  // Budget spans ALL agent calls in this workflow
  ctx.setBudget({
    maxTokens: 200_000,
    maxCost: 10.0,
    warningThreshold: 0.8, // AgentBudgetWarningEvent at 80%
    models: {
      'claude-sonnet-4-20250514': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
      'claude-haiku-4-5-20251001': { inputCostPer1K: 0.0008, outputCostPer1K: 0.004 },
    },
  });

  const research = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Research the market...',
    tools: [webSearch],
  });

  // Check remaining budget before expensive analysis
  const remaining = ctx.budgetRemaining();
  // { tokensRemaining: 142_000, costRemaining: 7.31, breakdown: [...] }

  if (remaining.costRemaining < 2.0) {
    // Switch to cheaper model for remaining work
    return yield* ctx.agent({
      model: 'claude-haiku-4-5-20251001',
      prompt: `Summarize: ${research}`,
    });
  }

  return yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Deep analysis: ${research}`,
    tools: [dataQuery, chartGenerator],
  });
}
```

**Organization-level budgets** enforce daily and monthly limits per namespace across all workflows:

```typescript
engine.setBudgetPolicy({
  namespace: 'production',
  daily: { maxCost: 500.0 }, // $500/day across all workflows
  monthly: { maxCost: 10_000.0 }, // $10K/month cap
  enforcement: 'real-time', // Checked on every LLM call, not just on agent start
});
```

Organization budget counters are stored at `budget:{namespace}:daily:{YYYY-MM-DD}` and `budget:{namespace}:monthly:{YYYY-MM}`. They are kept in memory for fast enforcement and flushed to storage atomically with each agent turn checkpoint via `batch()`. Exceeding the limit rejects new `ctx.agent()` calls with `OrganizationBudgetExceededError` before the LLM API call is made.

**Cost-aware retry.** Retry policies include cost constraints alongside attempt limits:

```typescript
const analysis =
  yield *
  ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Analyze...',
    retry: {
      maxAttempts: 3,
      maxCost: 2.0, // Stop retrying if cumulative retry cost exceeds $2
      backoff: 'exponential',
    },
  });
```

Before retrying a failed agent call, the engine checks `ctx.budgetRemaining()`. If the estimated retry cost (based on the previous turn's token count) exceeds the remaining budget, the retry is skipped and `BudgetExceededError` is thrown instead.

**Cost events** flow through the standard `EventTarget` system:

```typescript
engine.addEventListener(AgentBudgetWarningEvent.type, (event) => {
  console.warn(
    `Budget warning: workflow ${event.workflowId} at ${event.budgetUsedPercent}%`,
    `($${event.costRemaining} remaining)`,
  );
});

engine.addEventListener(AgentBudgetExceededEvent.type, (event) => {
  console.error(
    `Budget exceeded: workflow ${event.workflowId}`,
    `spent $${event.costUsed} (limit: $${event.maxCost})`,
  );
});
```

**Cost projection.** `ctx.budgetProjection()` estimates remaining capacity based on the current burn rate:

```typescript
const projection = ctx.budgetProjection();
// {
//   estimatedTurnsRemaining: 12,
//   estimatedCostAtCompletion: 8.50,
//   averageCostPerTurn: 0.42,
//   burnRate: { tokensPerMinute: 3200, costPerMinute: 0.14 },
// }
```

**Cost as search attribute.** Each `ctx.agent()` call automatically updates a `weft:tokenCost` search attribute with cumulative USD cost, enabling cross-workflow cost queries: `engine.list({ filter: "weft:tokenCost > 5.0" })`.

**Going further: cost tracking uses AbortController for budget enforcement.** The same `AbortController` pattern used for workflow cancellation and timeouts enforces budgets:

```typescript
// Inside ctx.agent() implementation:
const budgetController = new AbortController();

onTokenUsage((usage) => {
  if (usage.totalTokens > options.tokenBudget) {
    budgetController.abort(new BudgetExceededError(usage));
  }
});

// Compose with workflow cancellation and timeout signals
const combined = AbortSignal.any([
  budgetController.signal,
  workflowCancellation.signal,
  AbortSignal.timeout(options.turnTimeout),
]);

const response = await fetch('https://api.anthropic.com/v1/messages', {
  signal: combined, // Web standard cancellation!
  // ...
});
```

---

#### 12.4 Human-in-the-Loop Interaction Protocol

The current plan models human review as `ctx.waitForSignal("human_review")`. That is the right _primitive_ but the wrong _abstraction level_. Real human-in-the-loop in agent workflows involves structured approval UIs, multi-turn conversation, escalation, and partial approval. `ctx.humanReview()` is a higher-level primitive built on signals and updates that provides all of this.

**Structured review requests:**

```typescript
const decision =
  yield *
  ctx.humanReview({
    // What the human is reviewing
    artifact: {
      type: 'report',
      content: agentOutput,
      sections: ['executive-summary', 'methodology', 'findings', 'recommendations'],
    },

    // Who reviews and how they're notified
    reviewers: ['legal-team'],
    notify: {
      webhook: 'https://slack.com/api/chat.postMessage',
      payload: { channel: '#reviews', text: `Review needed: ${topic}` },
    },

    // Escalation chain with timeouts
    escalation: [
      { after: '4 hours', to: 'manager-queue' },
      { after: '24 hours', action: 'auto-approve', auditReason: 'timeout' },
    ],

    // Allow partial approval (per section)
    allowPartial: true,
  });
```

The return type is richly structured:

```typescript
interface ReviewDecision {
  decision: 'approved' | 'rejected' | 'partial';
  reviewer: string;
  timestamp: Date;
  // Per-section decisions when allowPartial: true
  sections?: Record<
    string,
    {
      decision: 'approved' | 'rejected';
      feedback?: string;
    }
  >;
  // Overall feedback
  feedback?: string;
}
```

**Multi-turn conversation threading.** A reviewer might reject the agent's output with feedback, the agent revises, the reviewer reviews again. This is modeled as a series of updates within the review wait period:

```typescript
const decision =
  yield *
  ctx.humanReview({
    artifact: report,
    reviewers: ['editor'],
    conversation: true, // Enable multi-turn review

    // Called when the reviewer sends a message during review
    *onMessage(ctx, message) {
      // The agent can respond to reviewer questions
      const response = yield* ctx.agent({
        model: 'claude-sonnet-4-20250514',
        prompt: `The reviewer asks: "${message.text}"\n\nContext: ${report}`,
      });
      return { text: response }; // Sent back to the reviewer
    },
  });
```

**Review state is durable.** The review request is stored at `review:{workflowId}:{reviewId}` in storage. If the process crashes while waiting for human review, recovery loads the pending review and continues waiting. The reviewer's partial conversation history is preserved in the checkpoint.

**Dashboard integration.** Pending reviews are listed at `GET /v1/reviews?status=pending` and displayed in the built-in dashboard. Reviewers can approve, reject, comment, or provide section-level feedback directly from the UI. The `POST /v1/workflows/:id/review/:reviewId` endpoint accepts the review decision.

**Going further: review notifications.** The `notify` field supports webhooks (Slack, PagerDuty, any HTTP endpoint) and email. Notifications are fire-and-forget `fetch()` calls with configurable retry. The engine does not depend on notification delivery — the review is always accessible via the dashboard and API regardless of whether the notification was received.

---

#### 12.5 MCP-Native Tool Execution

The ecosystem has converged on **MCP (Model Context Protocol)** as the standard for tool integration. Tools should not be hardcoded function arrays — they should be discoverable from MCP server URLs.

**MCP server URLs as tool sources.** `ctx.agent()` accepts a mix of local functions and MCP server URLs:

```typescript
const analysis =
  yield *
  ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Analyze the codebase...',
    tools: [
      { mcp: 'http://localhost:3000/mcp' }, // Local MCP server: filesystem tools
      { mcp: 'https://api.example.com/mcp', auth: { type: 'bearer', token: apiKey } }, // Remote MCP server
      localSearchTool, // Local function — same as before
    ],
  });
```

**Dynamic tool discovery.** At agent start, the engine calls `tools/list` on each MCP server to discover available tools. The tool definitions (name, description, input schema) are fetched once and cached for the duration of the agent loop. New tools added to an MCP server are available on the next `ctx.agent()` call without code changes.

**Tool schema validation at the engine level.** MCP tool input schemas (JSON Schema) are validated before dispatching tool calls. If the LLM produces invalid tool arguments, the error is caught before the tool call executes:

```typescript
// The engine validates BEFORE sending to the MCP server:
ToolSchemaValidationError: Invalid arguments for tool "readFile"

  Schema expects: { path: string, encoding?: string }
  Received:       { filename: "/etc/hosts" }

  Missing required field: "path"
  Unknown field: "filename" (did you mean "path"?)
```

**Checkpoint at MCP call boundary.** Each MCP tool invocation is a `yield*` checkpoint boundary — identical durability to local tool calls. If the process crashes after the MCP server processes the tool call but before the agent sees the result, recovery loads the result from the checkpoint. MCP tool results are annotated with `source: "mcp"` in the conversation history and in `AgentToolCalledEvent`.

**Tool registry merges local and MCP sources.** The engine builds a unified tool list from all sources. Name collisions between local functions and MCP server tools produce a `ToolNameConflictError` at agent initialization — not at the first conflicting call.

**Going further: MCP server health checking.** Before starting the agent loop, the engine pings each MCP server. Unreachable servers produce `MCPServerUnavailableError` immediately rather than failing silently on the first tool call. Individual MCP tool calls respect a configurable timeout (default: 30 seconds) enforced via `AbortSignal.timeout()`.

**Going further: MCP transports.** The MCP client supports both transports defined by the protocol: stdio (for local process tools like language servers) and HTTP+SSE (for remote servers). The transport is inferred from the URL scheme or explicitly configured:

```typescript
tools: [
  { mcp: 'stdio:///usr/local/bin/mcp-filesystem' }, // Local process via stdio
  { mcp: 'https://tools.example.com/mcp' }, // Remote server via HTTP (default)
  { mcp: 'https://tools.example.com/mcp', transport: 'sse' }, // Remote server via HTTP+SSE
];
```

---

#### 12.6 Context Window Management

LLMs have finite context windows. A 10-turn agent loop with verbose tool results will exceed the context window. Today, developers handle this themselves — truncating old messages, summarizing history, using RAG. This is complex, error-prone, and repeated by every team. An agent-native engine handles it transparently.

**Automatic token tracking.** The engine counts tokens in the conversation history before each LLM call using the provider's tokenizer. The count is recorded in `AgentTurnStartedEvent` and used to determine whether the context strategy needs to trigger.

**Pluggable context strategies.** The `ContextStrategy` interface has a single method:

```typescript
interface ContextStrategy {
  compact(
    messages: Message[],
    options: {
      tokenBudget: number; // How many tokens the compacted result should fit within
      systemMessage: Message; // Always preserved (never compacted)
      model: string; // Current model (affects tokenizer)
    },
  ): AsyncGenerator<Message[]>; // Generator because strategies like "summarize" need yield*
}
```

Three built-in strategies:

```typescript
// Sliding window: drop oldest messages to fit within budget.
// System prompt and most recent N messages are always preserved.
const agent = weft.agent({
  contextStrategy: slidingWindow({
    preserveRecent: 10, // Always keep last 10 messages
    compactAt: 0.85, // Trigger when context reaches 85% of window
  }),
});

// Summarize: call a cheaper model to compress older messages.
// The summarization call is itself a checkpointed durable operation.
const agent = weft.agent({
  contextStrategy: summarize({
    summarizeModel: 'claude-haiku-4-5-20251001',
    preserveRecent: 5,
    compactAt: 0.8,
    summaryPrompt: 'Summarize this conversation, preserving key facts and decisions.',
  }),
});

// RAG: move older messages to a vector store, retrieve relevant ones per turn.
const agent = weft.agent({
  contextStrategy: rag({
    vectorStore: pineconeStore,
    retrievalCount: 10,
    preserveRecent: 3,
  }),
});
```

**Context state is part of the checkpoint.** The current conversation history — after strategy application — is stored in the checkpoint. On recovery, the compacted context is restored directly. The engine does not re-run the context strategy on recovery; the result is already persisted.

**`AgentContextCompactedEvent`** is dispatched when any strategy triggers, including the strategy name, tokens before and after, and messages dropped. This flows through the standard `EventTarget` system.

**Going further: composable strategies.** Strategies can be composed: `compose(slidingWindow({ preserveRecent: 20 }), summarize({ compactAt: 0.9 }))` applies the sliding window first, then summarizes if still over budget. Each strategy in the chain is a generator, so intermediate checkpoints are created between strategy applications.

---

#### 12.7 Multi-Agent Coordination

Real agent systems involve multiple agents collaborating, competing, or delegating. The existing `ctx.all()` handles parallel fan-out, but agent workloads require additional coordination primitives.

**`ctx.handoff()` — sequential delegation with context transfer.** One agent decides it needs another agent's expertise and transfers the task, including relevant context:

```typescript
async function* researchPipeline(ctx: Context, topic: string) {
  // Researcher gathers raw data
  const rawData = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Gather comprehensive data on: ${topic}`,
    tools: [webSearch, documentLookup, dataQuery],
  });

  // Hand off to analyst with selective context forwarding
  const analysis = yield* ctx.handoff({
    agent: 'analyst',
    input: { topic, data: rawData },
    forwardContext: 'summary', // Send a summary of the researcher's conversation, not the full history
  });

  // Hand off to writer for the final report
  const report = yield* ctx.handoff({
    agent: 'writer',
    input: { topic, analysis },
    forwardContext: 'none', // Writer only needs the structured analysis, not the full conversation
  });

  return report;
}
```

The delegating agent pauses at the `yield*` boundary. A child workflow runs the target agent. The result returns when the child completes. OpenTelemetry span links connect the parent and child traces.

**`ctx.debate()` — adversarial review.** Two agents argue opposing positions for N rounds, then a judge decides:

```typescript
const review =
  yield *
  ctx.debate({
    agents: [
      { name: 'advocate', system: 'Argue for the proposal...' },
      { name: 'critic', system: 'Find weaknesses in the proposal...' },
    ],
    judge: { name: 'editor', system: 'Evaluate both arguments and decide...' },
    rounds: 3,
    topic: proposedStrategy,
  });
// review.verdict: the judge's decision
// review.transcript: full debate history (all rounds)
```

Each round is a checkpoint boundary. If the process crashes mid-debate, recovery resumes from the last completed round.

**`ctx.supervise()` — supervisor pattern.** A supervisor agent manages a pool of worker agents, routing tasks based on capability:

```typescript
const results =
  yield *
  ctx.supervise({
    workers: [
      weft.agent({ name: 'legal-reviewer', tools: [legalDatabase] }),
      weft.agent({ name: 'technical-reviewer', tools: [codeAnalyzer] }),
      weft.agent({ name: 'financial-reviewer', tools: [financialModels] }),
    ],
    strategy: 'consensus', // All workers must agree. Alternatives: 'best-of-n', 'merge'
    input: documentToReview,
  });
```

**`SharedState` — concurrent mutable state.** When multiple agents run in parallel via `ctx.all()`, they may need shared, mutable state. `ctx.sharedState()` provides a CAS (compare-and-swap) primitive backed by storage:

```typescript
async function* collaborativeResearch(ctx: Context, topics: string[]) {
  // Shared state for concurrent agents
  const findings = yield* ctx.sharedState('research-findings', {
    initial: { articles: [], totalCost: 0 },
  });

  // Multiple agents run in parallel, writing to shared state
  yield* ctx.all(
    topics.map((topic) =>
      ctx.agent({
        model: 'claude-sonnet-4-20250514',
        prompt: `Research: ${topic}`,
        tools: [webSearch],
        hooks: {
          async *afterToolCall(ctx, tool, result) {
            if (tool.name === 'webSearch') {
              // CAS update: read-modify-write with automatic retry on conflict
              yield* findings.update((state) => ({
                ...state,
                articles: [...state.articles, ...result.articles],
              }));
            }
          },
        },
      }),
    ),
  );

  return yield* findings.get();
}
```

`SharedState` writes are serialized via optimistic concurrency control. On conflict (another agent wrote between read and write), the update function is retried with the latest state. Writes are committed atomically with the agent turn checkpoint via `batch()`.

**Agent-to-agent messaging.** Agents running in parallel can communicate through their workflow handles via `ctx.signal()`. A supervisor agent can signal a worker to change strategy mid-execution.

**Budget across parallel agents.** Multi-agent fan-out via `ctx.all()` respects the workflow-level budget. The total token cost across all parallel branches counts against the budget set by `ctx.setBudget()`. If any branch exhausts the shared budget, all branches receive the abort signal via `AbortSignal.any()`.

---

#### 12.8 Agent-Specific Observability

A traditional workflow dashboard shows: "step 1 completed, step 2 running, step 3 pending." An agent-native dashboard needs to show the agent's reasoning trace, token usage per turn as a cost waterfall, tool call results in context, the full conversation history, and real-time streaming output.

**Agent-specific event types.** All agent events extend the standard `Event` class and are registered in `WeftEventMap` for typed `addEventListener`:

```typescript
// Listen to individual agent turns
handle.addEventListener(AgentTurnCompletedEvent.type, (event) => {
  console.log(
    `Turn ${event.turnIndex}: ${event.inputTokens}in + ${event.outputTokens}out`,
    `= $${event.cost.toFixed(4)} (cumulative: $${event.cumulativeCost.toFixed(4)})`,
    `[${event.toolCallCount} tool calls, ${event.duration}ms]`,
  );
});

// Listen to tool calls
handle.addEventListener(AgentToolCalledEvent.type, (event) => {
  console.log(`Tool: ${event.toolName} (${event.source}) — op:${event.operationId}`);
});

// Listen to budget warnings
engine.addEventListener(AgentBudgetWarningEvent.type, (event) => {
  console.warn(`Budget ${event.budgetUsedPercent}% used for workflow ${event.workflowId}`);
});
```

The full event taxonomy:

| Event                           | Type String                   | When                                              |
| ------------------------------- | ----------------------------- | ------------------------------------------------- |
| `AgentTurnStartedEvent`         | `agent:turn:started`          | Before each LLM call                              |
| `AgentTurnCompletedEvent`       | `agent:turn:completed`        | After each LLM response + tool calls              |
| `AgentToolCalledEvent`          | `agent:tool:called`           | Before each tool invocation                       |
| `AgentToolReturnedEvent`        | `agent:tool:returned`         | After each tool returns                           |
| `AgentBudgetWarningEvent`       | `agent:budget:warning`        | At configurable threshold (default 80%)           |
| `AgentBudgetExceededEvent`      | `agent:budget:exceeded`       | When budget is exhausted                          |
| `AgentContextCompactedEvent`    | `agent:context:compacted`     | When context strategy triggers                    |
| `AgentModelFallbackEvent`       | `agent:model:fallback`        | When a model fails and the next in chain is tried |
| `AgentProviderCircuitOpenEvent` | `agent:provider:circuit-open` | When a provider is temporarily excluded           |
| `HumanReviewRequestedEvent`     | `human:review:requested`      | When `ctx.humanReview()` creates a review         |
| `HumanReviewCompletedEvent`     | `human:review:completed`      | When a reviewer submits a decision                |

**Reasoning trace.** When the model returns `thinking` blocks (extended thinking), they are stored in the checkpoint alongside the conversation history and included in `AgentTurnCompletedEvent` as `reasoningTrace`. The dashboard renders reasoning traces in an expandable accordion per turn.

**Queryable data.** Agent-specific state is queryable via workflow handles:

```typescript
// Cost waterfall: per-turn cost breakdown
const costWaterfall = await handle.query('agentCostWaterfall');
// [{ turn: 0, inputTokens: 1200, outputTokens: 450, cost: 0.0103, model: "claude-sonnet-4-20250514", tools: ["webSearch"] }, ...]

// Full conversation history
const conversation = await handle.query('agentConversation');
// [{ role: "system", content: "..." }, { role: "user", content: "..." }, { role: "assistant", content: "...", toolCalls: [...] }, ...]

// Cost projection
const projection = await handle.query('agentCostProjection');
// { estimatedTurnsRemaining: 8, estimatedTotalCost: 4.20, confidence: 0.7 }
```

**OTel span hierarchy.** The observability interceptor creates spans for agent execution:

```
workflow:research (root span)
├── agent (agent span)
│   ├── agent:turn:0 (turn span)
│   │   ├── agent:tool:webSearch (tool span)
│   │   └── agent:tool:readDocument (tool span)
│   ├── agent:turn:1 (turn span)
│   │   └── agent:tool:analyzeData (tool span)
│   └── agent:turn:2 (turn span)
└── sleep:1h (sleep span)
```

Each span includes attributes: `weft.agent.model`, `weft.agent.turn_index`, `weft.agent.input_tokens`, `weft.agent.output_tokens`, `weft.agent.cost`, `weft.agent.tool_count`.

**Dashboard agent view.** The built-in dashboard at `/ui` includes an agent-specific panel showing: conversation timeline with tool calls highlighted inline, token usage per turn as a bar chart, cumulative cost curve, budget remaining gauge, reasoning trace accordion, and real-time streaming output.

---

#### 12.9 Model Routing and Fallback

In production agent workflows, you do not always want the same model for every turn. You want: the best model for complex reasoning, a cheaper model for summarization, automatic fallback when a provider is down, and A/B testing for quality comparison.

**`ModelRouter` interface.** A pluggable component that selects the model for each turn:

```typescript
interface ModelRouter {
  select(context: RoutingContext): ModelSelection;
}

interface RoutingContext {
  turnIndex: number;
  conversationLength: number;
  toolCallsThisTurn: number;
  budgetRemaining: { tokens: number; cost: number };
  previousTurns: TurnSummary[];
  metadata: Record<string, unknown>;
}

interface ModelSelection {
  model: string;
  fallback?: string[]; // Ordered fallback chain
  reason?: string; // For observability
}
```

**Static fallback chain.** The simplest configuration — try the primary model, fall back on failure:

```typescript
const agent = weft.agent({
  model: 'claude-sonnet-4-20250514',
  fallback: ['gpt-4o', 'claude-haiku-4-5-20251001'],
  // If Claude Sonnet fails (rate limit, timeout, outage), try GPT-4o.
  // If GPT-4o also fails, try Haiku.
  // Each fallback attempt is a separate checkpoint boundary.
});
```

**Dynamic model routing based on turn characteristics:**

```typescript
const smartRouter: ModelRouter = {
  select(context) {
    // Complex reasoning turns → best model
    if (context.toolCallsThisTurn > 3 || context.conversationLength > 50) {
      return { model: 'claude-sonnet-4-20250514', reason: 'complex-reasoning' };
    }
    // Low budget remaining → cheapest model
    if (context.budgetRemaining.cost < 1.0) {
      return { model: 'claude-haiku-4-5-20251001', reason: 'budget-conservation' };
    }
    // Default with fallback
    return {
      model: 'claude-sonnet-4-20250514',
      fallback: ['gpt-4o'],
      reason: 'default',
    };
  },
};

const agent = weft.agent({
  modelRouter: smartRouter,
});
```

**Cost-tier routing.** Declare cost tiers and the engine selects the cheapest adequate model:

```typescript
const agent = weft.agent({
  modelRouter: costTierRouter({
    tiers: {
      premium: 'claude-sonnet-4-20250514',
      standard: 'gpt-4o-mini',
      economy: 'claude-haiku-4-5-20251001',
    },
    // Start with premium, switch to economy when 70% of budget is consumed
    budgetThresholds: { standard: 0.5, economy: 0.7 },
  }),
});
```

**A/B testing.** Route a percentage of agent invocations to different models for quality comparison:

```typescript
const agent = weft.agent({
  modelRouter: abTestRouter({
    control: { model: 'claude-sonnet-4-20250514', weight: 0.8 },
    variant: { model: 'gpt-4o', weight: 0.2 },
    // Selection is deterministic per workflow ID (seeded hash) for reproducibility
    // Results tagged with model attribution in AgentTurnCompletedEvent.selectedModel
  }),
});
```

**Provider health tracking.** The engine tracks error rates per provider over a sliding window. Providers exceeding a configurable error threshold are temporarily excluded (circuit breaker):

```typescript
engine.configure({
  providerHealth: {
    windowDuration: 60_000, // 60-second sliding window
    errorThreshold: 0.5, // 50% error rate triggers circuit open
    cooldownDuration: 300_000, // 5-minute cooldown before retrying
  },
});
```

When a circuit opens, `AgentProviderCircuitOpenEvent` is dispatched. When it closes (after cooldown), agents resume routing to that provider.

**Model selection is checkpointed.** The model chosen for each turn is recorded in the checkpoint. On recovery, the same model is used for the retried turn — no re-routing. This ensures deterministic retry behavior even when the model router would now select a different model due to changed conditions.

---

#### 12.10 Agent-First Workflow Declaration

This is the most fundamental shift. In the current architecture, `ctx.agent()` is something a workflow _calls_ — it is a step in a workflow. But for many workloads, the agent loop IS the entire workflow. There is no "step 1: agent, step 2: something else." The whole thing is an agent.

`weft.agent()` is a top-level declaration that says: this workflow is an agent.

```typescript
const researchAgent = weft.agent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  system:
    'You are a research analyst. Gather comprehensive data, verify facts, and produce actionable insights.',
  tools: [
    { mcp: 'http://localhost:3000/mcp' }, // MCP server: filesystem tools
    webSearch,
    factCheck,
    dataQuery,
  ],
  maxTurns: 50,

  // Context window management
  contextStrategy: summarize({
    summarizeModel: 'claude-haiku-4-5-20251001',
    preserveRecent: 10,
    compactAt: 0.85,
  }),

  // Model routing
  modelRouter: costTierRouter({
    tiers: { premium: 'claude-sonnet-4-20250514', economy: 'claude-haiku-4-5-20251001' },
    budgetThresholds: { economy: 0.8 },
  }),

  // Cost constraints
  budget: {
    maxCost: 10.0,
    warningThreshold: 0.8,
  },

  // Durable lifecycle hooks — these run at checkpoint boundaries
  hooks: {
    *beforeTurn(ctx, turn) {
      // Inject real-time context before each LLM call
      ctx.setAttribute('agent:turn', turn.index);
      if (turn.index > 10) {
        yield* ctx.waitForSignal('continue_approval', { timeout: '1 hour' });
      }
    },

    *afterToolCall(ctx, toolCall) {
      // Audit dangerous tool calls
      if (toolCall.name === 'executeCode') {
        yield* ctx.humanReview({
          artifact: { tool: toolCall.name, input: toolCall.input, result: toolCall.result },
          reviewers: ['security-team'],
          escalation: [{ after: '30 minutes', action: 'auto-reject' }],
        });
      }
    },

    onBudgetWarning(ctx, remaining) {
      // Switch to cheaper model when budget is running low
      ctx.setModelRouter(
        costTierRouter({
          tiers: { economy: 'claude-haiku-4-5-20251001' },
          budgetThresholds: {},
        }),
      );
    },
  },
});
```

**Registering and starting an agent workflow:**

```typescript
engine.register(researchAgent);

// Start it like any workflow
const handle = await engine.start('research', {
  prompt: 'Analyze the competitive landscape for durable execution engines in 2026.',
});

// Observe it like any workflow
for await (const event of handle) {
  if (event instanceof AgentTurnCompletedEvent) {
    console.log(`Turn ${event.turnIndex}: $${event.cost.toFixed(4)}`);
  }
}

const result = await handle.result();
```

**Relationship to `ctx.agent()`.** `weft.agent()` is the standalone form — the agent IS the workflow. `ctx.agent()` is the embedded form — the agent is a step inside a larger workflow. They share the same underlying implementation. A `weft.agent()` definition can be used as either:

```typescript
// As a standalone workflow
engine.register(researchAgent);
await engine.start('research', { prompt: '...' });

// As a step in a larger workflow
async function* pipeline(ctx: Context, input: Input) {
  const research = yield* ctx.agent(researchAgent, { prompt: input.topic });
  const report = yield* ctx.agent(writerAgent, { data: research });
  return report;
}
```

**Type-safe agent registry.** Agent definitions carry their input and output types:

```typescript
const researcher = weft.agent<{ prompt: string }, ResearchResult>({
  name: 'research',
  // ...
});

// Compile-time type checking on start
const handle = await engine.start('research', { prompt: 'topic' }); // OK
const handle = await engine.start('research', { wrong: 'field' }); // Type error

// Compile-time type checking on result
const result: ResearchResult = await handle.result();
```

**Engine optimization.** When the engine detects an agent-typed workflow (registered via `weft.agent()`), it applies optimizations specific to conversation-shaped data: pre-warming LLM provider connections, larger checkpoint buffers for conversation history, and priority queuing for tool call execution. These optimizations are transparent — they do not change behavior, only performance.

---

#### 12.11 Storage Key Patterns for Agent-Native Features

The following storage key patterns support the agent-native engine. All follow the existing `prefix:{id}:suffix` convention:

```
review:{workflowId}:{reviewId}           → Pending human review request (JSON: artifact, reviewers, escalation)
review-resp:{reviewId}                    → Human review response (JSON: decision, reviewer, feedback)
budget:{namespace}:daily:{YYYY-MM-DD}    → Organization daily budget counter (number: cumulative cost)
budget:{namespace}:monthly:{YYYY-MM}     → Organization monthly budget counter (number: cumulative cost)
shared:{workflowId}:{stateKey}           → SharedState data (JSON: current state)
shared:{workflowId}:{stateKey}:version   → SharedState version counter (number: CAS version for optimistic concurrency)
mcp-tools:{serverUrl}:{cacheKey}         → Cached MCP tool definitions (JSON: tool schemas, TTL)
provider-health:{provider}:{window}      → Provider error rate tracking (JSON: error count, request count, window start)
```

Review requests and shared state entries are cleaned up when the parent workflow reaches a terminal state. Organization budget counters are retained for billing and audit. MCP tool caches expire based on their configured TTL.

### 13. Additional Platform Patterns

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
// 4. Token budget exhaustion

async function executeActivity(
  fn: Function,
  input: unknown,
  signals: {
    workflow: AbortSignal;
    timeout: AbortSignal;
    shutdown: AbortSignal;
    budget?: AbortSignal;
  },
): Promise<unknown> {
  // AbortSignal.any() fires when ANY of the signals abort
  const combined = AbortSignal.any([
    signals.workflow,
    signals.timeout,
    signals.shutdown,
    ...(signals.budget ? [signals.budget] : []),
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

### 14. Workflow Versioning

When you deploy new workflow code while workflows are in-flight, you need to answer: which version of the code runs when a checkpointed workflow resumes?

Weft's checkpoint model makes this fundamentally simpler than Temporal. Since we resume from a checkpoint (not replay from the beginning), the only compatibility requirement is that the new code can handle the checkpoint's shape at the specific step where execution paused. No patching API. No version gates in workflow code. Migration is a pure data transformation.

#### Registration API

```typescript
interface WorkflowRegistration {
  name: string;
  version: string; // Semver string, e.g., "2.0.0"
  handler: WorkflowFunction;
  /** Optional: migrate a checkpoint from a previous version. */
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
}

// Full registration with version and migration
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
  migrate(checkpoint, fromVersion) {
    if (fromVersion.startsWith('1.')) {
      // V1 stored `address` as a string; V2 uses an Address object
      return { ...checkpoint, address: parseAddress(checkpoint.address) };
    }
    return checkpoint;
  },
});

// Shorthand still works — defaults to version "0.0.0", no migration
engine.register('order', orderWorkflow);
```

#### Resume Logic

1. **Version pinned at start.** When `engine.start()` is called, the workflow state blob records the version of the currently registered handler.
2. **On resume, versions are compared.** If they match: resume normally. If they differ: call `migrate()` if provided.
3. **No migration function = resume as-is.** This works when the new code is backward-compatible with the checkpoint shape (common, since checkpoint data is just local variables that pass `structuredClone`).
4. **Incompatible checkpoint = clear error.** If the new code fails because the checkpoint shape is wrong and no migration was provided, the workflow fails with a `VersionMismatchError` that includes both versions and the workflow ID.
5. **Migrated checkpoint persisted atomically.** After successful migration, the updated checkpoint and version are written to storage in one `batch()` call.

#### Why Simpler Than Temporal

In Temporal, version changes require `workflow.getVersion()` / `patched()` because replay must follow the exact same code path as the original execution. Every branching point needs a version gate. In Weft:

- No replay means no code-path determinism requirement.
- The checkpoint captures the complete state at the pause point.
- Migration is a pure data transformation on the checkpoint, not code-path branching.
- Developers think about "can my new code handle this checkpoint shape?" rather than "is my new code deterministically compatible with the old event history?"

#### Usage Examples

```typescript
// Simple case: checkpoint shape didn't change, just the logic after the current step
engine.register('order', {
  version: '1.1.0',
  handler: orderWorkflowV2,
  // No migrate needed — checkpoint shape is compatible
});

// Migration case: V2 added a `region` field
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
  migrate(checkpoint, fromVersion) {
    if (fromVersion.startsWith('1.')) {
      return { ...checkpoint, region: 'us-east-1' };
    }
    return checkpoint;
  },
});
```

### 15. Workflow-Level Timeouts

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

The `ctx.signal` property exposes the combined timeout + cancellation signal. Activities and agent calls that already accept `{ signal }` automatically respect workflow timeouts with no code changes.

### 16. Search Attributes (Advanced Visibility)

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

interface SearchAttributeDefinition {
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list';
}
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
    tags: { type: 'keyword_list' },
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
GET /v1/workflows?attr.customerId=cust-123
GET /v1/workflows?attr.region=us-east&attr.priority.gte=8
GET /v1/workflows?attr.orderTotal.gte=100&attr.orderTotal.lte=500
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

**Multi-value attributes (keyword_list):** Each element gets its own index entry. Setting `tags: ["charged", "processing"]` creates `idx:tags:s:charged:{id}` and `idx:tags:s:processing:{id}`.

**Atomic updates at checkpoint boundary:** The engine diffs previous vs current attributes, computing add/delete index operations, and writes everything in the same `batch()` call as the checkpoint. No partial index states.

**External mutation:** `handle.setAttributes()` and `PATCH /v1/workflows/:id/attributes` allow setting attributes from outside the workflow. Index updates happen atomically.

### 17. Synchronous Updates

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

// Blocks until the workflow processes the update and responds
const result = await handle.update(
  'validate_coupon',
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
5. **Timeout handling.** The caller races against `AbortSignal.timeout()`. On timeout: `UpdateTimeoutError` with the `updateId`. The update is still pending — the caller can poll `GET /v1/updates/:updateId` later to retrieve the eventual response.
6. **Durability.** If the server crashes between receiving the request and delivering the response, the update request is already in storage. After recovery, the workflow processes it and writes the response. The caller retrieves via the poll endpoint.

**Idempotency:** An optional `idempotencyKey` maps to the `updateId` via `upk:{workflowId}:{key}`. Duplicate requests return the existing response.

**Response cleanup:** `upr:*` entries are deleted after a configurable TTL (default 5 minutes) to prevent unbounded storage growth.

### 18. Interceptors / Middleware

Interceptors are composable hooks that wrap workflow context operations for cross-cutting concerns. They are the foundation for observability (section 20), and can be used independently for validation, encryption, auth propagation, and more.

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

  agent?(
    input: AgentInterception,
    next: (input: AgentInterception) => Generator<unknown, unknown>,
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
  headers: Map<string, string>; // propagated metadata (trace context, auth tokens, etc.)
}

interface SleepInterception {
  readonly workflowId: string;
  readonly workflowType: string;
  duration: string | number; // mutable
}

interface AgentInterception {
  readonly workflowId: string;
  readonly workflowType: string;
  options: AgentOptions; // mutable
  headers: Map<string, string>;
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

This is how trace context (W3C `traceparent`/`tracestate`), auth tokens, tenant IDs, and encryption keys propagate — without special-casing any of them.

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

### 19. Observability (OpenTelemetry Integration)

Observability is implemented as a pre-built interceptor pair. It uses standard OpenTelemetry APIs (`@opentelemetry/api`) and propagates context through the interceptor `headers` mechanism.

#### Design Principles

1. **Uses `@opentelemetry/api` directly.** No custom tracing layer. The API package is a lightweight no-op unless an SDK is configured — zero overhead if you don't enable tracing.
2. **Opt-in, not built-in.** Import from `weft/observability`. If you don't import it, no OpenTelemetry code is loaded.
3. **Auto-created spans** for all context operations.
4. **W3C Trace Context propagation** via the interceptor `headers` Map.

#### API

```typescript
import { createObservabilityInterceptors } from 'weft/observability';

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
  serverUrl: 'ws://weft-server:7233/v1/tasks/default/stream',
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
├── activity:ship (child span)
│   └── activity:execute:ship (child span, on the worker side)
└── agent (child span)
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

| Dimension                | Temporal                           | Weft (SQLite)             | Weft (LMDB)               |
| ------------------------ | ---------------------------------- | ------------------------- | ------------------------- |
| **Recovery**             | O(n) replay                        | O(1) checkpoint           | O(1) checkpoint           |
| **Storage read**         | ~1ms (network)                     | ~10μs (in-process)        | ~1μs (memory-mapped)      |
| **Storage write**        | ~2ms (network)                     | ~20μs (WAL)               | ~10μs (batched)           |
| **Task claim**           | gRPC round-trip                    | 1 SQL statement           | 1 range read + put        |
| **Cold start**           | seconds (Go + DB pool)             | <50ms (Bun + SQLite)      | <50ms (Bun + mmap)        |
| **Memory / workflow**    | ~50KB (history cache)              | ~2KB (checkpoint)         | ~2KB (checkpoint)         |
| **Single binary?**       | No                                 | Yes                       | No (native addon)         |
| **Browser?**             | No                                 | No                        | No                        |
| **Browser (IndexedDB)?** | —                                  | Yes (same engine)         | —                         |
| **History growth**       | O(n) with activity count           | O(1) fixed-size           | O(1) fixed-size           |
| **Dev environment**      | Docker Compose (~minutes)          | `bun add weft` (~seconds) | `bun add weft` (~seconds) |
| **Bundle step**          | Webpack per workflow change        | None                      | None                      |
| **Max workflow length**  | ~50K events (then `continueAsNew`) | Unlimited                 | Unlimited                 |

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
│   ├── context.ts         # ctx.run, ctx.sleep, ctx.signal, ctx.agent, ctx.all,
│   │                      # ctx.setAttribute, ctx.onUpdate, ctx.waitForUpdate,
│   │                      # ctx.humanReview, ctx.handoff, ctx.debate, ctx.supervise,
│   │                      # ctx.sharedState, ctx.setBudget, ctx.budgetRemaining
│   ├── checkpoint.ts      # Generator serialization via structuredClone
│   ├── scheduler.ts       # Timer/retry scheduling logic (no I/O)
│   ├── interceptor.ts     # WorkflowInterceptor, ActivityInterceptor interfaces + chain composition
│   ├── search-attributes.ts # Attribute index encoding, diff logic, sortable key encoding
│   ├── updates.ts         # Synchronous update request/response coordination
│   ├── codec.ts           # MessagePack encode/decode (pure JS)
│   ├── shared-state.ts    # SharedState primitive: durable concurrent KV with optimistic concurrency
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
├── ai/                        # Agent-native engine primitives
│   ├── agent.ts               # Durable ReAct loop, ctx.agent() implementation
│   ├── declaration.ts         # weft.agent() top-level declaration, lifecycle hooks
│   ├── streaming.ts           # ReadableStream token bridge, stream multiplexer, reconnection buffer
│   ├── budget.ts              # Token/cost tracking, AbortController enforcement, org-level budgets
│   ├── context-window.ts      # Token counting, ContextStrategy interface, compaction lifecycle
│   ├── context-strategies/    # Pluggable context window strategies
│   │   ├── sliding-window.ts  # Drop oldest messages within token budget
│   │   ├── summarize.ts       # Compress old messages via secondary LLM call
│   │   └── rag.ts             # Replace history with vector-retrieved context
│   ├── human-review.ts        # ctx.humanReview() protocol, review storage, escalation chains
│   ├── model-router.ts        # Per-turn model selection, fallback chains, A/B weighted routing
│   ├── provider-health.ts     # Provider error rate tracking, circuit breaker logic
│   ├── coordination.ts        # ctx.handoff(), ctx.debate(), ctx.supervise() multi-agent primitives
│   ├── hooks.ts               # Durable hook interfaces: beforeTurn, afterToolCall, onBudgetWarning
│   ├── mcp/                   # Model Context Protocol integration
│   │   ├── client.ts          # MCP client: server connection, tools/list discovery, tool invocation
│   │   ├── registry.ts        # Unified tool registry merging local functions + MCP server tools
│   │   ├── schema-validator.ts# JSON Schema validation for MCP tool inputs
│   │   └── authentication.ts  # Bearer token, API key, OAuth2 for MCP servers
│   ├── events.ts              # All agent-specific Event subclasses and WeftAgentEventMap
│   └── providers/             # LLM adapters (Anthropic, OpenAI, etc.)
│       ├── interface.ts       # LLMProvider interface: chat, stream, countTokens
│       ├── anthropic.ts       # Anthropic Messages API adapter
│       ├── openai.ts          # OpenAI Chat Completions API adapter
│       └── types.ts           # Shared provider types: Message, ToolDefinition, TokenUsage
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
import { Engine, BunSQLiteStorage } from 'weft';

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

# That's it. SQLite database created automatically. Dashboard at localhost:7233/ui
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

10. **Workflow versioning:** Version pinned at start, stored in workflow state, optional migration function on resume. No patching API needed — checkpoint model avoids replay compatibility concerns.

11. **Workflow timeouts:** Execution timeout (maximum wall-clock time for a workflow), stored as absolute deadline in storage, enforced by the scheduler via AbortController.

12. **Search attributes:** KV-based secondary indexes (`idx:{attr}:{value}:{wfId}`), works identically on all storage backends, updated atomically with checkpoint writes.

---

## Acceptance Criteria Checklist

### Core Engine

- [x] **Workflows are AsyncGenerator functions.** `async function*` is the only way to define a workflow. No decorator magic, no class-based API, no code transformation.
- [x] **Each `yield*` creates a checkpoint.** Checkpoint contains: step index, local variable snapshot (via `structuredClone` semantics), accumulated results.
- [x] **Recovery is O(1).** Loading a checkpoint from storage and resuming the generator does not replay previous steps. Verified by benchmark: recovery time is constant regardless of workflow history length.
- [x] **No determinism requirement.** `Date.now()`, `Math.random()`, `crypto.randomUUID()`, and network calls are permitted inside workflows between checkpoint boundaries.
- [x] **`ctx.run(fn, ...args)` dispatches a durable activity.** Activity results survive process crashes. Idempotency keys prevent double-execution.
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
- [x] **Event types defined:** `workflow:started`, `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`, `activity:started`, `activity:completed`, `activity:failed`, `agent:token`, `signal:received`, `signal:delivered`, `attributes:changed`, `update:received`, `update:completed`.

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
- [x] **Activity registry uses `Map<string, Function>`.** Activities are keyed by name; registered via `engine.registerActivity(name, fn)`.
- [x] **Handle registry uses `WeakRef`.** Engine doesn't prevent GC of dropped handles.
- [x] **`Transferable` used for Worker communication.** Checkpoint `ArrayBuffer` is transferred, not copied, to/from Workers.
- [ ] **Memory per idle workflow ≤ 2KB.** Verified by benchmark with 100K concurrent workflows.
- [ ] **No unbounded growth under load.** Memory profiling over 1 hour of sustained 10K workflows/sec shows stable RSS.

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
- [x] **WebSocket upgrade for workflow observation.** `WS /v1/workflows/:id/watch`.
- [x] **WebSocket upgrade for token streaming.** `WS /v1/workflows/:id/stream`.
- [x] **Bun's built-in pub/sub (`ws.subscribe` / `server.publish`).** No external message broker.
- [x] **Long-poll fallback for non-WebSocket environments.** `GET /v1/tasks/:queue` with timeout.
- [x] **Prometheus metrics at `/v1/metrics`.** All counters, gauges, histograms defined.
- [x] **Built-in web dashboard at `/ui`.** Pre-built SPA embedded in binary.
- [x] **Auth: API keys, JWT, optional mTLS.** Configurable in `serve()` options.

### Library/Server Parity

- [x] **Every HTTP endpoint has a corresponding `Engine` method.** `POST /v1/workflows` → `engine.start()`, `GET /v1/workflows/:id` → `engine.get()`, etc. No server-only features.
- [x] **Every `Engine` method is exposed via HTTP.** No library-only features that server-mode users cannot access.
- [x] **`client/local.ts` and `client/index.ts` export the same interface.** Switching from library to server mode is a constructor change, not an API change.
- [x] **Workflow code is identical across modes.** The same `async function*` runs in library mode, server mode, and browser/Service Worker mode without modification.
- [x] **Event observation works in both modes.** Library mode uses `EventTarget` directly; server mode bridges events over WebSocket. Same event types, same semantics.
- [x] **Agent features (streaming, budget, human review) work in both modes.** No agent capability is server-only or library-only.

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
- [x] **Heartbeat details are queryable.** Progress info from heartbeats available via `handle.query("activityProgress")`.
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
- [x] **Service Worker intercepts `/weft/` fetch events.** Same `handleHTTP()` function as server.
- [x] **IndexedDB storage passes all storage interface tests.** Same test suite as SQLite.
- [x] **Client library works with both remote server and local Service Worker.** Same `fetch()` calls, different routing.
- [x] **Service Worker handles Periodic Background Sync for timers.** (Where browser supports it.)

### Agent-Native Engine: Dynamic Execution Shape

- [x] **Agent loops support dynamic step counts.** A `while` loop with `yield*` creates checkpoints at each tool call without declaring the graph shape upfront.
- [x] **Checkpoint size is constant regardless of turn count.** Only the current conversation state and local variables are in the checkpoint, not the full execution history.
- [x] **Step index is a monotonic counter, not a fixed schema position.** Increments with each `yield*` regardless of origin. No step-count pre-declaration required.
- [x] **Agent conversation history accumulates in checkpoint locals.** The message array grows across turns and is captured by `structuredClone` at each boundary. Verified: restoring a checkpoint after 15 turns produces the same conversation array as live execution.
- [x] **Storage scan performance is independent of per-workflow step count.** `scan("wf:{id}")` returns a constant number of keys regardless of how many tool calls the agent executed.
- [x] **Agent loop termination handles all four exit paths.** Final answer (no tool calls), `maxTurns` reached, `tokenBudget` exhausted via `AbortController`, and workflow cancellation all produce a clean checkpoint at the exit boundary.
- [x] **Checkpoint size warning fires for large conversation histories.** `AgentCheckpointSizeWarningEvent` dispatched when an agent's accumulated conversation state exceeds the configurable threshold (default: 64KB).

### Agent-Native Engine: First-Class Streaming

- [x] **`ctx.agent()` returns a `ReadableStream<string>` when `streamTo: "output"` is set.** Standard `ReadableStream` usable with `for await...of`, `.pipeTo()`, and `.pipeThrough()`.
- [x] **Token stream bridges to workflow `EventTarget`.** `TokenEvent` dispatched for each token on both `WorkflowHandle` and `Engine`.
- [x] **Token stream bridges to WebSocket observers.** Connected clients on `WS /v1/workflows/:id/stream` receive tokens in real time via Bun's `server.publish()`.
- [x] **Stream multiplexer fans out single LLM call to multiple consumers.** No duplicate LLM requests. Implemented via custom `StreamMultiplexer` fan-out.
- [x] **Crash recovery mid-stream replays from last completed turn.** Partial token output from interrupted turn is discarded. LLM call re-issued for that turn only.
- [x] **Backpressure propagates from slow consumers via `ReadableStream`.** Configurable buffer limit (default: 64KB). Slow clients disconnected with warning rather than unbounded memory growth. (Note: backpressure tracking is enqueue-only — see IMPORTANT.md.)
- [x] **Client reconnection resumes with partial output.** Server sends accumulated output from completed turns via `ReconnectionBuffer` before streaming new tokens.
- [x] **SSE fallback for non-WebSocket environments.** `GET /v1/workflows/:id/sse` returns Server-Sent Events via `createSSEStream()`.
- [x] **Stream cancellation via `AbortController`.** Aborting the workflow or exceeding budget closes the stream, terminates WebSocket with close frame, and ends SSE connection cleanly.

### Agent-Native Engine: Cost Enforcement

- [x] **`ctx.setBudget()` configures workflow-level cost constraints.** Accepts `maxTokens`, `maxCost` (USD), `warningThreshold`, and per-model pricing. Budget state persists in checkpoint and survives restarts.
- [x] **`ctx.budgetRemaining()` returns current budget state.** Returns `tokensRemaining`, `costRemaining`, `tokensUsed`, `costUsed`, and per-model `breakdown`.
- [x] **`tokenBudget` on `ctx.agent()` enforced via `AbortController`.** `budgetController.abort(new BudgetExceededError(usage))` fires when cumulative usage exceeds budget. Signal propagates to in-flight `fetch()`.
- [x] **`engine.setBudgetPolicy()` sets organization-level budgets.** Daily and monthly limits per namespace. Stored at `budget:{namespace}:daily:{date}` and `budget:{namespace}:monthly:{month}`.
- [x] **Organization budget enforcement is real-time.** Token usage written to budget counter atomically with agent turn checkpoint via `batch()`. Exceeding rejects new `ctx.agent()` calls with `OrganizationBudgetExceededError`.
- [x] **Cost-aware retry skips retries when budget insufficient.** Before retrying, engine checks `ctx.budgetRemaining()`. If estimated retry cost exceeds remaining budget, `BudgetExceededError` thrown instead.
- [x] **Cost queryable via `handle.query("tokenUsage")`.** Returns cumulative token usage breakdown per agent call and per model.
- [x] **`AgentBudgetWarningEvent` dispatched at configurable threshold.** Default: 80% of budget consumed. Dispatched on both `WorkflowHandle` and `Engine`.
- [x] **`AgentBudgetExceededEvent` dispatched when budget exhausted.** Includes breakdown by model and turn.
- [x] **Cost observable as search attribute.** `ctx.agent()` automatically updates `weft:tokenCost` search attribute with cumulative USD cost.
- [x] **Per-turn cost recorded in `AgentTurnCompletedEvent`.** Includes `inputTokens`, `outputTokens`, `cost`, and `cumulativeCost`.
- [x] **`ctx.budgetProjection()` estimates remaining capacity.** Based on average per-turn cost and burn rate.

### Agent-Native Engine: Human-in-the-Loop Protocol

- [x] **`ctx.humanReview()` pauses workflow with structured review request.** Accepts artifact, reviewers, notification config, escalation chain, and `allowPartial` flag. Returns `ReviewDecision` with decision, reviewer, feedback, and per-section decisions.
- [x] **Review request stored durably.** Written to `review:{workflowId}:{reviewId}` in storage. Survives process restarts. Queryable via `GET /v1/workflows/:id/review/:reviewId`.
- [x] **Multi-turn conversation within a review.** `conversation: true` option enables reviewer to ask questions. Each exchange is a signal round-trip via `onMessage` handler. Conversation history persists in checkpoint.
- [x] **Escalation with configurable timeout chains.** `escalation: [{ after: "4 hours", to: "manager-queue" }, { after: "24 hours", action: "auto-approve", auditReason: "timeout" }]`.
- [x] **Partial approval for multi-section output.** `allowPartial: true` enables per-section approve/reject decisions. Workflow receives structured per-section feedback.
- [x] **Webhook notification on review wait.** `notify: { webhook: "..." }` dispatches `fetch()` POST. Fire-and-forget with `.catch()` logging.
- [x] **Review dashboard integration.** Pending reviews listed at `GET /v1/reviews?status=pending`. Reviewers can approve, reject, or comment from the built-in dashboard.
- [x] **Review timeout produces `ReviewTimeoutError`.** If no reviewer responds within timeout and no escalation configured, workflow receives error with review ID and elapsed duration.
- [x] **`HumanReviewRequestedEvent` dispatched when review wait begins.** Includes `workflowId`, `reviewId`, `reviewType`, `reviewers`. Dispatched on both `WorkflowHandle` and `Engine`.
- [x] **`HumanReviewCompletedEvent` dispatched when review submitted.** Includes `workflowId`, `reviewId`, `decision`, `reviewer`, `duration`.
- [x] **Review state cleanup on workflow completion.** `review:*` entries deleted when parent workflow reaches terminal state via `cleanupOperations()`.

### Agent-Native Engine: MCP-Native Tools

- [x] **MCP server URLs accepted as tool sources in `ctx.agent()`.** `tools: [{ mcp: "https://..." }, localFunction]` connects to MCP server and discovers available tools.
- [x] **Dynamic tool discovery via MCP `tools/list`.** Tool definitions fetched at agent start and cached for the duration of the agent loop. New server-side tools available on next `ctx.agent()` call without code changes.
- [x] **Tool schema validation at engine level.** MCP tool input schemas (JSON Schema) validated before dispatching. `ToolSchemaValidationError` includes tool name, expected schema, and actual input.
- [x] **Checkpoint at MCP tool call boundary.** Each MCP invocation preceded by `yield*` checkpoint. Identical durability to local tool calls.
- [x] **MCP tool results flow through same durable pipeline as local tools.** Results annotated with `source: "mcp"` in conversation history and events.
- [x] **Tool registry merges local functions and MCP server tools.** Name collisions produce `ToolNameConflictError` at agent initialization, not at first conflicting call.
- [x] **MCP server authentication.** Supports bearer token, API key, and OAuth2 client credentials via `createOAuth2TokenManager()` with thread-safe token caching and refresh.
- [x] **MCP server health checking at agent start.** Unreachable servers produce `MCPServerUnavailableError` immediately.
- [x] **MCP tool call timeout.** Each invocation respects configurable timeout (default: 30s) via `AbortController` + `setTimeout`. Timeout fires `MCPToolTimeoutError`.
- [x] **`AgentToolCalledEvent` includes `source` field.** Distinguishes `"local"` from `"mcp"` in observability events.
- [x] **MCP stdio and HTTP+SSE transports supported.** Transport inferred from URL scheme (`stdio://` → `StdioTransport`, `http(s)://` → `HttpTransport` or `HttpSseTransport`). Explicit override via `transport: 'sse'` on `MCPToolSource`.

### Agent-Native Engine: Context Window Management

- [x] **Automatic token counting before each LLM call.** Engine counts tokens using provider's tokenizer (heuristic: ~4 chars/token). Count recorded in `AgentTurnStartedEvent`.
- [x] **Configurable context window budget.** `contextWindow: { maxTokens, reservedForOutput }` sets maximum input token count and reserves space for response.
- [x] **Pluggable `ContextStrategy` interface.** Single method: `compact(messages, options): AsyncGenerator<Message[]>`. Generator because strategies like "summarize" need `yield*` for durable operations.
- [x] **Sliding-window strategy drops oldest messages.** Preserves system prompt and most recent N messages.
- [x] **Summarize strategy compresses old messages via secondary LLM call.** Summarization call is itself a checkpointed durable operation.
- [x] **RAG strategy replaces full history with vector-retrieved context.** Pluggable vector store interface.
- [x] **Context state is part of the checkpoint.** After strategy application, compacted context restored directly on recovery. No re-running the strategy.
- [x] **Configurable buffer percentage for early compaction.** `compactAt: 0.85` triggers compaction at 85% of `maxTokens`.
- [x] **`AgentContextCompactedEvent` dispatched when strategy triggers.** Includes strategy name, `tokensBefore`, `tokensAfter`, `messagesDropped`.
- [x] **Default strategy is no-op pass-through.** Full conversation history sent to LLM. `CheckpointSizeWarningEvent` emitted if conversation exceeds size threshold.
- [x] **Composable strategies.** `composeStrategies(slidingWindow(...), summarize(...))` applies strategies in sequence with checkpoints between.

### Agent-Native Engine: Multi-Agent Coordination

- [x] **`ctx.handoff()` transfers execution to another agent with context.** Starts a child workflow running the target agent. Returns the child's result. Delegator pauses at `yield*` boundary.
- [x] **Selective context forwarding in handoff.** `forwardContext: "summary"` sends compressed history. `forwardContext: "none"` sends only structured input.
- [x] **`ctx.debate()` runs adversarial multi-agent review.** Alternates between agents for N rounds. Each round is a checkpoint. Judge agent resolves. Returns verdict plus full transcript.
- [x] **`ctx.supervise()` runs multiple agents with synthesis strategy.** Strategies: `"consensus"` (all agree), `"best-of-n"` (supervisor picks), `"merge"` (combine outputs).
- [x] **`SharedState` primitive with durable CAS operations.** `ctx.sharedState(name, { initial })` returns a handle for concurrent read/write. Optimistic concurrency control with automatic retry on conflict.
- [x] **`SharedState` uses `batch()` for atomic updates.** Writes committed atomically with checkpoint.
- [x] **`ctx.handoff()` preserves OpenTelemetry trace context.** Child workflow spans link back to parent agent's span. `createChildHeaders()` utility in coordination module; engine injects parent headers into handoff options.
- [x] **`ctx.all()` with agent-typed branches.** Parallel agents with independent checkpointing, token budgets, and context windows. Each branch's cost tracked independently.
- [x] **Agent-to-agent message passing via signals.** Agents within same workflow communicate via `ctx.signal()` on child handles.
- [x] **Multi-agent fan-out respects workflow-level budget.** Shared `BudgetTracker` passed through `handoff()`, `debate()`, and `supervise()`. `supervise()` wires budget to `AbortController` for parallel branch enforcement.

### Agent-Native Engine: Observability

- [x] **`AgentTurnStartedEvent` dispatched at start of each turn.** Includes `workflowId`, `agentId`, `turnIndex`, `model`, `inputTokenEstimate`, `conversationLength`.
- [x] **`AgentTurnCompletedEvent` dispatched at end of each turn.** Includes `turnIndex`, `model`, `selectedModel`, `inputTokens`, `outputTokens`, `cost`, `cumulativeCost`, `duration`, `toolCallCount`, `fallbackAttempts`, `reasoningTrace`.
- [x] **`AgentToolCalledEvent` dispatched on tool invocation.** Includes `toolName`, `toolInput`, `source` (`"local"` | `"mcp"`), `operationId`.
- [x] **`AgentToolReturnedEvent` dispatched on tool completion.** Includes `toolName`, `duration`, `success`, `operationId`.
- [x] **`AgentBudgetWarningEvent` dispatched at configurable threshold.** Default: 80%. Includes `budgetUsedPercent`, `tokensRemaining`, `costRemaining`.
- [x] **`AgentBudgetExceededEvent` dispatched when budget exhausted.** Includes `tokensUsed`, `costUsed`, `tokenBudget`, `maxCost`.
- [x] **Reasoning trace captured per turn.** Model `thinking` blocks stored in checkpoint and included in `AgentTurnCompletedEvent`.
- [x] **Cost waterfall per turn queryable.** `handle.query("agentCostWaterfall")` returns per-turn array: `[{ turn, inputTokens, outputTokens, cost, model, tools }]`.
- [x] **Conversation history queryable.** `handle.query("agentConversation")` returns full message array including system prompt, user messages, assistant responses, and tool results.
- [x] **Cost projection based on burn rate.** `handle.query("agentCostProjection")` estimates total cost at completion based on average per-turn cost.
- [x] **Dashboard agent view.** Built-in dashboard includes: conversation timeline, tool calls with inputs/outputs, token usage per turn, cumulative cost curve, budget remaining gauge, reasoning trace accordion, real-time streaming output.
- [x] **`AgentContextCompactedEvent` dispatched on context strategy trigger.** Includes `strategy`, `tokensBefore`, `tokensAfter`, `messagesDropped`.
- [x] **`HumanReviewRequestedEvent` and `HumanReviewCompletedEvent` dispatched.** Includes `workflowId`, `reviewId`, `type`/`decision`, `reviewer`, `duration`.
- [x] **All agent events are typed `Event` subclasses in `WeftEventMap`.** Typed `addEventListener` works for all agent events.
- [x] **OTel span hierarchy includes agent turns.** `agent` span > `agent:turn:N` spans > `agent:tool:call` spans. Attributes: `weft.agent.model`, `weft.agent.turn_index`, `weft.agent.cost`.

### Agent-Native Engine: Model Routing

- [x] **Per-turn model selection via `modelRouter` option.** `ModelRouter` interface: `select(context: RoutingContext) → ModelSelection`. Receives turn index, budget remaining, conversation length.
- [x] **Static fallback chain.** `staticFallbackRouter(["gpt-4o", "claude-haiku-4-5-20251001"])` — next model tried on failure (rate limit, timeout, outage). Each fallback attempt dispatches `AgentModelFallbackEvent`.
- [x] **Dynamic model routing based on turn characteristics.** Routing function receives conversation state and returns model + reason.
- [x] **A/B testing via weighted model selection.** `abTestRouter()` uses FNV-1a hash for deterministic per-workflow-ID distribution. Results tagged with model attribution in `AgentTurnCompletedEvent.selectedModel`.
- [x] **Cost-tier routing based on budget remaining.** `costTierRouter()` declares tiers and thresholds. Engine switches to cheaper model when budget drops below threshold.
- [x] **Engine-level default model router.** Router passed as option to `executeAgentLoop()`. Per-call overrides available.
- [x] **Fallback attempts recorded in observability events.** `AgentTurnCompletedEvent` includes `fallbackAttempts`. `AgentModelFallbackEvent` dispatched on each fallback.
- [x] **Provider health tracking with circuit breaker.** `ProviderHealthTracker` implements sliding window error rate tracking with closed→open→half-open circuit breaker. `AgentProviderCircuitOpenEvent` dispatched.
- [x] **Model selection checkpointed for deterministic recovery.** `previousModels` array accumulated per turn for recovery.

### Agent-Native Engine: Agent-First Declaration

- [x] **`defineAgent()` top-level declaration API.** Declares a reusable agent definition passable to `engine.register()`, `ctx.agent()`, `ctx.handoff()`, and `ctx.debate()`.
- [x] **Durable hooks: `beforeTurn`.** Runs before each LLM call within checkpoint boundary. Can modify messages, inject context, or skip turn.
- [x] **Durable hooks: `afterToolCall`.** Runs after each tool call. Can modify tool result, trigger human review.
- [x] **Durable hooks: `onBudgetWarning`.** Invoked in the agent loop when budget usage crosses 80% threshold. Fires once per agent execution.
- [x] **Context strategy declared on agent definition.** Applies to all invocations. Per-call override via `ctx.agent({ contextStrategy })`.
- [x] **Model router declared on agent definition.** Applies to all invocations. Per-call override available.
- [x] **Engine optimizes for agent-shaped workflows.** When agent-typed workflow detected: priority tool call queuing, LLM connection pre-warming, checkpoint compression for conversation-heavy state.
- [x] **Type-safe agent definitions.** `defineAgent<InputType, OutputType>({ ... })` — compile-time type checking on `engine.start()` and `handle.result()`.
- [x] **Agent definitions compose with workflow registration.** `engine.register(researchAgent)` registers as standalone workflow. Same definition usable as embedded step via `ctx.agent(researchAgent, input)`.
- [x] **`defineAgent()` and `ctx.agent()` share implementation.** Top-level is standalone form; embedded form uses same underlying `executeAgentLoop()`.

### Workflow Versioning

- [x] **Workflow version stored in `wf:{id}` state blob.** Set at workflow start from the currently registered version.
- [x] **`engine.register()` accepts a version and optional migration function.** Shorthand `engine.register(name, fn)` defaults to version `"0.0.0"`.
- [x] **Version mismatch triggers migration on resume.** `migrate(checkpoint, fromVersion)` called when stored version differs from registered version.
- [x] **No migration function = resume as-is.** Backward-compatible checkpoint shapes work without explicit migration.
- [x] **Failed migration produces a `VersionMismatchError`.** Error includes both versions, workflow ID, and workflow type.
- [x] **Migrated checkpoint is persisted atomically.** Updated checkpoint and version written to storage in one `batch()` call.
- [x] **Version visible in API and dashboard.** `GET /v1/workflows/:id` returns the version field.
- [x] **Migration function receives structuredClone-compatible data.** The checkpoint passed to `migrate()` is the deserialized checkpoint state.

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
- [x] **Multi-value attributes (keyword_list) create one index entry per element.** Setting `tags: ["a", "b"]` creates two index keys.
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
- [ ] **Index scan performance: <1ms for single-attribute equality filter on 100K workflows.** Benchmarked on SQLite.

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

- [x] **`WorkflowInterceptor` interface defined with typed hooks.** Hooks: `activity`, `sleep`, `waitForSignal`, `agent`, `workflowStart`, `signalReceived`, `query`.
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
- [x] **Each `ctx.agent()` creates a child span.** Named `agent`. Attributes: `weft.agent.model`, `weft.agent.token_budget`.
- [x] **Trace context propagates to local Activity Workers via `postMessage`.** W3C `traceparent` in the `headers` map.
- [x] **Trace context propagates to remote Activity Workers via WebSocket.** `headers` field in the `task` message. Validated by `remote-propagation.test.ts`.
- [x] **Activity-side interceptor extracts trace context and creates a child span.** Named `activity:execute:{activityName}`.
- [x] **Child workflow spans use OpenTelemetry span links, not parent-child.** Independent lifecycle.
- [x] **`recordPayloads` option records activity inputs/outputs as span attributes.** Off by default.
- [x] **`maxPayloadSize` truncates recorded payloads.** Prevents unbounded attribute sizes.
- [x] **`attributeExtractor` allows custom span attributes.** User-provided function receives interception context via `ObservabilityOptions`.
- [x] **Error spans record exception details.** `span.recordException()` called. `span.setStatus({ code: ERROR })` set.
- [x] **Span hierarchy is correct.** Workflow span > activity/sleep/signal/agent spans > user spans inside activities.
- [x] **OpenTelemetry metrics defined.** `weft.workflow.duration`, `weft.activity.duration`, `weft.activity.attempts`, `weft.workflow.active`.
- [ ] **Metrics exportable to Prometheus via standard OTel exporter.** `/v1/metrics` backed by OTel metrics.
- [x] **Remote worker example in documentation.** Shows `interceptors: [activity]` on remote worker constructor. (See `docs/guides/remote-workers.md`; search for `const { activity } = createObservabilityInterceptors()` and the nearby `new RemoteWorker({ … interceptors: [activity] })` example.)
- [x] **Composable with other interceptors.** Works correctly combined with auth, validation, encryption interceptors.

### DX

- [x] **Zero config to start.** `import { Engine } from "weft"; new Engine()` works with defaults (in-memory storage).
- [x] **`bun add weft` is the only install step.** No codegen, no proto files, no Docker.
- [x] **TypeScript types infer everything.** Event listeners, workflow context, activity return types — all inferred.
- [x] **`using` / `await using` works for all resources.** No manual cleanup ever required.
- [x] **Testing: `MemoryStorage` + `TestEngine.advanceTime()`.** No real timers in tests. `TestEngine` provides deterministic time control via `TimeControl`.
- [x] **Error messages reference the user's code, not Weft internals.** Stack traces are clean. All operation types capture `callerStack` and all engine error handlers enrich errors with the workflow call site.
- [ ] **Documentation: every public API has JSDoc with examples.** Visible in IDE hover. (Partially implemented — descriptions present but most lack code examples.)
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
- [x] **`weft/testing` module with `TestEngine`.** Real engine with `MemoryStorage`, deterministic time control, crash simulation via `engine.recover()`.
- [x] **`ctx.archive()` moves old state out of checkpoint.** Preserved at `archive:{workflowId}:{key}` for auditing, queryable via dashboard and API.
- [x] **`ctx.expose()` for live workflow inspection.** Accessor functions evaluated at each checkpoint, rendered on dashboard without pre-registered query handlers.
- [x] **Checkpoint history (last N).** Configurable number of retained checkpoints per workflow for time-travel debugging.
- [x] **`activity()` helper with colocated configuration.** Retry, timeout, queue, and idempotency declared on the activity definition.
- [x] **`ctx.runAll()` with named concurrent branches.** Per-branch error handling policies (`onError: "continue"`).
- [x] **`ctx.setBudget()` / `ctx.budgetRemaining()` for agent cost tracking.** Budget state stored in checkpoint, enforced via `AbortController`.
- [x] **Tool result caching across agent turns.** Cache keyed by tool name + serialized arguments via `buildCacheKey`, configurable TTL.
- [x] **`ctx.stream()` for large payloads.** Writes data to storage as chunks via `ReadableStream`, leaves lightweight reference in checkpoint.
- [x] **Automatic payload compression.** Transparent gzip/brotli compression above configurable threshold.
- [x] **Pluggable serialization.** `Serializer` interface in `src/core/types.ts` with `serialize`/`deserialize` methods, passable to Engine options.

### Competitive Parity & Gap Closure

The Temporal-derived pain points above are architecturally solved. This section tracks the remaining gaps versus the newer AI-native alternatives documented in the "Competitive Landscape" and "Honest Gaps" sections earlier in this document. Each item is a binary acceptance criterion, flipped to `[x]` when implemented and verified.

- [x] **Serverless suspension primitive.** `ctx.suspendUntil(resumeToken)` in `src/core/context.ts` yields to `waitForSignal(resumeToken)`, persisting a checkpoint so the engine can drop the in-memory workflow until the resume signal arrives. Resume is via the existing `POST /v1/workflows/:id/signal/:token` endpoint (or `engine.signal(workflowId, resumeToken, payload)`). See tests in `src/core/suspend.test.ts` for multi-suspension flows. **Caveat**: in `WorkerExecutionStrategy` the per-workflow worker is held in `#workersByWorkflowId` until the workflow completes, so the "worker is free to do other work while parked" benefit only applies to inline execution. Releasing the worker on suspend in worker mode is tracked under "Agent-loop suspension integration" below.
- [ ] **Agent-loop suspension integration.** `src/ai/agent.ts` and `src/ai/streaming-agent.ts` call `ctx.suspendUntil()` before LLM `fetch()` when the engine is configured with `suspendOnLlmWait: true` AND the provider exposes a resume hint. Opt-in because not every provider supports async resume. Deferred: requires a provider that actually supports async resume hints; the primitive above is in place for future opt-in.
- [x] **Multi-tenant context.** `TenantResolver` interface in `src/core/tenant.ts`; engine option `tenantResolver` populates `ctx.tenant: TenantContext | undefined` at workflow start and persists it on `WorkflowState.tenant` so it survives recovery. `tenantFromInputField(name)` is a convenience resolver for the common case.
- [x] **Per-tenant agent customization.** `defineAgent()` accepts `toolsForTenant?: (tenant) => AgentToolDefinition[]` and `validateInput?: (input, tenant) => void`. The engine's generated workflow handler calls `validateInput` before the agent loop and substitutes `toolsForTenant(ctx.tenant)` for the static tool set.
- [x] **Tenant context in worker-execution mode.** `WorkerInboundMessage.run` carries an optional `tenant` field across `postMessage`; `WorkerExecutionStrategy.startWorkflow` forwards the resolved tenant; and `src/workers/workflow-runner.ts` builds a worker-side `WorkerWorkflowContext` (`workflowId`, `tenant`, `signal`, `startedAt`) that is passed as the first argument to registered handlers. The constructor stop-gap is gone — `workerExecution` and `tenantResolver` can be combined. Engine-side fields like `executionTimeRemaining` are stub values inside the worker because the worker has no clock authority; user code that needs them should stay on inline mode. Regression test in `src/ai/agent-worker-tenant-isolation.test.ts` runs three workflows through a real `Worker` and asserts that `tenant-a` sees `toolA`, `tenant-b` sees `toolB`, and an unexpected tenant fails via `validateInput`.
- [x] **Routing policies.** `RoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share'` in `src/worker/registry.ts`. `WorkerRegistry` constructor accepts `{ policy }`; `findWorker(activity, { fairShareKey })` consults per-worker per-key counts. All three policies are plumbed end-to-end: `TaskDispatch.fairShareKey` is threaded through `dispatchTaskImpl` → `findWorker` → `assignTask` in `src/server/index.ts`, and a server-level integration test asserts fair-share distributes across keys when dispatched via `serve()`.
- [x] **Task queue scheduling policies.** `TaskQueueOptions.schedulingPolicy: 'priority' | 'fifo' | 'lifo'` in `src/server/task-queue.ts`, default `'priority'` (current behavior). Plumbed through `serve({ schedulingPolicy })`.
- [ ] **Virtual-Object-style session state.** `ctx.sessionState(key)` co-located with the sticky worker. Builds on existing `workerAffinity` in `src/server/index.ts`; session state survives worker restart via checkpoint.
- [x] **AI dashboard detail view (core).** `src/dashboard/views/workflow-detail-agent.svelte` composes `AgentTurn`, `AgentBudgetGauge`, `EventTimeline`, `JsonViewer`, and `ExecutionDeadline` into a dedicated agent workflow detail page. Reachable via `/ui/workflows/:id/agent` (router entry in `src/dashboard/router.svelte.ts`). Per-turn model, token counts, cost, and tool-call results are already rendered; live token streaming shows current output.
- [x] **AI dashboard detail view (enhancements).** Three new fragments now ship alongside the existing agent detail view: `src/dashboard/fragments/agent-cost-waterfall.svelte` renders a per-turn cost bar chart normalized against the max-cost turn; `src/dashboard/fragments/agent-conversation.svelte` renders the rolling conversation history grouped by turn with collapsible system/tool blocks and truncation badges; `src/dashboard/fragments/agent-reasoning-trace.svelte` renders an accordion of provider reasoning traces. Each fragment pairs with a pure `.ts` helper (`computeWaterfallBars`, `groupConversationMessages`, `buildReasoningEntries`) unit-tested via `bun:test`. Backing event plumbing: `AgentTurnCompletedEvent` carries a `messages` snapshot produced by `src/ai/event-message-snapshot.ts` (caps at 8KB per message, 4KB per tool result, 200 messages per snapshot) and the existing `reasoningTrace` field is now consumed by the dashboard.
- [x] **OTel standard Prometheus exporter.** `PrometheusExporter` interface in `src/observability/metrics.ts` with a default `createMetricsCollectorExporter(collector)` implementation. `/v1/metrics` handler delegates to `options.prometheusExporter` when provided, letting projects plug in `@opentelemetry/exporter-prometheus` (or any OTel reader) without forcing it as a runtime dependency. Server `ServeOptions` exposes the plug point.
- [x] **Index scan benchmark.** `src/benchmarks/search-attributes-scan.test.ts` seeds 100K workflows with a `customerId` attribute against `BunSQLiteStorage`; median latency measured at ~0.14ms (p95 ~0.2ms). Implementation fix: `engine.list()` now loads constrained IDs directly from storage instead of full-scanning `wf:*`, turning the operation from O(total workflows) into O(matches).
- [x] **JSDoc examples on public API.** The `weft` module entrypoint, `Engine`, `activity`, and `defineAgent` carry `@example` blocks covering the "hello world", "multi-tenant", "activity with retry", and "per-tenant tool customization" cases. Additional exports retain their existing descriptions and inherit the module-level examples. New exports surface the tenant, routing, scheduling, and Prometheus primitives added in this roadmap.
- [~] **Performance targets measured against spec.** Every benchmark in `src/benchmarks/` was re-run after Item 3 optimizations (2026-04-07). Five of eight targets meet spec outright (recovery, library cold start, **binary cold start**, event dispatch, search attribute scan). Three remain partially closed: workflow starts (~19K/sec vs 50K/sec), activity completions (~10K/sec vs 30K/sec), memory per workflow (~6.8-9.3KB vs 2KB). The remaining gaps are architectural — closing them requires pipelining the start batch, coalescing completion-path deletes, or evicting suspended generators between yields. Benchmark thresholds now enforce the post-optimization floor; no threshold was silently relaxed. Full numbers in `reference/IMPORTANT.md`.

### Performance Targets

- [ ] **Workflow starts: >50K/sec** (single node, SQLite) — measured ~19K/sec (post-optimization, up from ~13K/sec)
- [ ] **Activity completions: >30K/sec** (single node, SQLite) — measured ~10K/sec (post-optimization, up from ~9K/sec)
- [x] **Workflow recovery: <1ms** (O(1) checkpoint load) — measured ~0.08ms median
- [ ] **Memory per workflow: ≤2KB** (checkpoint blob) — measured ~6.8KB isolated, 7.7-9.3KB under full-suite pollution
- [x] **Cold start: <100ms** (binary mode), <50ms (library mode) — measured ~36ms binary (warm-cache median, 5 runs), ~0.14ms library
- [ ] **Token stream latency: <10ms** (engine to WebSocket client)
- [x] **Event dispatch: <100μs** (EventTarget overhead per event) — measured ~0.18μs per dispatch
- [ ] **Worker spawn: <5ms** (Web Worker creation in Bun)
- [ ] **10x faster than Temporal on workflow start** (benchmarked head-to-head)
- [x] **100x faster on workflow recovery** (O(1) vs O(n) replay) — recovery target met
- [ ] **5x lower memory per workflow** (~2KB vs ~50KB+) — current ~7KB still beats Temporal but misses spec target

---

## Research

The long-form research synthesis moved to [./architecture/research.md](./architecture/research.md). That document captures the paper-by-paper analysis, the performance-gap framing, and the distilled sequencing rationale that originally lived inline here.

The roadmap below carries forward the implementation work derived from that research. It is intentionally checklist-first, and it preserves one architectural constraint throughout: every transport-facing addition remains an adapter over the existing `Engine` methods, typed `EventTarget` events, `BroadcastChannel` coordination, and Worker `postMessage` protocols rather than a second orchestration system.

## Acceptance criteria (verifiable checklist)

### Track 1 — Foundations

- [x] `src/ai/tool-effect-log.ts` exists, exports `ToolEffectLog` with `record(semanticHash, toolName)`, `lookup(semanticHash)`, `commit(semanticHash, toolName, output)`, `abort(semanticHash, toolName, reason)`. (Note: file named for behavior, not paper acronym; `computeSemanticHash` and `ToolCallReplayConflictError` also exported.)
- [x] `AgentToolDefinition` in `src/ai/declaration.ts` has an optional `identity: (input) => { semanticHash: string; intentCriticalFields: string[] }` field.
- [x] `executeAgentLoop` in `src/ai/agent.ts` consults the effect log before every tool call and short-circuits on `committed` matches.
- [x] `bun test src/ai/tool-effect-log.test.ts` passes tests that crash mid-tool-call, restore, and assert the tool ran exactly once (mock call count verified).
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

- [x] `Activity` and `AgentToolDefinition` support an optional `verify: (result) => Promise<boolean>` hook.
- [x] `ctx.speculate(fn)` runs a child generator against a copy-on-write checkpoint view; commits only after verifications drain.
- [x] On verification failure, the speculative branch is discarded and compensators (Track 1) run for any externalized effects.
- [x] `benchmarks/speculation.bench.ts` exists; asserts ≥30% end-to-end latency reduction on a 5-turn agent workflow with 500ms mock tool latency, across ≥100 runs, with zero incorrect results.
- [x] `src/ai/prompt-cache.ts` exists; implements a templated radix tree for prefix sharing; exposes hit/miss counters via the metrics collector.
- [x] `src/benchmarks/prompt-cache.test.ts` shows ≥49% hit rate on a realistic workload and <1ms per-call overhead.
- [x] Activity completions benchmark: `benchmarks/throughput.bench.ts` reports ≥20K/sec (up from ~9K/sec; spec is >30K/sec).
- [x] Memory per workflow: `benchmarks/memory.bench.ts` reports ≤5KB/workflow on a synthetic population of 10K workflows (down from ~7–15KB; spec is ≤2KB).
- [x] `bun run typecheck` and `bun test` both exit 0 after Track 3 lands.

### Track 4 — Multi-agent reliability

- [x] `AgentResult` includes an optional `confidence: number` field in [0, 1].
- [x] `supervise({ ..., voting: 'confidence-weighted' })` computes consensus using vote weights proportional to confidence scores.
- [x] `supervise({ ..., n: (task) => number })` supports dynamic n-sizing.
- [x] `src/observability/metrics.ts` exposes `weft.dpmo.defects` and `weft.dpmo.operations`, with a derived `weft_dpmo` gauge exported via the existing Prometheus path.
- [x] `bun test src/ai/__tests__/bft.test.ts` passes a test with 3 byzantine agents vs 2 honest agents where confidence-weighted voting produces the correct answer and naive voting does not.
- [x] `AgentDefinition` and `AgentToolDefinition` expose a `version: string` field.
- [x] Event log entries (Track 1) record `(workflowVersion, agentVersion, toolVersions[])` on every event.
- [x] Resuming a workflow whose recorded version tuple is incompatible with the currently-registered versions, with no migration hook provided, throws `VersionMismatchError` with a structured breakdown of which component mismatched.
- [x] `bun test src/core/__tests__/workflow-version-resume.test.ts` passes a test that resumes a mid-flight workflow across a tool-schema version bump, with and without a migration hook.

### Track 6 — Storage ergonomics

The `Storage` interface is the right primitive for Weft internals (binary KV with range scans and atomic batch). But consumers building higher-level abstractions on top — application state, caches, session stores, configuration — hit friction that should be smoothed out at the Weft level rather than reimplemented by every consumer.

- [x] **`has(key)` method on `Storage`.** Returns `Promise<boolean>`. Adapters implement efficiently: SQLite uses `SELECT 1 … LIMIT 1`, LMDB checks key existence without value copy, Memory checks `Map.has()`. Avoids deserializing the full value just to check existence. Default implementation falls back to `get(key) !== null` so existing adapters aren't broken.
- [x] **`deletePrefix(prefix)` method on `Storage`.** Returns `Promise<number>` (count of deleted keys). SQLite uses `DELETE FROM kv WHERE key >= ? AND key < ?` in one statement. LMDB uses range delete. Memory iterates and deletes. Avoids the `scan()` → collect all keys → `batch(deletes)` round-trip that forces holding all keys in memory.
- [x] **`keys(prefix, options?)` method on `Storage`.** Returns `AsyncIterable<string>` (keys only, no values). Same signature as `scan()` minus the value in the tuple. SQLite uses `SELECT key FROM kv WHERE …` (no blob read). LMDB iterates keys without value materialization. Useful when consumers only need to list or count entries without reading payloads.
- [x] **`count(prefix)` method on `Storage`.** Returns `Promise<number>`. SQLite uses `SELECT COUNT(*) FROM kv WHERE …`. Avoids streaming every entry through an async iterator just to count. Useful for dashboards, health checks, and queue depth monitoring.
- [x] **`storage.scoped(prefix)` namespace utility.** Returns a `Storage` instance where all operations are transparently prefixed with `${prefix}:` and `scan()`/`keys()` results have the prefix stripped. Composes: `storage.scoped('a').scoped('b')` produces keys under `a:b:`. Shipped as a utility alongside `CompressedStorage`, with optional `storage.scoped(prefix)` support on Weft's built-in adapters and `ScopedStorage` itself, so third-party adapters are not required to implement it.
- [x] **`TypedStorage<T>` codec wrapper.** `withCodec(storage, codec)` returns a higher-level interface: `get(key): Promise<T | null>`, `put(key, value: T): Promise<void>`, with `scan`, `batch`, etc. forwarding through the codec. Ships with `jsonCodec` (JSON string round-trip) and `msgpackCodec` (MessagePack round-trip via the existing codec module). Eliminates `TextEncoder`/`TextDecoder` boilerplate for every consumer that stores structured data.
- [x] **All new methods are optional on the `Storage` interface.** Marked with `?` so existing third-party adapters aren't broken. Weft's built-in adapters (BunSQLite, LMDB, Memory, IndexedDB, Turso) implement all of them. The `scoped()` and `withCodec()` utilities work with any `Storage` that implements the core five methods.
- [x] **Tests cover all new methods across all built-in adapters.** The existing parametrized storage test factory (`src/testing/storage-backends.ts`) is extended with cases for `has`, `deletePrefix`, `keys`, and `count`. The `scoped()` and `withCodec()` utilities have dedicated test files.
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
- [x] Tests cover: create/fire/cancel cycle, overlap policies, backfill after downtime, cron edge cases (Feb 29, DST transitions), multi-tenant schedule isolation.

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

#### 7e. Per-tenant resource quotas

- [x] **`EngineOptions.quotas` configures per-tenant limits.** Accepts `{ maxConcurrentWorkflows?: number, maxWorkflowCreationRate?: { count: number, window: Duration }, maxStorageBytes?: number }`.
- [x] **Quota violations throw `QuotaExceededError`.** Error includes: which quota was violated, current usage, and the limit. Callers can catch and decide whether to queue, reject, or wait.
- [x] **Quotas are enforced at `engine.start()` time.** Concurrent workflow count checked atomically with workflow creation. Rate limit uses a sliding window counter stored at `quota:{tenant}:rate:{window}`.
- [x] **Quotas are queryable.** `engine.getQuotaUsage(tenantId)` returns current usage vs. limits. Exposed via `GET /v1/tenants/:id/quota`.
- [x] **Quota usage visible in dashboard.** Per-tenant usage gauges with warning thresholds.

#### 7f. Lightweight tagging

- [x] **`StartOptions.tags` accepts `string[]`.** Tags are stored alongside workflow state and indexed for filtering. Unlike search attributes, tags require no schema declaration — they're free-form labels.
- [x] **`handle.addTags(...tags)` and `handle.removeTags(...tags)` mutate tags on a running workflow.** Changes are durable immediately when the tag mutation is persisted.
- [x] **`engine.list({ tags: ['nightly', 'v2'] })` filters by tag intersection.** A workflow matches if it has all specified tags.
- [x] **Tags are distinct from search attributes.** Search attributes are typed, schema-declared, and support range queries. Tags are untyped, schema-free, and support only equality/intersection. Both are useful; neither replaces the other.
- [x] Tags visible in dashboard workflow list as badges. Filterable via tag chips in the UI.

#### 7g. Bulk operations

- [x] **`engine.cancelAll(filter)` cancels all workflows matching a filter.** Returns `{ cancelled: number, failed: number, errors: Array<{ id, error }> }`. Filter supports the same shape as `engine.list()` (type, status, attributes, tags).
- [x] **`engine.signalAll(filter, name, payload?)` sends a signal to all matching workflows.** Returns `{ signalled: number, failed: number }`.
- [x] **`engine.deleteAll(filter)` permanently removes all matching terminal workflows.** Only operates on terminal statuses (completed, failed, cancelled, timed-out). Returns `{ deleted: number }`. Rejects if filter would match running workflows.
- [x] **`engine.tagAll(filter, tags)` and `engine.untagAll(filter, tags)` bulk-modify tags.** Returns `{ modified: number }`.
- [x] **All bulk operations have HTTP equivalents.** `POST /v1/workflows/bulk/cancel`, `POST /v1/workflows/bulk/signal`, `DELETE /v1/workflows/bulk`, `PATCH /v1/workflows/bulk/tags`.
- [x] **Bulk operations are batched internally.** Process in chunks of 1000 to avoid holding storage locks. Progress is observable via returned counts.

#### 7h. Workflow forking

- [x] **`engine.fork(workflowId, options?)` creates a new workflow from an existing workflow's checkpoint.** The forked workflow starts from the same step with the same accumulated results, but gets a new ID and can diverge from that point. Original workflow is unaffected.
- [x] **Fork options include `{ fromStep?: number }`.** Default: fork from the latest checkpoint. `fromStep` allows forking from a historical checkpoint (if checkpoint history is retained).
- [x] **Fork records lineage.** Forked workflow state includes `forkedFrom: { workflowId, step }`. Queryable via search attribute `weft:forkedFrom`.
- [x] **`POST /v1/workflows/:id/fork` HTTP endpoint.** Returns the new workflow handle.
- [x] Tests cover: fork and diverge, fork from historical step, fork a completed workflow (starts from last checkpoint, re-runs terminal step), fork lineage chain (A → B → C).

#### 7i. Event replay and time-travel debugging

Weft already has a hash-chained event log — the data is there, but there's no query interface for inspecting or replaying it.

- [x] **`engine.getTimeline(workflowId)` returns a structured timeline.** Each entry includes: step number, operation type, input summary, output summary, duration, timestamp, and version tuple. This is a high-level view — not raw events, but a human-readable execution trace.
- [x] **`engine.replayTo(workflowId, step)` reconstructs workflow state at a historical step.** Returns the checkpoint, accumulated results, and event log up to that point. Read-only — does not modify the workflow.
- [x] **Dashboard timeline view.** Visual execution trace showing each step as a node: what operation ran, what it returned, how long it took, and what the checkpoint looked like at that point. Clicking a step shows the full checkpoint state (locals, accumulated results, search attributes).
- [x] **Dashboard diff view.** Select two steps and see what changed between them: new locals, changed search attributes, budget consumption delta, conversation growth.
- [x] **`GET /v1/workflows/:id/timeline` HTTP endpoint.** Returns the structured timeline as JSON.
- [x] **`weft timeline <workflowId>` CLI subcommand.** Prints the execution trace to stdout. `--step N` shows checkpoint state at step N. `--diff N M` shows the delta between two steps.

#### 7j. Streaming resumption tokens

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

- [ ] **The runtime API has one transport-neutral operation catalog.** It covers runtime operations only, not authoring APIs. Each entry defines the `Engine` method mapping, JSON Schema for params and result, auth requirement, authorization policy hook, REST route metadata, JSON-RPC method name, and shared error mappings.
- [ ] **Authoring APIs remain intentionally TypeScript-only.** `engine.register()`, workflow/activity/agent declarations, providers, storage adapters, interceptors, and execution-strategy wiring are documented as in-process authoring surfaces rather than transport-parity endpoints.
- [ ] **Both `/openapi.json` and `/openrpc.json` are generated from the same operation catalog.** JSON-RPC is not inferred from OpenAPI, and OpenAPI is not treated as a lossy source for JSON-RPC.
- [ ] **`rpc.discover` returns the same OpenRPC document exposed at `/openrpc.json`.** Clients can fetch the machine-readable JSON-RPC contract over JSON-RPC itself without a second documentation pipeline.
- [ ] **`/openapi.json` is a full OpenAPI 3.1 contract for the REST-ish HTTP surface.** It includes path and query parameters, request bodies, response schemas by status code, shared error objects, and security declarations.
- [ ] **REST and JSON-RPC requests dispatch into the same `Engine` methods.** No runtime feature lands on one transport without being modeled in the shared operation catalog first.
- [ ] **The parity surface covers all data-driven runtime operations.** Workflow lifecycle, signals, updates, queries, review flows, attributes, checkpoints, events and timeline access, schedules, fork and bulk operations, and stream retrieval are all transport-addressable.

#### 8a. Eventing and stream projection

- [ ] **Track 8 does not introduce a second orchestration layer or event bus.** External transports adapt the current engine/runtime primitives instead of replacing them.
- [ ] **External subscriptions project from existing typed `EventTarget` events.** `Engine` and `WorkflowHandle` events remain the source of truth for watch and stream semantics.
- [ ] **`BroadcastChannel` remains the internal cross-worker coordination primitive.** Transport-specific publish-subscribe machinery does not replace the current internal coordination model.
- [ ] **Worker `postMessage` remains the internal worker execution protocol.** `WorkerInboundMessage` and `WorkerOutboundMessage` stay internal runtime messages; external JSON-RPC does not become a second worker protocol.
- [ ] **One server-side event projection layer feeds every live transport.** WebSocket watch and token messages, SSE responses, JSON-RPC subscription notifications, and cursor-based replay all project from the same event stream model.
- [ ] **All live views share the same sequence and cursor semantics.** Replay, resume, and ordering rules are identical across HTTP, WebSocket, and the Track 8 runtime stdio JSON-RPC transport.

#### 8b. JSON-RPC transport surface

- [ ] **JSON-RPC 2.0 is supported over three runtime transports.** `POST /jsonrpc`, WebSocket upgrade on `/jsonrpc`, and newline-delimited JSON over a dedicated stdio runtime entrypoint. This stdio runtime surface is distinct from the existing MCP stdio JSON-RPC transport in `weft/mcp/stdio`; they may share framing or codec helpers if useful, but they are different protocol surfaces with different method namespaces and semantics.
- [ ] **Runtime JSON-RPC methods use stable namespaced names.** Examples: `weft.workflows.start`, `weft.workflows.get`, `weft.workflows.signal`. These names belong to the runtime API surface and are not MCP method names.
- [ ] **JSON-RPC uses named params only.** The OpenRPC contract documents `paramStructure: "by-name"` so generated clients and manual callers converge on one request shape.
- [ ] **Batch requests are supported.** The shared dispatcher validates and executes JSON-RPC batches without inventing transport-specific behavior.
- [ ] **Notifications are opt-in per method.** Mutating operations default to request-response so callers do not silently lose errors or authorization failures.
- [ ] **Subscription notifications reuse the shared event projection layer.** Watch and stream APIs are documented as projections of current engine events rather than bespoke server-side state machines.

#### 8c. Error handling

- [ ] **Reserved JSON-RPC protocol errors follow the specification exactly.** `-32700`, `-32600`, `-32601`, `-32602`, and `-32603` keep their standard meanings.
- [ ] **Weft domain failures use a separate stable application error range outside the reserved protocol band.** Business and workflow errors do not overload the reserved JSON-RPC codes.
- [ ] **JSON-RPC `error.data` carries structured machine-readable detail.** At minimum it includes the canonical Weft application code and the related HTTP status when the same failure is exposed over REST.
- [ ] **REST and JSON-RPC share one engine-error mapping layer.** The same engine failure produces equivalent transport-level semantics across both surfaces.

#### 8d. Authentication and authorization

- [ ] **The design documents current state accurately.** HTTP authentication already exists, and `serve()` authenticates the incoming `Request` before a WebSocket upgrade is accepted.
- [ ] **Track 8 adds transport-neutral authorization for runtime operations.** REST, JSON-RPC over HTTP, JSON-RPC over WebSocket, SSE, and future transports all call the same per-operation authorization hook after authentication and before dispatch.
- [ ] **WebSocket sessions bind authenticated identity at upgrade time.** Every JSON-RPC call on that socket reuses the established principal instead of re-authenticating per frame.
- [ ] **stdio is a separate opt-in local entrypoint, disabled by default.** It is not implicitly enabled by `serve()` and is not treated as a public unauthenticated surface.
- [ ] **stdio authorization uses the same operation-level policy hook once a session exists.** Local process boundaries are the default guard, with optional startup-token hardening for stricter deployments.

### Final verification

> Coverage rule: each behavioral or cross-cutting structural criterion has a real, non-skipped Bun test whose `it(...)` (or `test(...)` — the Bun aliases are equivalent) title quotes the criterion text from `reference/track-8-criteria.md`. The title is what `bun test` prints on failure, so this satisfies `final-6`'s "failure message names the criterion" phrasing. Design-invariant criteria are reviewed via the traceability matrix in `reference/track-8-traceability.md` and the rationale paragraphs in `reference/architecture/runtime-and-deployment.md`, not via runtime tests, because no runtime assertion can prove "we did not build a second orchestration layer."

- [ ] `bun test` passes across the whole repo.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run lint` (oxlint) exits 0.
- [ ] `bun run build` succeeds.
- [ ] `bun build --compile src/cli-main.ts --outfile weft` produces a working binary.
- [x] `weft validate examples/**/*.ts` exits 0 on the bundled examples.
- [ ] Every new primitive from this document has a dedicated test file under `src/**/__tests__/` and every acceptance criterion above is covered by at least one `test(...)` call whose failure message names the criterion.
