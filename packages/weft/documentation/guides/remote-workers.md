# Remote Workers

Your workflow engine runs on one machine, but your activities need to run on GPU nodes, region-specific servers, or isolated containers. Remote workers connect to the Weft server over WebSocket (or HTTP long-polling as a fallback) and execute activities wherever they're deployed. The [recovery and adoption guide](remote-task-recovery.md) explains how the server retains task ownership and outcomes across restarts.

> [!NOTE] [`RemoteWorker`](../reference/api-workers.md#remoteworker) is an internal workspace API. The v8 task transport requires clients to match the [wire protocol](../reference/remote-worker-protocol.md), including its version and storage-capability requirements.

## The RemoteWorker class

A `RemoteWorker` connects to the server, registers its available activities and concurrency capacity, then waits for task assignments.

A worker advertises its activities through a `workflows` map: each entry pairs a workflow type with that workflow's activity implementations. The SDK builds the qualified `${workflowType}.${activityName}` names the protocol expects (so the `media` workflow's `transcribe` activity is advertised as `media.transcribe`) and validates that each map key matches the inner `workflow.name`.

```typescript
import { RemoteWorker } from '@lostgradient/weft';

const worker = new RemoteWorker({
  serverUrl: 'wss://weft-server:7233',
  workflows: {
    media: {
      name: 'media',
      activities: {
        transcribe: async (input) => {
          /* ... */
        },
        generateThumbnail: async (input) => {
          /* ... */
        },
      },
    },
  },
  concurrency: 5,
  queue: 'gpu',
  deploymentName: 'media-workers',
  buildId: '2026.08.19-1',
  workerId: 'gpu-worker-1', // optional, auto-generated if omitted
});

await worker.connect();
```

Use `wss://` for deployed workers. Plain `ws://` is only appropriate for localhost or trusted development networks because task metadata and propagated headers travel over that connection.

