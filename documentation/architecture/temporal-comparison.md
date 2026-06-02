# Weft versus Temporal: Ten Design Failures Eliminated

Temporal's replay-based architecture creates a cascade of constraints—determinism, versioning, history limits, sandbox, payload sensitivity—that manifest as developer experience pain. These aren't bugs to fix; they're architectural consequences. Weft's checkpoint-based architecture eliminates the root cause, which means all the downstream constraints dissolve simultaneously.

Here's the mental model comparison for someone writing their first workflow.

| Concept                | Temporal                          | Weft                                    |
| ---------------------- | --------------------------------- | --------------------------------------- |
| Core mental model      | Replay determinism                | Generators pause and resume             |
| Activity invocation    | `proxyActivities()` + type import | `yield* ctx.run('activityName', input)` |
| Timer                  | Deterministic `workflow.sleep()`  | `yield* ctx.sleep("1 hour")`            |
| Signal                 | `setHandler` + `condition`        | `yield* ctx.waitForSignal(name)`        |
| Versioning             | `patched()` / `deprecatePatch()`  | Deploy new code (migration optional)    |
| Long-running workflows | `continueAsNew()`                 | Nothing (checkpoints are fixed-size)    |
| Dev environment        | Docker Compose + Temporal server  | `bun add @lostgradient/weft`            |
| Bundling               | Webpack for workflow sandbox      | None                                    |

Now let's walk through each of the ten design failures in detail.

## The determinism constraint

**The Temporal problem.** Temporal's TypeScript SDK removes `WeakRef` and `FinalizationRegistry` from the sandbox, replaces `Date.now()` and `Math.random()` with deterministic versions, and runs workflows through Webpack bundling that cannot reference Node.js or DOM APIs. You write normal-looking code, it works in tests, and then it explodes with `DeterminismViolationError` in production during replay. The error messages are often inscrutable—"Activity machine does not handle this event."

**The Weft answer.** Checkpoint, don't replay. No determinism requirement at all. Use `Date.now()`, `WeakRef`, `FinalizationRegistry`, `Math.random()`—anything. The only rule is `yield*` for durable operations.

Weft actually _uses_ `WeakRef` and `FinalizationRegistry` internally for memory management. The primitives Temporal bans are the ones Weft depends on.

In development mode, Weft validates checkpoint serialization at each boundary. If you accidentally put a non-cloneable value (a closure, a class instance with methods) into your state, you get an immediate, actionable error.

```
CheckpointSerializationError: Cannot serialize workflow state at step 2

  The value at path "locals.apiClient" is a class instance with methods.
  structuredClone cannot serialize functions or class instances.

  Fix: Move the ApiClient creation inside ctx.run() or store only the
  configuration data (e.g., { baseUrl: "https://api.stripe.com" }) in
  local variables and reconstruct the client when needed.

  at orderWorkflow (./workflows/order.ts:15:3)
```

In Temporal, you discover serialization problems at replay time in production. In Weft, you discover them the moment you run your workflow in development.

## Versioning complexity

**The Temporal problem.** Changing workflow code while workflows are in-flight requires either the `patched()` / `deprecatePatch()` API—which litters your code with version branches that never go away—or Worker Versioning, a whole deployment orchestration system. The Temporal docs themselves acknowledge this is complex enough that they deprecated their first versioning approach and replaced it in 2025.

**The Weft answer.** Checkpointing means code before the current checkpoint never re-executes. Changing steps after the current checkpoint is inherently safe. Versioning only matters for the step you're currently on—and even then, the migration path is a pure data transformation on the checkpoint, not code-path branching.

```typescript pseudocode
// Temporal: version branches that accumulate forever
if (workflow.patched('v2-shipping')) {
  await ship(order, { express: true });
} else {
  await ship(order);
}
// v3? Now you have TWO version branches. v4? Three. They never go away.

// Weft: deploy new code. Old checkpoints migrate automatically.
engine.register(
  workflow({
    name: 'order',
    version: '2.0.0',
    migrate: (checkpoint, fromVersion) => ({
      ...checkpoint,
      shippingOptions: { express: true },
    }),
  }).execute(orderWorkflow),
);
```

