# Web Worker Execution Model

Weft uses the standard `Worker` API—not `node:worker_threads`, but the _web standard_ `Worker`—to isolate workflow and activity execution from the main thread when you configure Worker execution.

The main thread runs the HTTP server, the API router, and the scheduler. With `workflowExecutionMode: 'worker'`, workflow generator turns run in separate Web Workers with their own event loop, memory, and failure boundary. Inline execution remains available for trusted deployments.

```
┌──────────────────────────────────────────────┐
│ Main Thread                                  │
│                                              │
│  Bun.serve()          ← HTTP/WS requests     │
│  Router               ← API routing          │
│  Scheduler            ← Timer/retry polling   │
│  BroadcastChannel     ← Coordination          │
│                                              │
│  Worker mode keeps workflow turns isolated    │
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

## Why Workers, not just async code on the main thread

Four reasons, in order of importance.

**Fault isolation.** If a workflow throws an unhandled error, crashes its worker, or wedges a Worker turn past the configured wall-clock budget, the failure stays contained to that Worker—not the HTTP server. The main thread marks every workflow whose generator state lived in that Worker as failed, discards the Worker so the pool never reuses it, and can acquire a replacement Worker for later workflows.

**True parallelism.** JavaScript is single-threaded per event loop. Web Workers give you actual OS threads. A workflow computing something CPU-heavy doesn't block other workflows or the API server.

**Portability.** The `Worker` API is identical in Bun and in browsers. The same isolation model works in both environments with zero code changes. This is the core "web native" win—you're not locked into a server-only execution model.

**Memory control.** Bun's `smol: true` option for Workers reduces the memory footprint per worker, which is useful when running many concurrent workflows on a single machine.

## The boundary is `ExecutionStrategy`, not the Worker itself

Workflows are user-supplied code, so "where does the workflow generator step?" is a trust decision. Weft makes that decision in exactly one place: `ExecutionStrategy` (`src/core/execution-strategy.ts`). It is the untrusted-workflow isolation boundary, and the Worker is _today's_ transport for it—not the boundary itself. `InlineExecutionStrategy` steps the generator in the engine's own isolate (trusted workflows only); `WorkerExecutionStrategy` steps it inside a Web Worker, talking to the engine through bounded `postMessage` turns, so untrusted code never runs in the engine isolate. Because the interface returns `void` and couples only through serializable messages, the same boundary could later host an out-of-process or remote workflow worker without changing the engine.

That future transport is _not_ the RemoteWorker WebSocket protocol ([remote-worker-protocol.md](../reference/remote-worker-protocol.md)): that protocol is one-shot activity dispatch and is unsuitable for the stateful checkpoint/resume cycle a workflow needs. The security contract is engine-isolate protection, Worker-pool containment, bounded Weft-owned protocol messages, and deterministic replay from Worker checkpoints that carry replay signatures.

## Replacing the Temporal sandbox

Temporal's TypeScript SDK uses Webpack bundling to create a sandboxed execution environment for workflows. The sandbox strips out non-deterministic APIs, prevents importing Node.js modules, intercepts `console.log`, and introduces module resolution failures in monorepos. The result: workflow code _looks_ like TypeScript but runs in a restricted subset of JavaScript.

Weft gets engine-isolate protection and crash containment through Web Workers instead. Workers provide a separate JavaScript realm and event loop without restricting the language:

- **`console.log` works.** No special logger required.
- **Any npm package works.** No module resolution restrictions. No Webpack errors.
- **`debugger` statements work.** Bun's debugger and Chrome DevTools can attach to Workers.
- **Stack traces point to your source files.** Not to Webpack-generated bundle code.
- **No build step for workflows.** Changes take effect immediately. No Webpack rebuild.

The important distinction is what the Worker boundary does and does not promise. It keeps workflow generator turns out of the engine isolate, gives the engine a Worker to terminate on timeout or crash, and bounds Weft-owned protocol messages. It does not prove message authorship inside the Worker realm and it does not lock down Worker globals, imports, network access, filesystem access in Bun, or memory outside Weft's protocol envelopes.

## Communicating with Workers

The main thread and workers communicate via `postMessage`, the standard Web Worker messaging API.

```typescript partial
// Main thread: spawn a workflow worker
const worker = new Worker(new URL('./workflow-runner.ts', import.meta.url), {
  smol: true, // Bun-specific: reduce memory footprint
});

