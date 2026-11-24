# Weft

A Bun-native durable execution engine. The current release is whatever `npm view @lostgradient/weft version` reports; the package's exported `VERSION` and its manifest always agree.

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
- **Single binary, every OS.** From a source checkout, `bun run build:binary` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. Build the macOS targets on a Mac so the outputs are signed and verified; Linux and Windows targets can be cross-compiled. Five binaries, zero runtime dependencies.
- **Runs in the browser.** The core engine (minus the server shell) runs in Web Workers with a Service Worker as its persistence backbone. Same workflow code, different environment.
- **Human-in-the-loop.** Workflows can pause at any checkpoint and surface a decision to a human reviewer via `ctx.review()`. The workflow resumes with the reviewer's decision—approved or rejected—without any special infrastructure.

> [!IMPORTANT] Workflows run in TypeScript on the engine; activities can run in any language via the `RemoteWorker` protocol. This split is intentional — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only by design. See [ADR 0001](documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md) for the design rationale.

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

```typescript file=hello-world.ts
import { Engine, workflow } from '@lostgradient/weft';
import { BunSQLiteStorage } from '@lostgradient/weft/storage/bun-sqlite';

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

export const engine = await Engine.create({
  storage: new BunSQLiteStorage('./weft.db'),
  workflows: { welcome },
});

const handle = await engine.start('welcome', { name: 'Steve' });
const result = await handle.result();
// result is { greeting: "Hello, Steve!", onboarded: true }
```

That's the core loop: `workflow({ name })` is a **chained builder** that co-locates the workflow's side-effecting steps inside `.activities({...})`, and `.execute(fn)` seals it all together and returns a `WorkflowDefinition`. Inside the generator, `ctx.run('formatGreeting', input)` autocompletes from the workflow's own activity table, typechecks the input, and infers the output. Every `yield*` is a checkpoint boundary; `handle.result()` waits for the output. Checkpoints are written to `./weft.db`, so running workflows survive process crashes.

`Engine.create()` does the registration dance for you: it constructs the engine and registers each workflow in the `workflows` map, pulling in all the activities each workflow declares. It then **recovers by default** — `engine.recoverAll()` runs after registration, so any workflows still running from a previous process pick up where they left off. That's the point of durable storage, so you don't have to ask for it. Pass `recover: false` to opt out (handy for tests, for `ScopedStorage`-isolated engines, or when you want to inspect a store before migrating it). Durability is separate: each step is persisted before it commits no matter what `recover` is set to — `recover` only decides whether _this_ engine resumes that persisted work on boot. If a host owns recovery but still needs durable timers, use `startScheduler: true`; otherwise `recover: false` also leaves the real-time scheduler stopped. By default (`ownership: 'none'`) run a single engine per durable store: pointing two at the same store is uncoordinated and can double-resume a workflow. To share one store across engines, select `ownership: 'workflow-lease'`, which claims each workflow for exactly one engine before its generator runs.

Passing an explicitly empty workflow map is the same default-registry boot shape as omitting `workflows`: `Engine.create({ workflows: {} })` recovers after registration and returns an engine whose TypeScript type is compatible with default-registry consumers such as `serve({ engine })`. Use a non-empty `workflows` map when you want TypeScript to narrow `engine.start(...)` to the registered names.

Serverless hosts that cannot keep process-local intervals alive can set `backgroundTasks: 'manual'` and call `await engine.runMaintenance()` from an alarm or Cron wake-up to drive timers, scheduled starts, update-response cleanup, retention, and alert evaluation. Await each maintenance cycle before starting another one so host-driven ticks do not overlap.

Schemas are optional metadata by default, and a definition without one leaves that field empty in the contract, the registry, `weft codegen` output, and MCP tools. Pass `schemas: 'required'` to `new Engine()` or `Engine.create()` to make them mandatory: registering a workflow, finalizer, signal, update, query, or activity that leaves an input or output schema undeclared throws `DefinitionSchemaRequiredError`, which lists every missing schema. A message or activity without a payload declares a schema that accepts `undefined`, such as `z.undefined()`. The option checks declarations only; it does not validate payloads at runtime.

To run those schemas at runtime, pass `payloadValidation: 'inbound'`. The engine then validates a workflow's start input, each declared signal's payload, and each declared update's and query's input before it accepts them, and rejects a failing payload with `StandardSchemaValidationError` (an `InvalidParams` fault over the server) without writing anything. It validates but never transforms: the workflow receives the value the caller sent. Outputs and activity payloads are not validated.

If you'd rather wire things up by hand — useful for tests, isolating engines onto separate storage scopes via `ScopedStorage`, or adding new workflows after the engine starts up — `new Engine({ storage })`, `engine.register(workflow)` or `engine.registerWorkflows({ ... })`, and `await engine.recoverAll()` are the underlying primitives. Each `engine.register(workflow)` call returns the engine with that workflow's name and types baked in, so `engine.start('welcome', ...)` autocompletes immediately.

When a workflow needs a live host capability that cannot be checkpointed, pass it as per-run `services`:

```typescript
import { engine } from './hello-world.ts';

declare const crmClient: { lookup(email: string): Promise<{ accountId: string }> };

const handle = await engine.start('welcome', { name: 'Steve' }, { services: { crmClient } });
```

Inside inline workflows, read that value from `ctx.services` and narrow it to your application type. Weft never writes the service object into checkpoints; it persists only a presence marker so `Engine.create({ resolveWorkflowServices })` can rebuild the service value during fresh-process recovery before the generator advances. Scheduled runs also carry `schedule.id` and, when the grid timestamp is retained, `schedule.occurrence` into the resolver across recovery, so host services can branch on schedule origin without duplicating that identity in workflow input. Do not use `services` for durable data, and do not pass it in Worker execution mode — non-serializable values cannot cross to a Worker.

When recovery also needs to rebuild live host surfaces such as progress emitters or adapters, opt out of automatic recovery first with `Engine.create({ recover: false, ... })`, then call `await engine.recoverAll({ onRecoveredWorkflow })` after any host surfaces are ready. Weft awaits the hook after services are re-provided and before the recovered generator advances, and a hook failure fails only that recovered run with a system failure category.