Weft's CLI also provides `weft version:check`, which analyzes registered workflows against the existing database and reports compatibility _before_ deployment—telling you exactly how many running workflows need migration and whether your migration function covers them. Installing `@lostgradient/weft` provides both `weft` and `weft-mcp`.

## Steep learning curve

**The Temporal problem.** Multiple sources describe Temporal as having a steep learning curve. The mental model is non-obvious: you write what looks like normal code, but it's actually being replayed from an event history, which means it has invisible constraints. The concepts of "commands vs. events," "workflow tasks," "sticky queues," "continue-as-new," and the 50K event history limit all require significant study. Temporal invested heavily in courses (101 and 102) because self-service onboarding was failing.

**The Weft answer.** The mental model is one concept: generators pause (`yield*`), checkpoints save, recovery resumes. If you know `async function*` and `yield*`, you know Weft. There is no event history to understand, no replay semantics, no command/event distinction.

For developers who don't know generators, a `ctx.step()` sugar API wraps checkpoint boundaries in a familiar async function pattern.

```typescript partial
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

Under the hood, `ctx.step()` compiles to the generator form. Developers who need the full power of generators, parallel branches, signals, and reviews graduate to the `async function*` form. The simple API is a subset of the full API—not a separate abstraction.

## Heavy operational infrastructure

**The Temporal problem.** Running Temporal self-hosted requires Cassandra or PostgreSQL, Elasticsearch for visibility, the Temporal server itself (multiple Go services), and a frontend service. Even for local development, you need Docker Compose or the Temporal CLI dev server. Temporal Cloud describes "several compute clusters, one or more databases, Elasticsearch, ingress, observability stack, and other dependency components" per cloud cell, with eight engineering on-call rotations.

**The Weft answer.** `bun add @lostgradient/weft` for the library, or build a single binary from this repository when you want the source/binary CLI. SQLite is the default database, embedded in the runtime. No external dependencies for development or small production deployments.

```bash
# Temporal
docker compose up -d          # PostgreSQL, Elasticsearch, 4 Temporal services
temporal server start-dev     # ... or the dev shortcut that still needs Docker

# Weft
./weft --port 7233            # SQLite auto-created. REST API at localhost:7233/api/v1/
```

Weft's CLI also includes `weft doctor`, a diagnostic command that reports database health, workflow statistics, queue depths, performance metrics, and actionable recommendations—all without any external monitoring infrastructure.

## Performance out of the box

**The Temporal problem.** The O(n) replay model means workflows with long histories get progressively slower to recover. The Temporal team acknowledges that "almost all performance issues we have encountered are caused by the default settings"—meaning the defaults are wrong for most use cases.

**The Weft answer.** O(1) recovery regardless of history length. In-process SQLite reads at ~10 microseconds instead of network round-trips at ~1 millisecond. Task claiming is a single atomic SQL statement, not a gRPC round-trip. Defaults are optimized for the common case.

The engine tracks checkpoint size automatically and warns you when it exceeds a configurable threshold. For workflows that accumulate large intermediate state, `ctx.offload()` stores large data separately, leaving only a lightweight reference in the checkpoint.

## The Webpack sandbox

**The Temporal problem.** The TypeScript SDK bundles workflow code through Webpack to create a sandboxed environment. This causes: module resolution failures in monorepos, cryptic Webpack errors when importing packages that reference Node APIs, inability to use `console.log` normally, inability to import activity code directly (must use `proxyActivities`), and the general cognitive overhead of writing code that _looks_ like TypeScript but runs in a restricted sandbox.

**The Weft answer.** No bundling, no sandbox, no Webpack. Workflows are regular TypeScript generator functions. Import anything. Use `console.log`. Dispatch activities by their registered name—no proxy object to generate first.

The engine-isolate protection that Temporal achieves through Webpack plus a sandbox, Weft achieves through Web Workers when `workflowExecutionMode: 'worker'` is configured. Workers keep workflow generator turns out of the engine isolate without restricting the JavaScript language.

```typescript pseudocode
// Temporal: 4 lines of ceremony before your first activity call
import type * as activities from './activities';
const { charge, ship } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
});
const result = await charge(order); // "Go to definition" → proxy type, not implementation