// Send a workflow task to the worker
worker.postMessage(
  {
    type: 'run',
    protocolVersion: 1,
    turnId: 1,
    workflowId: 'wf-abc123',
    workflowType: 'order',
    checkpoint: checkpointBlob, // ArrayBuffer — transferred, not copied
    input: { orderId: 'order-456' },
    maxProtocolMessageBytes: 1_048_576,
  },
  [checkpointBlob], // Transfer list: zero-copy
);
```

Note the transfer list on that `postMessage` call. When you pass an `ArrayBuffer` in the transfer list, ownership moves to the receiving thread—no copy happens. For a 10KB checkpoint, this is O(1) instead of O(n). At scale, those zero-copy transfers add up fast.

The worker side is equally straightforward.

```typescript partial
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
};
```

The main thread listens for results and dispatches accordingly—checkpoints get persisted, completions get recorded, failures get logged. In hardened Worker mode, the host also requires the expected protocol version and turn id before a message can settle the current Worker turn, and it repeats message-size checks before forwarding the message to the engine.

```typescript partial
worker.onmessage = (event) => {
  const { type, workflowId, checkpoint, result, operationRequest } = event.data;

  switch (type) {
    case 'checkpoint':
      storage.updateCheckpoint(workflowId, checkpoint);
      storage.scheduleOperation(operationRequest);
      break;
    case 'completed':
      storage.completeWorkflow(workflowId, result);
      break;
    case 'failed':
      storage.failWorkflow(workflowId, result);
      break;
  }
};
```

## BroadcastChannel for coordination

**`BroadcastChannel`** is a web standard for pub/sub messaging between same-origin contexts—windows, tabs, workers. In Bun, it works across Workers. You create a named channel, and any Worker subscribed to that channel name receives messages posted to it.

Weft uses `BroadcastChannel` for engine-wide coordination without direct Worker-to-Worker references.

```typescript partial
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

This replaces what would otherwise be complex direct Worker references or a shared-memory coordination protocol. The scheduler doesn't need to know which worker is running which workflow. It broadcasts a signal, and the right worker picks it up.

## Memory management with WeakRef and friends

Long-running processes like workflow engines are prime targets for memory leaks. Weft uses three primitives—`WeakRef`, `WeakMap`, and `FinalizationRegistry`—to eliminate entire categories of them.

### Checkpoint cache

When a workflow is actively being advanced, we cache its deserialized checkpoint in memory to avoid repeated deserialization. But we don't want to hold every checkpoint forever—that's a memory leak for an engine running thousands of workflows.

```typescript partial
class CheckpointCache {
  #cache = new Map<string, WeakRef<GeneratorState>>();
  #registry = new FinalizationRegistry<string>((workflowId) => {
    this.#cache.delete(workflowId);
  });

  get(workflowId: string): GeneratorState | undefined {
    const ref = this.#cache.get(workflowId);
    if (!ref) return undefined;
    const state = ref.deref();
    if (!state) {
      this.#cache.delete(workflowId);
      return undefined;
    }
    return state;
  }

  set(workflowId: string, state: GeneratorState): void {
    const existing = this.#cache.get(workflowId);
    if (existing) {
      const old = existing.deref();
      if (old) this.#registry.unregister(old);
    }
    this.#cache.set(workflowId, new WeakRef(state));
    this.#registry.register(state, workflowId, state);
  }
}
```

`WeakRef` lets the garbage collector reclaim cached checkpoints when memory is tight. If the engine needs the checkpoint again, it re-reads from storage. `FinalizationRegistry` notifies us when a cached value has been collected, so we can clean up the Map entry. No periodic sweep needed, no timer overhead.

A regular `Map<string, GeneratorState>` would hold strong references to every checkpoint ever loaded. In a long-running server processing thousands of workflows, that grows without bound.

### Activity registry

Activity functions are registered by reference, with metadata (name, retry policy, queue) attached. A `WeakMap` ties metadata to the function object itself. If the function is garbage collected—say, a dynamically registered activity in a hot-reload scenario—the metadata is automatically cleaned up.

```typescript partial
class ActivityRegistry {
  #metadata = new WeakMap<Function, ActivityMetadata>();
  #nameIndex = new Map<string, WeakRef<Function>>();

  register(name: string, fn: Function, options?: ActivityOptions): void {
    const metadata: ActivityMetadata = {
      name,
      queue: options?.queue ?? 'default',
      retry: options?.retry ?? defaultRetryPolicy,
      timeout: options?.timeout,
    };
    this.#metadata.set(fn, metadata);
    this.#nameIndex.set(name, new WeakRef(fn));
  }
}
```

No `Map` of orphaned registrations growing forever. The garbage collector does the bookkeeping.

### The smol option

Bun's `smol: true` flag on Worker construction reduces the per-worker memory footprint. When you're running hundreds of concurrent workflows, each in its own Worker, the memory savings compound. It's a one-line optimization that's impossible in environments that don't support the `Worker` API natively.

```typescript
const worker = new Worker(new URL('./workflow-runner.ts', import.meta.url), {
  smol: true,
});
```

This is the kind of thing you get when you build on platform primitives instead of around them. Bun optimizes Workers; we use Workers; our users get the optimization for free.