The following subset shows the required identity and common execution options. The [worker API reference](../reference/api-workers.md#remoteworkeroptions) also covers complete manifests, artifact digests, authentication headers, and runtime metadata:

```typescript
import type { ActivityInterceptor } from '@lostgradient/weft';

interface RemoteWorkerOptions {
  serverUrl: string;
  deploymentName: string;
  buildId: string;
  workerId?: string; // default: crypto.randomUUID()
  workflows: Record<
    string,
    { name: string; activities: Record<string, (input: unknown) => Promise<unknown>> }
  >;
  concurrency?: number; // default: 10
  queue?: string; // default: 'default'
  disconnectTimeoutMs?: number; // default: 30_000
  interceptors?: ActivityInterceptor[];
}
```

On connection, the worker sends a v8 `register` message carrying its worker ID, concurrency limit, and a canonical manifest describing its deployment, runtime, and workflows. The server derives routing activities from the manifest and reads the queue from the connection URL. `connect()` resolves only after the server replies with `registerAck`; it rejects on `registerError` or if the socket closes before acknowledgement. The server tracks the accepted worker in the `WorkerRegistry`.

## Dispatching `ctx.run()` to remote workers

A workflow reaches a `RemoteWorker` the same way it reaches any other activity: through `ctx.run()`. Configure the engine with `activityExecution: { mode: 'remote' }` and every `ctx.run()` call durably enqueues its activity onto the engine's own task ledger for a connected worker to claim, instead of running on the main thread or a local Worker pool.

```typescript
import { Engine, activity, workflow } from '@lostgradient/weft';

const formatGreeting = activity({
  name: 'formatGreeting',
  execute: async (input: { name: string }) => `Hello, ${input.name}!`,
});

const greetingWorkflow = workflow({ name: 'greeting' })
  .activities({ formatGreeting })
  .execute(async function* (ctx, input: { name: string }) {
    return yield* ctx.run(formatGreeting, input);
  });

const engine = new Engine({
  activityExecution: { mode: 'remote', queue: 'default' },
});
engine.register(greetingWorkflow);
```

`formatGreeting`'s own `execute` body never runs in this configuration — it exists so the workflow type-checks and so an inline or worker-mode engine could still run the same workflow. The engine derives the activity's qualified name (`greeting.formatGreeting`) from its own canonical workflow registration, never from the call site, and durably records queue, retry policy, headers, and the workflow's execution token on the task before any worker claims it.

Because dispatch is durable, `ctx.run()` never falls back to local execution: an activity call started before any `serve()` call exists (or before a worker with capacity connects) simply leaves its task `queued` on the engine's storage until one does. Attach a server the same way `dispatchTask` requires — `serve({ engine })` — and a connected worker advertising the matching activity claims and executes it, exactly as in [Task dispatch](#task-dispatch) below. This works over either transport: a `RemoteWorker` claims it over WebSocket, and a `LongPollWorker` claims the identical durable record through its poll loop whenever no WebSocket worker is available for the task's queue — `LongPollWorker`'s `activities` map must key the implementation by the SAME qualified `${workflowType}.${activityName}` name `ctx.run()` derives, not the bare activity name shown elsewhere in this guide's long-poll examples.

This is a genuinely different durability domain from `dispatchTask`: `ctx.run()` durably parks the calling workflow (the same durable-completion mechanism `ActivityContext.completeAsync()` uses) until the result arrives, and the exact value or error a worker returns resumes that `ctx.run()` call — including through an engine restart, since the task's `queued`/`leased` ledger record and the workflow's own checkpoint both survive independently of the process that created them.

A workflow's definition-level `finalizer` and any `durableActivity()` helper call always run locally on the engine host, never through `activityExecution: { mode: 'remote' }` dispatch, regardless of how the engine is configured. A finalizer runs post-terminal, after the workflow's own generator is already evicted, so there is no live `ctx.run()`-style operation for remote dispatch to intercept; `durableActivity()`'s internal helper calls explicitly opt out of remote dispatch so their synchronous-result assumption holds.

## Task dispatch

When the engine needs to execute an activity, the server finds a worker that has capacity and knows how to run it. Tasks arrive as JSON messages over the WebSocket:

```json
{
  "type": "task",
  "operationId": "abc-123",
  "attemptToken": "attempt-1",
  "activityName": "media.transcribe",
  "input": { "audioUrl": "..." }
}
```

The worker looks up the activity function, executes it, and sends back a result:

```json
{
  "type": "taskResult",
  "operationId": "abc-123",
  "attemptToken": "attempt-1",
  "status": "completed",
  "value": { "transcript": "..." }
}
```

If the activity function throws, the result message carries `"status": "failed"` with an error string. If the activity name isn't registered on this worker, an error result is sent immediately.

`task` optionally carries `workflowRevision`—the dispatching workflow run's persisted revision, when the `TaskDispatch` caller supplied one. Echo it back on `taskResult` unchanged; the server rejects a completion whose echoed revision disagrees with the dispatch's as stale. See [the protocol reference](../reference/remote-worker-protocol.md#taskresult) for the exact WebSocket-additive-versus-long-poll-strict authorization rule.

## Activity interceptors

You want to trace every remote activity with [OpenTelemetry](https://opentelemetry.io/), log timing for the on-call dashboard, or validate that the headers coming across the wire carry the metadata you expect before anything touches your business logic. Sprinkling that code into every activity function is exactly the kind of duplication interceptors exist to solve.

Pass an array of `ActivityInterceptor` objects to `RemoteWorker`, and they wrap every task execution on this worker. The chain runs _after_ the task arrives off the WebSocket but _before_ your activity function sees the input, which means interceptors can read propagated headers, transform inputs, observe failures, and record timing without your activities knowing anything about them.

```typescript
import { RemoteWorker } from '@lostgradient/weft';
import type { ActivityInterceptor } from '@lostgradient/weft';

const loggingInterceptor: ActivityInterceptor = {
  async execute(interception, next) {
    const start = Date.now();
    console.log(`[remote:start] ${interception.activityName} (attempt ${interception.attempt})`);

    try {
      const result = await next(interception);
      console.log(`[remote:done] ${interception.activityName} (${Date.now() - start}ms)`);
      return result;
    } catch (error) {
      console.log(`[remote:error] ${interception.activityName} (${Date.now() - start}ms)`);
      throw error;
    }
  },
};

const worker = new RemoteWorker({
  serverUrl: 'wss://weft-server:7233/api/v1/tasks/default/stream',
  deploymentName: 'media-workers',
  buildId: '2026.08.19-1',
  workflows: {
    media: {
      name: 'media',
      activities: {
        transcribe: async (input) => {
          /* ... */
        },
      },
    },
  },
  interceptors: [loggingInterceptor],
});
```

The interception context gives you everything you need to observe the call:

```typescript
interface ActivityExecutionInterception {
  activityName: string;
  input: unknown; // mutable — interceptors can transform it
  attempt: number;
  headers: Map<string, string>; // propagated from the dispatching workflow
  operationId?: string; // Operation identifier, available when executing on a remote worker.
  signal?: AbortSignal; // Abort signal for cancellation, available when executing on a remote worker.
}
```

The `headers` Map is the important piece for remote workers. When a workflow interceptor sets a header on the dispatch side (for example, an OpenTelemetry `traceparent` or an opaque credential reference such as `x-weft-credential-reference`), the engine serializes it into the WebSocket task message, and the `RemoteWorker` rehydrates it into the `headers` Map before calling your interceptor chain. Use the reference to resolve real secrets inside the worker from its own secret store; do not propagate raw bearer tokens, API keys, or encryption keys through task headers. That's how trace context and authorization context cross the network boundary without your activity function knowing anything about tracing.

The most common use case is observability. The built-in `createObservabilityInterceptors()` factory returns a unified interceptor whose workflow and activity hooks share trace context across the boundary. Pass the same interceptor to every remote worker that should show up in your traces:

```typescript partial
import { createObservabilityInterceptors } from '@lostgradient/weft';

const { interceptor } = createObservabilityInterceptors();

const worker = new RemoteWorker({
  serverUrl: 'wss://weft-server:7233/api/v1/tasks/default/stream',
  deploymentName: 'media-workers',
  buildId: '2026.08.19-1',
  workflows: {
    media: {
      name: 'media',
      activities: {/* ... */},
    },
  },
  interceptors: [interceptor],
});
```

Multiple interceptors compose like middleware: the first one in the array is the outermost wrapper, and each calls `next(interception)` to delegate inward. Registration order matters—put tracing first so it measures everything that happens inside, and put validation near the inside so it runs after logging has already captured the attempt.

> [!NOTE] If you pass zero interceptors (or omit the option entirely), the worker skips the composition path and calls your activity function directly. There's no overhead for workers that don't need instrumentation.

## Heartbeats

Two independent clocks run on their own intervals, but they renew different things (COR-230, protocol v5):

- The **worker-session heartbeat** (`{ type: 'heartbeat', workerId }`) tells the server the connection is alive, every 10 seconds. `WorkerRegistry.heartbeat()` updates `lastHeartbeat` and nothing else — it does NOT extend any task's visibility timeout, even though it did before v5.
- The **activity heartbeat** (`{ type: 'activityHeartbeat', workerId, operationId, attemptToken, details? }`) extends the visibility timeout of exactly one in-flight attempt, fenced by the same `(operationId, attemptToken)` identity check `taskResult` uses. `RemoteWorker` sends one automatically for every in-flight attempt, on an interval derived from that dispatch's `visibilityTimeout` (COR-226, protocol v8) — roughly a third of it, floored at one second — so an ordinary missed heartbeat still leaves margin before the lease actually expires. `LongPollWorker` does the identical thing over HTTP (see [Long-poll fallback](#long-poll-fallback) below); both transports keep a long-running attempt's lease alive without the activity doing anything.

```typescript partial
// Internally, RemoteWorker does:
this.#heartbeat = new HeartbeatManager(() => {
  this.#sendMessage({ type: 'heartbeat', workerId: this.#options.workerId });
}, 10_000);

// ...and, automatically, once per in-flight attempt, on an interval derived
// from that attempt's visibilityTimeout:
this.#sendActivityHeartbeat(task);
```

Renewal is capped by the attempt's absolute deadline — a fixed ceiling on total attempt lifetime that neither heartbeat kind can extend, so a stalled worker that only ever heartbeats cannot hold an attempt open forever. Before COR-226, only `LongPollWorker` sent this automatic per-attempt heartbeat; a long-running `RemoteWorker`-dispatched activity had to outlive its own visibility timeout with nothing renewing the lease, so its attempt would silently expire, get reassigned by the server's expiry scan, and run a second time concurrently. `RemoteWorker` now behaves the same way as `LongPollWorker` here.

### Heartbeat details

An activity can attach progress details to its heartbeat, exactly the way an inline (in-process) activity uses `ActivityContext.heartbeat()` — this is the same public surface, not a second heartbeat API:

```typescript partial
const worker = new RemoteWorker({
  /* ... */
  workflows: {
    media: {
      name: 'media',
      activities: {
        transcode: async (input: { chunks: number }, context) => {
          const start = (context?.lastHeartbeatDetails as { done?: number } | undefined)?.done ?? 0;
          for (let done = start; done < input.chunks; done++) {
            // ... process chunk `done` ...
            context?.heartbeat({ done: done + 1 });
          }
          return 'transcoded';
        },
      },
    },
  },
});
```

`context.heartbeat(details)` sends the details on an `activityHeartbeat` frame (or the long-poll heartbeat request body) immediately, in addition to — not instead of — the automatic interval-driven keepalive above. The server persists the most recent details on the durable task record and, if this attempt is later redispatched (a visibility-timeout requeue, a worker disconnect, or a server restart), echoes them back on the new attempt's `task` frame as `context.lastHeartbeatDetails`, so the resumable-batch pattern above works the same way it does for an inline activity. `details` must be JSON-serializable and within the server's configured payload size limit (`payloadSize.maxBytes`) — the same bound a `taskResult` value already gets, enforced with the same error shape.

## Cancellation

The server can request cancellation of an in-flight remote activity — for example, through an operator-initiated `WeftServer.cancelTask()` call. Cancellation is **cooperative**: the server records durable cancellation intent and asks the worker to stop, but nothing forces the activity's code to actually return early. An activity that never checks its `AbortSignal` keeps running until it finishes on its own; the server settles the attempt as cancelled anyway once a configured grace period elapses, but with `uncertain: true` recorded — the server does not know whether the activity's own side effects actually stopped.

An activity observes cancellation the same way on both transports:

```typescript partial
const worker = new RemoteWorker({
  /* ... */
  workflows: {
    media: {
      name: 'media',
      activities: {
        transcode: async (input, context) => {
          for (const chunk of input.chunks) {
            if (context?.signal.aborted) {
              throw new Error(context.signal.reason as string);
            }
            // ... process chunk ...
          }
          return 'transcoded';
        },
      },
    },
  },
});
```

`context.signal.reason` (COR-223, protocol v8) carries the durably recorded, operator-supplied cancellation reason — the same string an operator passed to `cancelTask(operationId, reason)` — rather than a generic placeholder. `RemoteWorker` receives it on the WebSocket `cancel` control message's `reason` field; `LongPollWorker`, which has no server-to-worker push channel, receives it piggybacked on its next heartbeat response (`{ ok: true, cancelled: true, reason }`). Both workers report the same reason on the resulting `taskResult`'s `error` field when the activity throws in response to the abort. A signal aborted for a reason OTHER than a server-sent cancellation — shutdown, `dispose()`, or the drain timeout — carries no string reason, and both workers fall back to the generic `"Task cancelled"` in that case.

## Queue-based routing

Workers register with a queue name. The server's `WorkerRegistry.findWorker()` uses **least-loaded routing**—it picks the worker with the lowest in-flight count among those that handle the requested activity and have available capacity.

The registry supports three routing policies, configured via `serve({ routingPolicy })`:

- **`'least-loaded'`** (default) -- picks the worker with the lowest in-flight task count.
- **`'round-robin'`** -- rotates through workers in registration order.
- **`'fair-share'`** -- picks the worker with the fewest in-flight tasks for a given partition key (`fairShareKey`). Useful for workload isolation: tasks sharing a partition key go to the same worker when capacity allows, preventing one partition's burst from starving others.

```typescript
interface RoutingOptions {
  sticky?: string; // preferred worker ID for cache locality
  queue?: string;
  fairShareKey?: string; // partition key for fair-share routing
}
```

If a `sticky` preference is provided (useful for cache locality), the registry checks that worker first. If it has capacity, it gets the task. Otherwise, least-loaded routing kicks in.

Workers inside the server's reconnect grace window are temporarily excluded from routing by `serve()` so new tasks prefer eligible peers instead of landing on a socket that just closed. The grace window is configured with `serve({ workerReconnectGracePeriodMs })`; it defaults to `2000` ms, is clamped to `0..5000`, and `0` disables the grace path for immediate requeue behavior. Use `100` only for low-latency test or embedded scenarios. Use `5000` for cloud or load-balancer deployments where replacement workers commonly need several seconds to reconnect.

## The WorkerRegistry

On the server side, `WorkerRegistry` tracks all connected workers and their state:

```typescript
interface WorkerInfo {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
}
```

Key operations:

- `register(info)`: add a worker when it connects
- `unregister(workerId)`: remove a worker, returns its info for task reassignment
- `heartbeat(workerId)`: update last heartbeat timestamp
- `taskAssigned(workerId)` / `taskCompleted(workerId)`: track in-flight counts
- `findWorker(activityName, options?)`: least-loaded routing
- `assignTask(workerId, operationId, visibilityTimeout)`: track task with deadline
- `checkExpiredTasks(now)`: find tasks whose visibility timeout has expired
- `extendVisibility(operationId, extension)`: extend a task's deadline (heartbeat-driven)
- `isAssignedToAttempt(operationId, workerId, attemptToken: string)`: trust-boundary ownership check for task results, including same-worker stale-attempt rejection

The `checkExpiredTasks()` method returns tasks that have exceeded their visibility timeout, enabling the server to reassign them to another attempt. Each dispatch carries a non-empty `attemptToken`; workers must echo it on `taskResult`, and the server validates `(operationId, workerId, attemptToken)` exactly. A missing or late result from a displaced worker, or from an earlier attempt that was reassigned to the same `workerId`, is rejected with `protocolError` and ignored instead of mutating engine state.

## Long-poll fallback

Not every environment supports WebSockets. The `LongPollWorker` provides the same functionality over plain HTTP requests.

```typescript
import { LongPollWorker } from '@lostgradient/weft';

const worker = new LongPollWorker({
  serverUrl: 'http://weft-server:7233',
  deploymentName: 'gpu-transcription-worker',
  buildId: '2026-09-28',
  workflows: {
    transcription: {
      name: 'transcription',
      activities: {
        transcribe: async (input) => {
          /* ... */
        },
      },
    },
  },
  concurrency: 5,
  queue: 'gpu',
  pollTimeout: 30_000, // how long each poll request blocks
});

worker.start();
```

The long-poll worker first `POST`s its canonical manifest to `/api/v1/worker-sessions`. The server accepts the registration, assigns an opaque `sessionId`, returns a one-time `sessionToken`, and records the authoritative queue from the registration body. After that, the worker sends `Weft-Worker-Session-Token: <sessionToken>` while it `GET`s `/api/v1/worker-sessions/:sessionId/tasks?timeout=<milliseconds>`, blocks for up to `pollTimeout` milliseconds waiting for a task whose activity is allowed by the accepted manifest, executes it, and `POST`s the result to `/api/v1/worker-sessions/:sessionId/results`. It respects the concurrency limit by pausing the poll loop when all slots are in use. `stop()` sends `DELETE /api/v1/worker-sessions/:sessionId` after aborting local work and suspending result retries.

The poll response includes a synthetic `workerId` and per-claim `attemptToken`. The result body echoes both fields so the server can reject stale completions after a visibility timeout or re-claim. The protocol details live in the [HTTP long-poll transport reference](../reference/remote-worker-protocol.md#http-long-poll-transport).

For each in-flight activity, `LongPollWorker` also `POST`s a heartbeat to `/api/v1/worker-sessions/:sessionId/heartbeat` on a `heartbeatIntervalMs` interval (default 10 seconds, matching `HeartbeatManager`'s WebSocket-transport default) — COR-230's long-poll counterpart to the WebSocket transport's `activityHeartbeat`, renewing the same attempt-fenced visibility deadline through the identical server-side `renewAttemptLease` transition. Long-poll has no server-to-worker push channel, so a server-initiated cancellation (`WeftServer.cancelTask`) is signaled back on the heartbeat response's `cancelled` field instead of a pushed control message; `LongPollWorker` aborts that activity's own `AbortController` — keyed by `(operationId, attemptToken)`, exactly like `RemoteWorker`'s — and reports `status: "cancelled"` on its next result.

Error handling for polling is built in—network failures trigger a 1-second backoff, abort errors during shutdown are suppressed, and a missed heartbeat is simply retried on the next interval tick. Result _delivery_ has its own, separate durability story — see the next section.

## Result delivery and acknowledgement

Producing a result and having the server durably apply it are two different events, and a worker never treats the first as proof of the second. Both worker classes retain a result until the server's disposition is actually confirmed, not merely until a send call returns.

**`RemoteWorker`** buffers every `taskResult` in an in-memory outbox, keyed by `(operationId, attemptToken)`, before sending it over the socket. `WebSocket.send()` returning only proves the frame left the process — it proves nothing about whether the server received it or whether its response made it back. Only a matching `taskResultAck` (`{ type: 'taskResultAck', operationId, attemptToken, disposition }`, with `disposition` one of `"applied"`, `"duplicate"`, or `"dead-lettered"`) removes the entry. A reconnect resends every still-buffered result, in insertion order, over the fresh socket — the server's ledger makes a resend idempotent (a `"duplicate"` disposition) rather than re-executing the activity. `unacknowledgedResultCount` reports how many results are still waiting; `disconnect()` resolves with `{ unacknowledgedResults }` so a caller can tell whether anything is still outstanding when it disconnects deliberately, and a server-initiated graceful shutdown logs the same count if it is nonzero. A permanently-unappliable submission — an unknown operation, a stale or foreign attempt, a workflow-revision mismatch, or conflicting content resubmitted under one attempt token — is correlated back to the outbox entry via a `protocolError` naming the same `operationId`/`attemptToken` and dropped rather than resent forever.

**`LongPollWorker`** gives every result POST — completed, failed, cancelled, or "unknown activity" — the equivalent treatment through its own delivery component, since HTTP long-polling has no persistent connection or reconnect event to hang an outbox flush on. A result is retained until its disposition response is actually read: `{ "ok": true, "disposition": "applied" | "duplicate" | "dead-lettered" }` acknowledges it; a network failure or a transient rejection (any non-2xx status, or a `403` whose body does not name this exact submission) retries with a capped exponential backoff (`resultRetryBaseDelayMs`, default `1_000`; `resultRetryMaxDelayMs`, default `30_000`); a correlated `403` — the response body's `operationId`/`attemptToken` matching this submission — is a permanent rejection and drops the buffered result, mirroring `RemoteWorker`'s protocol-level correlation. `unacknowledgedResultCount` mirrors `RemoteWorker`'s identical getter. `stop()` suspends delivery — every scheduled retry is cancelled, but buffered entries are kept — and resolves with `{ unacknowledgedResults }`, warning if the count is nonzero; the next `start()` immediately re-attempts delivery of anything still buffered. The poll loop itself also declines new work while this buffer is full, the same backpressure `RemoteWorker` applies to its own outbox.

This durability is **process-memory only** for both worker classes: neither the outbox nor the long-poll delivery buffer survives a process restart. A result produced and buffered right before the worker process is killed is lost — the server's own visibility-timeout expiry is what eventually reclaims and redispatches that task to a live worker, not this in-memory retry mechanism. See the [protocol reference](../reference/remote-worker-protocol.md#taskresultack) for the exact wire shapes and the [rejection classification](../reference/remote-worker-protocol.md#protocolerror) both transports share.

## Graceful shutdown

Both worker types support graceful shutdown. The `RemoteWorker` drains in-flight tasks before closing the WebSocket:

```typescript partial
await worker.disconnect();
```

The server can also initiate shutdown by sending a `{ type: 'shutdown' }` message. The worker stops accepting new tasks, waits for in-flight work to complete, then closes.

`RemoteWorker.disconnect()` and `LongPollWorker.stop()` both resolve with the same `{ unacknowledgedResults: number }` shape — how many produced results are still awaiting a durable disposition when the drain completes (see [Result delivery and acknowledgement](#result-delivery-and-acknowledgement) above). A nonzero count is not an error: for `RemoteWorker` those results resend automatically on the next `connect()`; for `LongPollWorker`, on the next `start()`.

Both classes implement `Disposable` for immediate cleanup with `using`. That synchronous cleanup is not an awaited drain. Call `disconnect()` for a remote worker or `stop()` for a long-poll worker before leaving the scope when in-flight work must settle:

```typescript partial
{
  using worker = new RemoteWorker(options);
  await worker.connect();
  // Worker runs...
  await worker.disconnect();
} // Immediate disposal after the awaited drain
```

The `connected`, `inFlight`, `shuttingDown`, and `unacknowledgedResultCount` properties (the last shared by both worker classes) let you monitor worker status for health checks and dashboards.
