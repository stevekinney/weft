# Checkpoint, Don't Replay

This is the single most important architectural decision in Weft—the one that shapes everything else.

Temporal recovers workflows by _replaying_ them. When a workflow needs to resume after a crash, Temporal re-executes the entire function from the beginning, feeding in recorded results from an event history to fast-forward through completed steps. The more steps a workflow has completed, the longer recovery takes. This is O(n) recovery, and it brings with it a cascade of constraints that touch every part of your development experience.

Weft takes a different path. Instead of replaying side effects, Weft _checkpoints_. At each `yield*` boundary, the engine snapshots the workflow's current state, including local variables and the generator step frontier, and persists it. On crash, Weft loads that checkpoint plus its internal replay cache for completed durable operations, fast-forwards the generator through cached results, and resumes from the last committed boundary. Activities, timers, signals, and other durable operations do not re-execute just because the process restarted.

## How it works

Workflows in Weft are `AsyncGenerator` functions. Each `yield*` is a checkpoint boundary. The engine captures the state at that boundary using a MessagePack codec with structuredClone-compatible semantics—the same serialization algorithm browsers use for `postMessage`.

```typescript partial
export async function* orderWorkflow(ctx: Weft.Context, order: Order) {
  const payment = yield* ctx.run('charge', order); // checkpoint 1
  const shipment = yield* ctx.run('ship', { order, payment }); // checkpoint 2
  return { payment, shipment };
}
```

If the process crashes after checkpoint 1, Weft loads the checkpoint, restores `payment` from the replay cache, and picks up at the `ship` call. The `charge` activity never re-executes. Recovery may read Weft's internal checkpoint-event metadata, but it does not replay external side effects and it does not require deterministic workflow code.

## No determinism requirement

This is where Weft diverges most sharply from Temporal's developer experience.

Temporal's replay model means your workflow code must be _deterministic_. If `Date.now()` returned a different value on replay than it did on the original execution, the replay would diverge and crash with a `DeterminismViolationError`. So Temporal's TypeScript SDK intercepts and replaces `Date.now()`, `Math.random()`, `WeakRef`, `FinalizationRegistry`, and more. It bundles workflow code through Webpack to create a sandboxed environment. You write what looks like normal TypeScript, it works in tests, and then it explodes in production during replay with inscrutable error messages.

Weft doesn't replay. So there's no determinism requirement at all. Use whatever you want:

- `Date.now()`—go ahead, it won't be replayed.
- `Math.random()`—no deterministic replacement needed.
- `WeakRef` and `FinalizationRegistry`—Weft actually _depends_ on these internally for memory management. The primitives Temporal bans are the ones Weft needs.
- Any npm package, any Node API, `console.log`, `debugger` statements—all fine.

The only rule is `yield*` for durable operations. That's it.

## What structuredClone can and cannot serialize

Since checkpoints use a MessagePack codec with structuredClone-compatible semantics, there are boundaries on what can live in your workflow's local variables at a `yield*` point.

**Can serialize:** primitives, plain objects, arrays, `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer`, `TypedArray`.

**Cannot serialize:** functions, closures, class instances with methods, Symbols, `WeakMap`, `WeakRef`, or system resources (sockets, file handles).

The practical implication: keep your local variables as plain data at yield boundaries. If you need an API client, store the configuration (a URL string, an API key) and reconstruct the client after resumption—don't try to checkpoint the client object itself.

## Development mode catches mistakes early

The most common bug Weft developers will hit is accidentally putting a non-cloneable value into their checkpoint state. In Temporal, you discover this at replay time in production. In Weft, development mode catches it immediately.

```typescript partial
const engine = new Engine({
  storage: new MemoryStorage(),
  development: true,
});
```

When `development` is `true`, the engine serializes and deserializes the checkpoint at each boundary and compares the result. If they diverge, it emits a `DevelopmentWarningEvent`; client code receives the event's `message` and `fieldPaths`.

```typescript
import { DevelopmentWarningEvent, Engine, MemoryStorage } from '@lostgradient/weft';

const engine = new Engine({
  storage: new MemoryStorage(),
  development: true,
});

engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
  const warning = event as DevelopmentWarningEvent;
  console.warn(warning.message);
  console.warn(warning.fieldPaths);
});
```

