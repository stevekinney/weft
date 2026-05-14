# Platform Foundations

This companion document was split out of [../architecture.md](../architecture.md) so the roadmap can stay checklist-first. It preserves the architectural rationale, platform philosophy, vocabulary, web-standards foundation, and the early core design decisions.

The research source of truth now lives in [./research.md](./research.md). Track 8 should follow the same platform rule as every earlier decision in this document: transport parity is an adapter layer over the existing `Engine`, typed `EventTarget` events, `BroadcastChannel` coordination, and Worker `postMessage` protocols, not a second orchestration stack.

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