> [!NOTE] The chained builder also accepts `.uses({...})`, `.signals({...})`, `.updates({...})`, `.queries({...})`, and `.searchAttributes({...})`. Each can be called at most once before `.execute(fn)`; the type system flips a phantom flag so a duplicate call fails to typecheck, and the runtime mirrors the same invariant. These maps thread into `ctx.run()`, `ctx.waitForSignal()`, `ctx.waitForUpdate()`, and friends so your editor autocompletes and your code typechecks, and they put the workflow's full surface in its contract and the registry. `.uses({ greet })` declares an activity the engine provides (registered with `Engine.create({ activities })` or `engine.register(activity)`): dispatch still runs the engine's implementation, the workflow's contract lists it under `usedActivities`, and the registry snapshot names the workflow in that activity's `usedBy`. Declaring signals, updates, or queries closes that set: a message of that kind under any other name is rejected with `UndeclaredWorkflowMessageError` before it is buffered or dispatched. A workflow that declares none of a kind accepts any name of that kind.

When several workflows use the same activities or messages, declare them once with `createWorkflowFactory` and build the workflows from the `workflow` it returns. Every workflow it builds gets typed `ctx.run()`, `ctx.waitForSignal()`, `ctx.waitForUpdate()`, and `ctx.onQuery()` for the shared entries. Shared activities are declared on each workflow as if by `.uses({...})`, so they are engine-provided: create the engine with the factory's `createEngine`, which registers the workflows and the shared activities in one call.

```typescript
import { activity, createWorkflowFactory, signal } from '@lostgradient/weft';

const formatGreeting = activity({
  name: 'formatGreeting',
  execute: async (name: string) => `Hello, ${name}!`,
});

const { workflow, createEngine } = createWorkflowFactory({
  activities: { formatGreeting },
  signals: { approve: signal<{ approverId: string }>('approve') },
});

const welcome = workflow({ name: 'welcome' })
  .activities({ shout: async (text: string) => text.toUpperCase() })
  .execute(async function* (ctx, name: string) {
    const greeting = yield* ctx.run('formatGreeting', name);
    const { approverId } = yield* ctx.waitForSignal('approve');
    return { greeting: yield* ctx.run('shout', greeting), approverId };
  });

const farewell = workflow({ name: 'farewell' }).execute(async function* (ctx, name: string) {
  return yield* ctx.run('formatGreeting', name);
});

const engine = await createEngine({ workflows: { welcome, farewell } });
```

- A workflow can add its own entries with `.activities({...})` for workflow-scoped activities, `.uses({...})` for more engine-provided ones (pass those to `createEngine` as `activities`), and `.signals({...})`, `.updates({...})`, and `.queries({...})`. They merge with the shared ones.
- A name the factory already declares cannot be declared again, in any of those methods. That is a type error and a `WorkflowBuilderError` at runtime, so a shared name means the same thing in every workflow. The same holds for any builder: a name declared with `.uses()` cannot also be scoped with `.activities()`.
- Declared signals, updates, and queries are closed sets, so the factory's declarations close each set for every workflow it builds: a message under a name that neither the factory nor the workflow declares is rejected with `UndeclaredWorkflowMessageError`.
- `createEngine` accepts everything `Engine.create` does. Before it creates the engine, it checks that every activity any of its workflows declares with `.uses()` is provided, and throws `ActivityResolutionError` if one is not. An engine created another way, such as `Engine.create({ workflows })` without the shared activities, fails each run that reaches a missing activity with `No activity registered with name …`. If you create the engine yourself, pass `activities: factory.activities`.

> [!NOTE] `MemoryStorage` (also exported from `@lostgradient/weft`) is fine for tests and ephemeral scripts, but it lives in process memory—a crash takes the checkpoints with it. Use a persistent backend like `BunSQLiteStorage` whenever durability actually matters.

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

```typescript file=checkout.ts
import { workflow } from '@lostgradient/weft';

export type Order = {
  payment: { token: string; amount: number };
  items: string[];
  email: string;
  address: string;
};

// Your activities: plain async functions with typed inputs and outputs.
declare const chargeCard: (input: { payment: Order['payment'] }) => Promise<{ receiptId: string }>;
declare const reserveInventory: (input: { items: string[] }) => Promise<void>;
declare const sendConfirmation: (input: {
  email: string;
  receiptId: string;
}) => Promise<{ messageId: string }>;
declare const scheduleShipping: (input: { address: string }) => Promise<{ trackingNumber: string }>;

export const checkout = workflow({ name: 'checkout' })
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

```typescript file=approval.ts
import { Engine, signal, workflow } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

declare const ship: (input: { orderId: string }) => Promise<void>;

export const approvalSignal = signal<{ approved: boolean }>('approval');

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

export const engine = await Engine.create({
  storage: new MemoryStorage(),
  workflows: { approval },
});

// From an HTTP handler, another workflow, or anywhere with engine access:
const handle = await engine.start('approval', { orderId: 'order-123' });
await engine.signal(handle.id, approvalSignal, { approved: true });
```

For state that changes through synchronous updates, use `ctx.waitUntil(predicate, timeout?)` as a durable condition gate. It re-checks a pure predicate when `ctx.onUpdate()` handlers mutate workflow-local state, or when the optional timeout fires. It is inline-only because the predicate closure stays in the engine process; signals do not re-drive it because signals are pull-based messages consumed by `ctx.waitForSignal()`.

```typescript
import { update, workflow } from '@lostgradient/weft';

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
import type { HttpClient } from '@lostgradient/weft';
import type { Order } from './checkout.ts';

declare const client: HttpClient;
declare const order: Order;

const handle = await client.start('checkout', order);
const tail = handle.tail();

await tail.whenConnected();

for await (const event of tail) {
  console.log(event.type);
}
```

The tail is single-consumer and stops on terminal workflow events or `tail.close()`. Pass `eventTransport: 'websocket'` to require WebSocket, `eventTransport: 'sse'` to require SSE, or `HttpClientOptions.webSocketFactory` to provide a runtime-specific WebSocket constructor. The client assumes the global `WebSocket` cannot send upgrade headers, so with headers or a token configured `eventTransport: 'auto'` uses SSE; set `webSocketCarriesHeaders: true` when your runtime's `WebSocket` accepts an options bag with headers (Bun does) to keep the WebSocket channel.

### Idempotent Starts and Signal-With-Start

Retried webhooks and queue deliveries should not double-start workflows. Pass a stable `idempotencyKey` to `engine.start()` to make every retry return a handle for the same run. Use `engine.startOrSignal()` when the first event should create the workflow and later events should signal the existing non-terminal run. The call returns `{ handle, outcome }`, where `outcome` is `'started'` for the caller that created the run and `'signalled'` for callers that delivered to, or converged onto, an existing run.

```typescript
import { engine } from './approval.ts';