// Weft: zero ceremony—reference the activity by its registered name
const result = yield * ctx.run('charge', order); // autocompletes from the registered activities
```

## continueAsNew for long-running workflows

**The Temporal problem.** Temporal has a ~50K event history limit per workflow execution. Long-running workflows—subscription loops, monitoring workflows, order lifecycle management—must periodically call `continueAsNew()` to reset their history. This requires manually serializing all state, re-registering all signal handlers, and reconstructing all local variables. Getting this wrong causes data loss.

**The Weft answer.** Checkpoints are fixed-size snapshots of the current state, not a growing event log. A workflow that has executed 1 million activities has the same checkpoint size as one that has executed 10.

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

There is no `continueAsNew`, no history limit, no manual state serialization. A workflow can run for years without any special handling.

## The proxyActivities indirection

**The Temporal problem.** In the TypeScript SDK, you cannot call activity functions directly. You must create proxy objects via `proxyActivities<T>()` which generate type stubs that know how to schedule activities. This exists because the sandbox cannot import activity code. It creates confusion about what is a real function call versus a scheduled remote operation. "Go to definition" navigates to the proxy type, not the actual implementation.

**The Weft answer.** `yield* ctx.run('activityName', input)`. You name the activity—the same name it was registered under—and pass one serializable input value. There is no proxy object to construct and no generated type stub: the name is the durable dispatch key, what a remote worker receives alongside the serialized input to pick the right activity. When the workflow is typed through its `.activities({ ... })` registry, your editor autocompletes that name and infers the input and result types. The `yield*` makes the durable boundary explicit—no proxies, no codegen, no magic.

Activities can declare their own operational characteristics with a colocated configuration pattern.

```typescript partial
import { activity } from '@lostgradient/weft';

export const charge = activity({
  name: 'charge',
  retry: { maxAttempts: 3, initialBackoff: '1s', multiplier: 2, maxBackoff: '30s' },
  timeout: '30s',
  queue: 'payments',

  async execute(order: Order, context: ActivityContext): Promise<PaymentResult> {
    const result = await stripe.charges.create({
      amount: order.total,
      signal: context.signal,
    });
    return { id: result.id, amount: result.amount };
  },
});

async function* example(ctx: Context) {
  // In the workflow—configuration travels with the activity:
  const payment = yield* ctx.run('charge', order);
  // But you CAN override per-invocation:
  const payment = yield* ctx.run('charge', order, { timeout: '60s' });
}
```

## Payload size sensitivity

**The Temporal problem.** The docs warn extensively about keeping workflow inputs, outputs, and activity results small because everything is serialized into the event history. Large payloads degrade replay performance and bloat storage. This is a tax on the developer experience—you constantly have to think about data size.

**The Weft answer.** Checkpoints store only the current state—the values of local variables at the pause point. Activity inputs aren't stored in the checkpoint. Previous activity results are only stored if they're still live in a local variable.

```typescript partial
async function* imageWorkflow(ctx: Weft.Context, urls: string[]) {
  let summary = { processed: 0, totalSize: 0 };

  for (const url of urls) {
    const result = yield* ctx.run('processImage', url);
    summary = { processed: summary.processed + 1, totalSize: summary.totalSize + result.size };
  }
  // Temporal: history contains 100 x 1MB activity results = ~100MB
  // Weft: checkpoint contains only { summary: { processed: 100, totalSize: ... } } = ~200 bytes
  return summary;
}
```

A workflow that processed 1,000 large API responses but only keeps the final summary in a local variable has a checkpoint containing only that summary. The difference is architectural: replay _must_ store everything that happened; checkpointing stores only what matters right now.

## The common thread

All ten of these problems trace back to the same root cause: replay-based recovery. Temporal replays your workflow code to reconstruct state, which requires determinism, which requires a sandbox, which requires Webpack bundling, which breaks your tooling, which forces proxy indirection, which loses type safety. Each constraint cascades into the next.

Weft's checkpoint-based architecture cuts the chain at the root. No replay means no determinism requirement. No determinism requirement means no sandbox. No sandbox means no Webpack. No Webpack means no proxy indirection. No proxy indirection means activities are dispatched by registered name, with names, inputs, and results inferred from a typed activity registry—no generated stubs to keep in sync. One architectural decision, ten problems eliminated.