An emitted warning looks like ordinary event data, not a thrown serialization error:

```text
event.type: "development:warning"
message: "Checkpoint at step 2 has 1 non-serializable field(s)"
fieldPaths: ["locals.apiClient"]
```

That warning tells you _what_ went wrong and _where_ it happened. You see it the moment you run your workflow in development, not three weeks later when a production node restarts.

## Bounded checkpoints, no continueAsNew

Temporal's event history grows linearly with every activity, timer, and signal. At roughly 50,000 events, you must call `continueAsNew()`—which restarts the workflow, destroying all local variable state and requiring manual serialization of everything you want to carry forward. Signal handlers must be re-registered. Child workflow references must be re-established. This isn't an edge case; any workflow that loops (subscriptions, monitoring, batch processing) hits this limit.

Weft's canonical checkpoint is a snapshot of the current workflow state. It stores current locals plus replay entries at or ahead of the pending step; consumed operation results move into checkpoint-event replay metadata so they are not copied into every later checkpoint. When workflow locals stay bounded, the serialized checkpoint stays bounded as the number of completed durable operations grows.

```
Temporal: history size grows linearly with activity count
  10 activities  →  ~1K events  →  ~100KB history
  1K activities  →  ~10K events →  ~1MB history
  50K activities →  ~50K events →  LIMIT HIT, must continueAsNew

Weft: checkpoint size follows current locals, not completed step count
  10 activities  →  bounded checkpoint when locals are bounded
  1K activities  →  bounded checkpoint when locals are bounded
  1M activities  →  bounded checkpoint when locals are bounded
```

A workflow can run for years and execute millions of activities without copying every completed result into every checkpoint. There is no `continueAsNew` requirement for checkpoint size. If your own workflow locals grow, the checkpoint grows with them; use `ctx.offload()`, `ctx.archive()`, or storage-backed state for large data that should not live in the checkpoint.

## Payload efficiency

Temporal stores every activity input and output in the event history. If your workflow calls 100 activities that each return 10KB of data, the history contains 1MB of payload data—even if the workflow only uses the final result. Large payloads bloat history, slow down replay, and accelerate hitting the 50K event limit.

Weft checkpoints store only the current state: the values of local variables at the yield point plus any still-pending replay entry. Completed operation results needed to fast-forward recovery are recorded once in checkpoint-event replay metadata instead of being copied into every later checkpoint. Previous activity results are present in checkpoint locals only if your workflow keeps them in scope. A workflow that processed 100 large API responses but only keeps a summary has a checkpoint containing that summary, not all 100 responses.

The difference is architectural, not incremental. Replay _must_ store everything that happened. Checkpointing stores only what matters _right now_.

## Consequence: workflows are TypeScript-only

The checkpoint model leans on two language features working together: an async-iterable suspension primitive (`AsyncGenerator` + `yield*`) that gives the engine a clean re-entry point at every checkpoint boundary, and a serialization story (`structuredClone` semantics, via MessagePack) that lets the engine durably persist the workflow's locals at that boundary. JavaScript has both in its standard library. Most other mainstream languages have only one or neither: Python `async def` has no `yield*`-shaped typed return-value plumbing and no public way to round-trip arbitrary live values; Go goroutines and Java continuations don't expose suspension state as a serializable artifact at all.

That means **workflows in Weft are TypeScript-only by design**. Activities — the side-effecting work — can run in any language via the [`RemoteWorker` wire protocol](../reference/remote-worker-protocol.md), but the workflow orchestration code itself is TypeScript.

This isn't an oversight or a roadmap item. It's the load-bearing consequence of choosing checkpoint-not-replay. A polyglot workflow runtime would either (a) abandon the checkpoint model and re-introduce replay, which is the thing we left behind, or (b) build a separate state-machine-on-messages model per language, which collapses back to replay with extra steps. Temporal does (a) well. If you need workflows in multiple languages, Temporal is the right answer.

The full design rationale and the alternatives we considered live in [ADR 0001 — Workflows Are TypeScript-Only by Design](../contributing/architecture-decisions/0001-workflows-typescript-only.md).