const { handle, outcome } = await engine.startOrSignal(
  'approval',
  { orderId: 'order-123' },
  { name: 'approval', payload: { approved: true } },
  { idempotencyKey: 'approval-webhook-order-123' },
);

console.log(handle.id, outcome); // outcome is 'started' or 'signalled'
```

The idempotency mapping intentionally outlives terminal cleanup. If retention removes the workflow record, the key is spent and future calls return a conflict instead of starting a replacement.

For stable-id re-sync flows, `engine.startOrSignal()` can replace a terminal prior run with `{ id, onTerminalConflict: 'start-new' }` when the initial signal also carries a deterministic `signalId`. Non-terminal runs are still signalled, not replaced, and restart-capable calls reject `idempotencyKey` because idempotency keys are permanent at-most-once mappings. Signal identifiers are treated as opaque user identifiers before storage-key construction, so caller-provided values that contain separator-looking text such as `anonymous:` stay explicit signal IDs instead of colliding with Weft's generated anonymous-signal sequence.

When a workflow drains signals with `ctx.race([ctx.waitForSignal(name), ctx.sleep(0)])` and then returns, use that stable `id`, a deterministic per-event `signalId`, and `onTerminalConflict: 'start-new'` for the corresponding `startOrSignal` calls. Delivery is serialized against terminal completion, so a signal arriving across the completion boundary is consumed by the current run or handed to its successor; a positive drain window is not needed for correctness.

### Durable Application Command Mailbox

Signals are workflow control. When the thing receiving a command is an application _resource_ rather than a workflow run — an agent taking steering input, a resource fielding requests from a peer service — `Mailbox` gives it a durable, strictly FIFO command queue with real receipts.

```typescript
import { Mailbox } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

await using storage = new MemoryStorage();
using mailbox = new Mailbox({ storage, namespace: 'bureau', resourceId: 'agent-7' });

const admission = await mailbox.admit({
  caller: 'user:42',
  target: 'agent:7',
  kind: 'steer',
  payload: { form: 'inline', value: { text: 'stop and summarize' } },
  idempotencyKey: 'steer-1',
});

const claimed = await mailbox.claim();
if (claimed.status === 'claimed' && admission.status === 'admitted') {
  await mailbox.acknowledge({
    commandId: claimed.claim.receipt.commandId,
    attemptToken: claimed.claim.attemptToken,
    outcome: { applied: true },
  });
}
```

Admission returns a receipt that, on a persistent backend such as `BunSQLiteStorage`, survives process restart; `MemoryStorage` above keeps the example self-contained and is gone with the process. Idempotency binds to `(caller, target, kind, payloadDigest)`, so an exact retry returns the original receipt and a conflicting reuse of the key returns a stable conflict without touching the original. Claims are attempt-fenced, so two consumers sharing one durable store can never both hold a valid claim _on the same command_ — delivery is strictly FIFO, but a later command may be claimed while an earlier one is still in flight, so completion order is up to the consumers. Cancellation is durable before it reaches anyone, and reports honestly whether cleanup is still outstanding rather than claiming an uncooperative handler stopped.

Delivery intent, ordering, ownership, and disposition are durable; external side effects are not made exactly-once. See [Application Mailbox](documentation/guides/mailbox.md).

### Durable Application Delivery Outbox

The mailbox is for commands coming _in_ to a resource. For work going _out_ — a webhook, a notification, a message to a peer service — `Outbox` is the matching primitive: a durable, at-least-once delivery queue whose enqueue, attempt leases, transport outcomes, retry schedule, cancellation, and dead-letter state are all durable and observable, without ever confusing a transport write with an acknowledgement.

```typescript
import { Outbox } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

await using storage = new MemoryStorage();
using outbox = new Outbox({
  storage,
  namespace: 'bureau',
  ownerId: 'agent-7',
  adapter: {
    async send(request) {
      // Put the request on the wire. Present request.delivery.externalIdempotencyKey
      // as the remote idempotency key when the delivery carries one; the attempt
      // token changes per attempt and is only a request id or fence.
      void request;
      return { status: 'acknowledged', evidence: { messageId: 'm-1' } };
    },
  },
});

await outbox.enqueue({
  destinationRef: 'webhook:orders',
  kind: 'order.shipped',
  payload: { form: 'inline', value: { orderId: 42 } },
  idempotencyKey: 'order-42-shipped',
});

const delivered = await outbox.deliverNext();
if (delivered.status === 'settled') console.log(delivered.receipt.state); // 'acknowledged'
```

Every attempt is durably marked `attempting` _before_ the adapter is called, so a crash before the send is a safe retry and a crash after it is an unknown outcome — which is parked or dead-lettered by explicit policy, and retried automatically only when the delivery carries stable external idempotency evidence. Returning from `send()` never settles anything by itself; the outbox commits the matching disposition, fenced on the attempt. See [Application Outbox](documentation/guides/outbox.md).

### Search Attributes

Attach indexed metadata to a workflow at runtime, then list and filter on it.

```typescript
import { Engine, workflow } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

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

await using engine = await Engine.create({ storage: new MemoryStorage(), workflows: { order } });

const orders = await engine.list({
  attributes: [
    { key: 'customerId', value: 'acme' },
    { key: 'status', value: 'shipped' },
  ],
});
```

Workflow visibility extends the same list surface with operator filters for `idPrefix`, failure categories, created/updated/deadline ranges, and status arrays. Use `engine.aggregate()` or `GET /api/v1/workflows/aggregate` for grouped counts by status, type, failure category, or a search attribute. The engine writes the visibility indexes only after the [workflow visibility backfill](documentation/guides/workflow-visibility-backfill.md) has run against a Bun SQLite database, so run it once to get the indexed fast path; until then filtered `list` and `aggregate` calls scan every workflow.

Failure-category filters use the current execution taxonomy only: `application`, `timeout`, `cancellation`, `resource`, and `system`. Older category names from pre-1.0 experiments are dropped during decode and are not expanded in list or aggregate filters.

### Human-in-the-Loop Review

Weft can pause a workflow at any checkpoint and surface a decision payload to a human reviewer. The workflow resumes with the reviewer's decision—no polling, no special infrastructure.

As of June 12, 2026, [Temporal's public human-approval example](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python) models approval with Signals, and [Inngest's TypeScript docs](https://www.inngest.com/docs/reference/typescript/v4/functions/step-wait-for-event) model approval waits with `step.waitForEvent()`. Weft makes the review itself a durable workflow operation: [`ctx.review()`](src/core/context/durable-operations.ts) creates a stored review request, exposes review list/get/decision APIs, emits review events, and resumes the workflow with the submitted decision.

```typescript
import { Engine, workflow } from '@lostgradient/weft';
import { BunSQLiteStorage } from '@lostgradient/weft/storage/bun-sqlite';

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

A small `Storage` interface over string keys and `Uint8Array` values: five required methods (`get`, `put`, `delete`, `scan`, `batch`) plus optional capabilities (`conditionalBatch`, `has`, `deletePrefix`) that adapters can implement when their backend supports them. This package provides three adapters:

- `MemoryStorage` from `@lostgradient/weft/storage` for development and tests
- `BunSQLiteStorage` from `@lostgradient/weft/storage/bun-sqlite` for SQLite persistence under Bun
- `IndexedDBStorage` from `@lostgradient/weft/storage/indexeddb` for browser and Service Worker persistence

Pass the adapter to `Engine.create({ storage })`. You can also implement the exported `Storage` interface for another backend. Production recovery needs a durable store and an ownership topology appropriate to the backend. See the [singleton service deployment guide](documentation/guides/singleton-service-deployment.md) for the single-engine configuration.

For long-running workflows, `history.retentionWindow` can compact old event-log records behind the latest checkpoint while preserving verification through a durable watermark. `history.maxEvents` remains a lifetime circuit breaker even after compaction. Use `payloadSize.maxBytes` when operators need an admission-time cap on workflow inputs, signal payloads, and activity results before those values reach storage.

### Server Mode

`serve()` wraps `Bun.serve()` to expose your engine over HTTP and WebSocket with a versioned REST API.

```typescript
import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft';
import { BunSQLiteStorage } from '@lostgradient/weft/storage/bun-sqlite';
import { checkout } from './checkout.ts';

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });
engine.register(checkout);

await using server = serve({ engine, port: 7233 });
// server.url is e.g. "http://0.0.0.0:7233"
```

Endpoints under `/api/v1/` cover the full lifecycle: start workflows, list, signal, update, query, cancel, fork, and stream events. JSON-RPC over WebSocket also exposes workflow and fleet event subscriptions for operator UIs that need live state without polling. Content negotiation supports JSON and MessagePack. `engine.workflows` and the matching `/v1/registry/` operations expose the durable workflow catalog for admin tooling — install a revision's manifest and activate it as the advertised active revision — bookkeeping only, never workflow execution routing; see [`workflow-versioning.md`](documentation/guides/workflow-versioning.md#engineworkflows-public-catalog-control). `workflowSource()` pairs a typed, serializable source descriptor with a never-serialized loader capability, so one workflow can register lazily while another stays eagerly registered; `engine.registerSource()` records the candidate without importing it, and `engine.resolveWorkflowSource()` (or its `engine.workflows.preload()` alias) loads, validates, and installs it into the same catalog with single-flight deduplication per `(name, revision)`. Every execution entry point — `start()`, `startOrSignal()`, `schedule()`, `fork()`, `resume()`, and recovery — awaits resolution for a lazy type before running any handler code, with bounded diagnostics and process-local events for the load pipeline; see [Engine Integration](documentation/guides/workflow-versioning.md#engine-integration-wft-1516).

Workflow and fleet event feeds resume from an opaque `Cursor` string. Treat a cursor as a token: pass back exactly what an envelope's `cursor` field gave you, and never build or compare one by hand. When a consumer needs the underlying sequence position (for example to compare against a retention floor), use the codec exported from `@lostgradient/backchannel`:

- `encodeCursor(sequence: number): Cursor` encodes a non-negative integer sequence and throws on a negative or non-integer input.
- `decodeCursor(cursor: Cursor): number | null` returns the sequence, `-1` for the initial "before the first event" sentinel, or `null` when the cursor is malformed or outside the safe-integer range.

```typescript
import { decodeCursor, encodeCursor } from '@lostgradient/backchannel';

decodeCursor(encodeCursor(42)); // 42
decodeCursor('-1'); // -1 (start of the feed)
decodeCursor('garbage'); // null
```

### Authentication and Scopes

`serve({ auth })` accepts API keys, JWTs, and mutual TLS. Every operation except `weft.system.principal` requires an authorization scope, and the scope a caller holds comes from its credential: a JWT's `scope`, `scp`, and `permissions` claims, the `defaultApiKeyScopes` you give static API keys, or the principal your `resolveApiKeyPrincipal` returns.

```typescript
import { Engine } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { serve } from '@lostgradient/weft';

await using engine = new Engine({ storage: new MemoryStorage() });
await using server = serve({
  engine,
  port: 7233,
  auth: {
    apiKeys: [process.env['OPERATOR_API_KEY'] ?? ''],
    // Every static key holds these. Required: a key with no scope is refused everywhere.
    defaultApiKeyScopes: ['workflows:read', 'workflows:write', 'signals:write'],
  },
});
```

`serve()` throws before it binds a port when `auth.apiKeys` is non-empty and neither a `defaultApiKeyScopes` holding at least one recognized scope nor a `resolveApiKeyPrincipal` resolver is configured; the error names both options. Only `serve()` refuses an unscoped key, because Weft's own catalog is what makes it useless: `validateAuthConfig()`, `createAuthenticator()`, and `createOperationHandlerAuthenticator()` accept it, since the catalog they serve may hold operations that need only an authenticated caller. A client reads its own method, subject, and scopes from `weft.system.principal` (`GET /v1/principal`), the one operation that is public, so it needs no scope. On a server configured with `auth` the transport still authenticates first: a request with no valid credential gets a `401` before it reaches any operation, `weft.system.principal` included. The operation is public in the scope sense (any admitted credential may call it), not in the unauthenticated sense.

A `serve()` with no `auth` identifies nobody. With `unauthenticatedAccess` set to `'warn'` (the default) or `'allow'`, every request runs as one local principal, `method: 'unauthenticated-local'` and `subject: 'unauthenticated-local'`, which holds every scope in `AUTHORIZATION_SCOPES`, so every built-in operation is reachable by anyone who can reach the port. An operation registered through `serve({ operations, additionalScopes })` that needs a package scope is not: the local principal holds no package scope, so such an operation needs a credential that holds it. Set `unauthenticatedAccess: 'reject'`, or `WEFT_SERVER_AUTHENTICATION_REQUIRED=1`, and the server refuses to start without `auth`. A bare `handleRequest()` call made without an `authContext` is anonymous and reaches only `weft.system.principal`; that is the rule for an embedded host, which attaches its own context. A Service Worker is different: `setupServiceWorker()` and `createFetchHandler()` both run requests as the same local principal when `handlerOptions.authContext` is `undefined`, because a same-origin Service Worker has one caller. Pass an `authContext` to replace that default, or opt out of local trust with `handlerOptions: { authContext: { method: 'public' } }`, which makes the caller anonymous. Both listeners also decline every navigation request, so a page on another origin cannot navigate to, or submit a form at, the worker's path prefix and have it answered with local trust. A host with one caller of its own can attach the same context with `unauthenticatedLocalAuthContext(WEFT_SCOPE_VOCABULARY)`. Backchannel provides the context factory and Weft exports the vocabulary.

The scope each operation requires:

| Operations                                                                                                                                                                                                                                                                                                                                                                                        | Required scope                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `weft.workflows.get`, `weft.workflows.list`, `weft.workflows.aggregate`, `weft.workflows.timeline.get`, `weft.workflows.compare`, `weft.workflows.result.get`, `weft.workflows.checkpoints.get`, `weft.workflows.checkpoints.list`, `weft.workflows.scheduleprovenance.get`, `weft.workflows.finalizer.get`, `weft.updates.result.get`, `weft.workflows.updates.list`, `weft.workflows.logs.list` | `workflows:read`                                                                                   |
| `weft.workflows.start`, `weft.workflows.fork`, `weft.workflows.cancel`, `weft.workflows.suspend`, `weft.workflows.resume`, `weft.workflows.timeout`                                                                                                                                                                                                                                               | `workflows:write`                                                                                  |
| `weft.workflows.signal`                                                                                                                                                                                                                                                                                                                                                                           | `signals:write`                                                                                    |
| `weft.workflows.startorsignal`                                                                                                                                                                                                                                                                                                                                                                    | `workflows:write` and `signals:write` (both)                                                       |
| `weft.workflows.tags.add`, `weft.workflows.tags.remove`                                                                                                                                                                                                                                                                                                                                           | `tags:write`                                                                                       |
| `weft.workflows.purge`, `weft.recover.all`                                                                                                                                                                                                                                                                                                                                                        | `workflows:admin`                                                                                  |
| `weft.workflows.update`                                                                                                                                                                                                                                                                                                                                                                           | `updates:write`                                                                                    |
| `weft.workflows.query`                                                                                                                                                                                                                                                                                                                                                                            | `queries:read`                                                                                     |
| `weft.workflows.events.list`                                                                                                                                                                                                                                                                                                                                                                      | `events:read`                                                                                      |
| `weft.workflows.events` (WebSocket subscription), `weft.workflows.events.sse`                                                                                                                                                                                                                                                                                                                     | an authenticated caller, then by selector: `events:read` for `events`, `streams:read` for `tokens` |
| `weft.schedules.list`, `weft.schedules.get`, `weft.schedules.missed`                                                                                                                                                                                                                                                                                                                              | `schedules:read`                                                                                   |
| `weft.workflows.attributes.get`, `weft.workflows.attributes.set`                                                                                                                                                                                                                                                                                                                                  | `attributes:read`, `attributes:write`                                                              |
| `weft.workflows.streams.chunks`, `weft.workflows.streams.sse`                                                                                                                                                                                                                                                                                                                                     | `streams:read`                                                                                     |
| `weft.schedules.create`, `weft.schedules.update`, `weft.schedules.pause`, `weft.schedules.resume`, `weft.schedules.skipnext`, `weft.schedules.unskip`, `weft.schedules.runnow`, `weft.schedules.cancel`                                                                                                                                                                                           | `schedules:write`                                                                                  |
| `weft.reviews.list`, `weft.reviews.get`, `weft.reviews.decision.submit`                                                                                                                                                                                                                                                                                                                           | `reviews:read`, `reviews:write`                                                                    |
| `weft.retention.get`                                                                                                                                                                                                                                                                                                                                                                              | `system:read`                                                                                      |
| `weft.workflows.definitions.list`, `weft.workflows.definitions.get`                                                                                                                                                                                                                                                                                                                               | `system:read` or `workflows:read` (either one)                                                     |
| `weft.system.principal`                                                                                                                                                                                                                                                                                                                                                                           | none (public)                                                                                      |

Mutual TLS currently admits a principal that holds no scopes, so an mTLS caller reaches only `weft.system.principal`: every other operation in this table requires a scope, and the two workflow event feeds refuse a caller that holds neither `events:read` nor `streams:read`. Scopes are flat: `workflows:admin` does not imply `workflows:read`. Operations outside this table, such as the registry, storage, worker, and diagnostic operations, declare their own scopes through the same mechanism.

`serve({ authorizeWorkflowRead })` narrows `weft.workflows.compare` beyond its scope. The hook receives `{ principal, workflowId }` and returns `true` to allow or `false` to deny; `compare` asks it for the fork and then for the fork's source, after the `workflows:read` check, and answers `NotFound` when either is denied. The fault names only the fork and reads exactly like a missing fork, so a caller cleared for a fork learns nothing about its source, and a denied caller is not told a run is not a fork. With no hook configured the scope alone decides. A hook that throws is an internal error, never a denial.

### MCP Over HTTP

`/mcp` serves the Model Context Protocol through the official MCP SDK (`@modelcontextprotocol/server`), and it authenticates exactly as the rest of the server does. A client that negotiates protocol 2026-07-28 is served on the SDK's modern lane, where every request carries its own protocol envelope. A 2025-era client that opens with `initialize` is served on the SDK's stateless legacy lane, in `2025-11-25` or the older revision it asked for when the SDK still supports it. Both lanes answer one POST at a time from the same server factory, so they list the same tools and resources.

Neither lane keeps a session. There is no `Mcp-Session-Id`, and `GET` and `DELETE` on `/mcp` answer `405`. Every request is authenticated on its own credential, so a caller can never continue another caller's exchange. Two consequences follow for 2025-era clients over HTTP: they cannot subscribe to resource updates, and a `notifications/cancelled` cannot reach a call that another request is running. A 2026-07-28 client subscribes through `subscriptions/listen`, and cancels a call by closing its request, which cancels the workflow the tool started. Over stdio (`weft-mcp`), the SDK pins one server instance for the connection, so a 2025-era stdio client subscribes with `resources/subscribe` and cancels with `notifications/cancelled`.

#### MCP for an operation catalog

Catalog hosts can serve their own operations and resources over HTTP with the [Backchannel MCP adapter](../backchannel-mcp/README.md).

### Extra Routes

`serve()` accepts `routes`, Bun's own route table, for anything else the same origin should serve. Bun matches those routes before Weft's API, so `serve()` throws before binding the port when a route would shadow one of Weft's endpoints: `/api` or `/v1` or anything under them, the root `/mcp` and `/jsonrpc` transports, a root discovery document such as `/openapi.json`, or a pattern such as `/*` that could match one of those.

```typescript
import { Engine, serve } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

await using engine = new Engine({ storage: new MemoryStorage() });
await using server = serve({
  engine,
  port: 7233,
  routes: {
    '/status': new Response('ok'),
    '/reports/:id': (request) => Response.json({ id: request.params['id'] }),
  },
});
```

### The Operator Console

Weft ships no user interface. The console for its engine, with workflows, reviews, workers, schedules, storage, and system views, lives in the Interborough application, which serves it on one origin with the engine's API by relaying Weft's `serve()` listener (a private loopback port that answers only the host's own key) behind its public one.

### Remote Workers

Workers can connect to the server over WebSocket, pull tasks, execute activities, and report results back. The same activity code runs inline in development and remote in production—no API changes.

```typescript
import { RemoteWorker, type RemoteWorkerActivityFunction } from '@lostgradient/weft';

// A remote activity receives its input as `unknown` off the wire; validate it before use.
declare const chargeCard: RemoteWorkerActivityFunction;
declare const reserveInventory: RemoteWorkerActivityFunction;
declare const sendConfirmation: RemoteWorkerActivityFunction;

const worker = new RemoteWorker({
  serverUrl: 'wss://weft.internal:7233',
  deploymentName: 'orders',
  buildId: '2026.08.19-1',
  workflows: {
    orderFulfillment: {
      name: 'orderFulfillment',
      activities: { chargeCard, reserveInventory, sendConfirmation },
    },
  },
});

await worker.connect();
```

Workflow worker selection is pinned by default. Persist the binding returned by `bindWorkflowWorkerAtStart()` with the workflow so retries, children, forks, scheduled runs, and terminal restarts inherit the same deployment, build, artifact, manifest, workflow revision, and activity contract. An `auto-upgrade` policy must provide the exact `workflowRevision` and `activityContractHash` compatibility contract; evaluate it only after a durable checkpoint and before acquiring the next execution realm. Upgrades use compare-and-swap and retain bounded binding history. Use `issueWorkflowWorkerStartOverridePreview()` only for an explicitly destructive start-time override, and require the server-issued scoped token before applying it.

### Browser Support

The core engine runs inside a Web Worker, with a Service Worker acting as the durable persistence layer over `IndexedDB`. Browser-compatible workflow logic ships across server and browser without modification—useful for offline-first apps that need durable client-side workflows. Activities, storage adapters, and other environment-bound pieces still need browser-safe implementations: use `IndexedDBStorage` or `WebExtensionStorage` instead of SQLite storage, swap server-only activities for `fetch`-based equivalents, and so on.

Service Worker deployments can import `ServiceWorkerScheduler` from `@lostgradient/weft` and wire timer wakeups through `onTimerFired: (entry) => engine.fireTimer(entry)`. See the [Service Worker guide](documentation/guides/service-worker.md) for the browser runtime wiring and Periodic Background Sync fallback pattern.

### Schedule time zones

A cron schedule reads its wall-clock times in UTC unless it names a time zone: pass `timeZone` (an IANA name such as `America/Los_Angeles`, or `UTC`) to `engine.schedule()` or `engine.updateSchedule()`, or `timeZone` on `weft.schedules.create` and `weft.schedules.update`. An unknown name is rejected, and so is a time zone on an interval (`every`) schedule, which counts elapsed time. A schedule stored before the field existed reads as UTC.

`updateSchedule()` (and `weft.schedules.update`) can also move a schedule to another `workflowType` and replace the `input` each fire starts it with; omitted, both stay. A schedule that pins a revision re-captures its pin against the new type.

A wall-clock time happens once. When the clock springs forward, a time it skips (a daily 02:30 on that day) does not run: the schedule adds it to `missedFireCount`, sets `lastMissedFireAt`, and emits `schedule:missed-fire` with `reason: 'dst-gap'` at the instant the gap ends, which is the schedule's `nextFireAt` until then. When the clock falls back, a time it repeats (01:30 on that day) runs only the first time. So a cron expression that matches every minute or hour has no second pass through the repeated hour; use `every` for work that must run on elapsed time.

```typescript
import { Engine, ScheduleMissedFireEvent, workflow } from '@lostgradient/weft';

const engine = new Engine();
engine.register(
  workflow({ name: 'report' }).execute(async function* () {
    return 'sent';
  }),
);
engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
  if (event.reason === 'dst-gap')
    console.warn(`${event.scheduleId} skipped a time that did not exist`);
});
await engine.schedule('report', null, '0 9 * * 1-5', {
  id: 'weekday-report',
  timeZone: 'America/Los_Angeles',
});
engine[Symbol.dispose]();
```

### Skipping a run, running now, and missed runs

`engine.skipNextScheduleOccurrence(id, { occurrence })` skips one upcoming run: the occurrence you name, the next run or any after it, starts no workflow, and the runs around it fire as usual. Omit `occurrence` and the next run is skipped; it is not always `nextFireAt`, because in a time zone `nextFireAt` can be the end of a daylight-saving gap that starts nothing, so the skip lands on the next real run. Skipped runs are `skippedOccurrences` on the schedule, ascending, until the schedule moves past them, and `engine.unskipScheduleOccurrence(id, { occurrence })` takes one back. Both leave `revision` and `nextFireAt` as they are, and `expectedRevision` guards them as it does a pause; skipping a run that is already skipped, or taking back one that is not, changes nothing. A paused schedule's runs can be skipped too, counted from the first after now, and a pause keeps the skips for when the schedule resumes; a resume drops the ones it slept past, a cancel ends them all, and an update keeps only those that are still runs of its cadence. A schedule keeps at most `SCHEDULE_SKIPPED_OCCURRENCE_LIMIT` (100) skipped runs.

A fire moves neither `revision` nor `status`, so the run you read can start before your skip is written. The occurrence is compared inside the write, and a skip or unskip naming anything other than an upcoming run (one a fire has passed, a time the cadence starts no run at) is refused with `ScheduleOccurrenceNotNextError` (`Conflict` over HTTP, with `weftCode: "ScheduleOccurrenceNotNextError"` in the body to tell it from a cancelled schedule); nothing is written. Over HTTP the body of `POST /v1/schedules/:id/skip-next` takes `occurrence` and `expectedRevision`, both optional, and `POST /v1/schedules/:id/unskip` takes `occurrence` and an optional `expectedRevision`.

`engine.triggerSchedule(id)` starts one run now, under the schedule's overlap policy, and returns `started`, `queued`, or `skipped` (with the run that blocked it). The run is not an occurrence of the cadence: `nextFireAt`, `lastFireAt`, and `revision` do not change, and the run's schedule metadata (`WorkflowServicesResolverScheduleInfo`) is `manual: true` with no `occurrence`. A paused schedule can be run; a cancelled one cannot.

A schedule keeps a row for each occurrence it missed, because the engine was down (`late`) or the clock sprang forward past the time (`dst-gap`): `engine.listScheduleMissedFires(id)` reads the latest `SCHEDULE_MISSED_FIRE_LIMIT` (100) of them, newest first, while `missedFireCount` keeps counting. A row is keyed by schedule, occurrence, and reason and is written in the same storage batch as the counter, so a tick replayed after a crash records a miss once. Over HTTP these are `weft.schedules.skipnext`, `weft.schedules.unskip`, `weft.schedules.runnow` (all `schedules:write`), and `weft.schedules.missed` (`schedules:read`).

```typescript
import { Engine, workflow } from '@lostgradient/weft';

const engine = new Engine();
engine.register(
  workflow({ name: 'report' }).execute(async function* () {
    return 'sent';
  }),
);
await engine.schedule('report', null, '0 9 * * 1-5', { id: 'weekday-report', overlap: 'skip' });
const next = (await engine.getSchedule('weekday-report'))?.nextFireAt ?? 0;
await engine.skipNextScheduleOccurrence('weekday-report', { occurrence: next });
await engine.unskipScheduleOccurrence('weekday-report', { occurrence: next });
const result = await engine.triggerSchedule('weekday-report');
const missed = await engine.listScheduleMissedFires('weekday-report', { limit: 10 });
console.log(result.outcome, missed?.length);
engine[Symbol.dispose]();
```

### Observability

Built-in event system (`EventTarget`-based, so it composes with everything), W3C `traceparent` propagation, and OpenTelemetry-compatible metrics. Composable interceptors layer cross-cutting concerns—tracing, validation, encryption—without any of them knowing about each other.

Schedules also emit `schedule:fired` on the live engine each time a schedule actually launches a workflow run. The event carries `scheduleId`, `workflowId`, `firedAt`, and the scheduled `occurrence` when one is retained, so in-process dispatchers can react to cadence without polling schedule state.

```typescript
import { Engine, createObservabilityInterceptors } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

await using engine = new Engine({ storage: new MemoryStorage() });

// Passing the engine as `eventTarget` lets the interceptor close root workflow spans on terminal events.
const { interceptor } = createObservabilityInterceptors({
  tracerName: 'orders',
  eventTarget: engine,
});
engine.addInterceptor(interceptor);
```

Spans go to the tracer from `@opentelemetry/api` when it is installed and to a no-op otherwise. For metrics on your own meter, `createOpenTelemetryMetrics(meterOrName)` creates Weft's standard instrument set—workflow and activity durations, activity attempts, and active workflows.

Inside workflow code, `ctx.log` emits structured console records with `workflowId`, `workflowType`, `level`, and `timestamp` attached. Caller attributes are nested under `attributes`, so they cannot overwrite the envelope. Logs at already-restored checkpoint positions are suppressed on recovery, ; the logs in front of the operation a parked run (a signal, a review, a timer) resumes at are delivered again with `replayed: true`, which the persisted log store skips, so a line logged before `waitForSignal` is stored once; logs past that operation carry no mark, and in worker mode the destination is the worker process console. Each record also carries `step`, the index of the durable step the workflow was about to run. A timeline entry from `engine.getTimeline(id)` carries `stepIndex`, the index of the durable step its operation occupies, so a line sits immediately in front of the entry whose `stepIndex` equals the line's `step`; the entry's own `step` is the checkpoint key, which counts checkpoints and cannot place a line. An entry persisted before `stepIndex` existed has none. A step can leave a gap between entries, because a session state write and a `ctx.memo` call that finds its key cached take a step and write no entry; a retried activity has one entry per attempt, all with the activity's `stepIndex`, and each retry sleep between them has its own. A line logged inside a `ctx.speculate` callback carries the `step` of the `speculate` call, whether the speculation commits or rolls back, because the steps the callback takes are rolled back with it and have no entries of their own.

To keep a run's lines with the run, create a log store over the engine's storage, pass its `sink` as `onLog`, and pass the store as `workflowLogs`:

```typescript
import { MemoryStorage } from '@lostgradient/weft/storage';
import { Engine, createWorkflowLogStore } from '@lostgradient/weft';

const storage = new MemoryStorage();
const logs = createWorkflowLogStore(storage, { maximumLinesPerRun: 500 });
const engine = new Engine({ storage, onLog: logs.sink, workflowLogs: logs });

const { lines, dropped } = await engine.getLogs('order-1', { step: 2 });
console.log(lines.length, dropped);
```

A run keeps its newest 500 lines (`maximumLinesPerRun`); each older line the cap evicts adds one to `dropped`. A line's message and attributes together are held to 2 KiB: a long message is cut and ends in a truncation marker, and attributes that do not fit beside it are dropped. Attributes are redacted before they are stored, with the redactor the timeline summaries use: the value under a key that names a secret outright (`card`, `cvv`, `ssn`, `pin`, `password`, `secret`, `apiKey`, `privateKey`, `accessKey`, `credentials`, matched by word in any case or separator style) becomes `[REDACTED]` whatever its type, so a card number held as a number is covered; the value under a looser key (`token`, `session`, `auth`, ...) becomes `[REDACTED]` when it is a string, object or array, while a number or boolean there (`inputTokens: 12`, `passed: true`) is kept; a bearer token, a JSON Web Token or a card number is replaced wherever it appears; a value that cannot be read is replaced by a marker, and attributes that are not a record once redacted are dropped with the line marked `truncated`. The message text is not redacted, so keep secrets out of it. Only persisted lines are redacted: an `onLog` function you write yourself, in front of or instead of the store's `sink`, still receives the original record. `weft.workflows.logs.list` (`GET /v1/workflows/:id/logs?step=`) serves the same reads. The sink is buffered and written on the next turn, on `getLogs`, and on shutdown, so a crash can lose the last turn's lines. A purge removes a run's lines with it, and `logs.prune({ olderThan })` removes the lines of finished runs (a terminal workflow record, or none) that have written nothing for that long. A run that is still active, parked or not, keeps its lines whatever their age. A pruned run whose record still exists keeps its counter, so `dropped` counts the removed lines and a sequence is never reused.

### Testing

`TestEngine` swaps the production engine in tests and gives you a virtual clock. `engine.advanceTime('1 hour')` jumps timers forward without waiting; `engine.mock(activity, fake)` swaps in fake activity implementations with type-checked signatures, call recording, and per-call overrides.

```typescript
import { workflow } from '@lostgradient/weft';
import { TestEngine } from '@lostgradient/weft';
import { expect, test } from 'bun:test';

async function sendEmail(input: { to: string; template: string }): Promise<{ messageId: string }> {
  throw new Error(`send ${input.template} to ${input.to} through your email provider`);
}

const onboardingWorkflow = workflow({ name: 'onboarding' })
  .activities({ sendEmail })
  .execute(async function* (ctx, input: { name: string }) {
    yield* ctx.run('sendEmail', { to: input.name, template: 'welcome' });
    yield* ctx.sleep('1 day');
    yield* ctx.run('sendEmail', { to: input.name, template: 'follow-up' });
    return { status: 'onboarded' as const };
  });

test('onboarding completes after a day', async () => {
  const engine = new TestEngine();
  engine.register(onboardingWorkflow);

  const sendEmailMock = engine.mock(sendEmail, () => ({
    messageId: 'msg_test_1',
  }));

  const handle = await engine.start('onboarding', { name: 'Steve' });
  await engine.advanceTime('1 day');

  expect(await handle.result()).toEqual({ status: 'onboarded' });
  expect(sendEmailMock.callCount).toBe(2);
});
```

For chaos testing, `withChaos()` wraps activities with configurable transient failures, timeouts, and non-retryable errors so you can prove your retry policies actually work.

### Single-Binary Distribution

`bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. The engine, server, and your workflow code embed into a single file with zero runtime dependencies—download, run, done.

### Error Handling

Every error Weft throws extends `WeftError`, so a single `instanceof` check catches them all, and each carries a stable string `code` equal to its class name:

```typescript
import { Engine, isWeftError } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

await using engine = new Engine({ storage: new MemoryStorage() });

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

Application APIs such as `Engine`, `serve`, and `TestEngine` are exported from `@lostgradient/weft`. Use `@lostgradient/weft/worker` for remote workers, `/worker/authoring` and `/worker/generated-authoring` for worker definitions, and `@lostgradient/weft/a2a` for A2A integrations.

Under Bun, import `BunSQLiteStorage` from `@lostgradient/weft/storage/bun-sqlite`. The npm package also includes the memory and IndexedDB adapters.

## Maintainer tool

Weft owns `scripts/import-string-kv-sqlite-to-weft.ts`, a manual migration CLI that copies a legacy SQLite string key-value table into a Weft SQLite store. From this workspace, run `bun scripts/import-string-kv-sqlite-to-weft.ts --source <path> --target <path> --target-prefix app:my-service`; use `--help` to inspect the required arguments before running a migration.

## Step API for `async`/`await` Users

If generator syntax is unfamiliar, the same workflow can be written with `ctx.step()` calls and plain `async`/`await`:

```typescript
import {
  Engine,
  compileStepWorkflow,
  workflow,
  type StepWorkflowContext,
} from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';

declare const greet: (name: string) => Promise<string>;
declare const notify: (greeting: string) => Promise<void>;

await using engine = new Engine({ storage: new MemoryStorage() });

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

- [Workflows](documentation/guides/workflows.md), [Activities](documentation/guides/activities.md), [Storage](documentation/guides/storage.md), [Server](#server-mode)
- [Signals and Queries](documentation/guides/signals-and-queries.md), [Synchronous Updates](documentation/guides/synchronous-updates.md)
- [Durable Timers](documentation/guides/durable-timers.md), [Timeouts](documentation/guides/timeouts.md), [Parallel Execution](documentation/guides/parallel-execution.md)
- [Search Attributes](documentation/guides/search-attributes.md), [Workflow Visibility Backfill](documentation/guides/workflow-visibility-backfill.md), [State](documentation/guides/state.md), [Session State](documentation/guides/session-state.md), [Events](documentation/guides/events.md)
- [Interceptors](documentation/guides/interceptors.md), [Observability](documentation/guides/observability.md), [Testing](documentation/guides/testing.md)
- [Workflow Versioning](documentation/guides/workflow-versioning.md), [Remote Workers](documentation/guides/remote-workers.md), [Service Worker](documentation/guides/service-worker.md), [Resource Management](documentation/guides/resource-management.md), [Concurrency: Mutex and Semaphore](documentation/guides/concurrency.md), [Application Mailbox](documentation/guides/mailbox.md), [Application Outbox](documentation/guides/outbox.md)

Architecture and reference:

- [Design Philosophy](documentation/architecture/design-philosophy.md), [Durability Guarantee](documentation/architecture/durability-guarantee.md), [Checkpoint vs. Replay](documentation/architecture/checkpoint-versus-replay.md), [Web Standards](documentation/architecture/web-standards.md)
- [Temporal Comparison](documentation/architecture/temporal-comparison.md), [Inngest Comparison](documentation/architecture/inngest-comparison.md), [Browser Runtime](documentation/architecture/browser-runtime.md), [Web Workers](documentation/architecture/web-workers.md), [Single Binary](documentation/architecture/single-binary.md)
- [API Reference](documentation/reference/) (Engine, Context, Storage, Server, Workers, Testing, Events, Errors, Interceptors, Observability, CLI, Configuration, Types)

Contributing:

- [Development Setup](documentation/contributing/development-setup.md), [Documentation Maintenance](documentation/contributing/documentation-maintenance.md), [Subprocess Durability Tests](documentation/contributing/subprocess-durability-tests.md), [Architecture Decisions](documentation/contributing/architecture-decisions.md)

## License

MIT
