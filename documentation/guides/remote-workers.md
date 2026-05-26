# Remote Workers

Your workflow engine runs on one machine, but your activities need to run on GPU nodes, region-specific servers, or isolated containers. Remote workers connect to the Weft server over WebSocket (or HTTP long-polling as a fallback) and execute activities wherever they're deployed.

## The RemoteWorker class

A `RemoteWorker` connects to the server, registers its available activities and concurrency capacity, then waits for task assignments.

```typescript
import { RemoteWorker } from 'weft';

const worker = new RemoteWorker({
  serverUrl: 'wss://weft-server:7233/v1/tasks/default/stream',
  activities: {
    transcribe: async (input) => {
      /* ... */
    },
    generateThumbnail: async (input) => {
      /* ... */
    },
  },
  concurrency: 5,
  queue: 'gpu',
  workerId: 'gpu-worker-1', // optional, auto-generated if omitted
});

await worker.connect();
```

Use `wss://` for deployed workers. Plain `ws://` is only appropriate for localhost or trusted development networks because task metadata and propagated headers travel over that connection.

The `RemoteWorkerOptions` interface:

```typescript
import type { ActivityInterceptor } from 'weft';

interface RemoteWorkerOptions {
  serverUrl: string;
  workerId?: string; // default: crypto.randomUUID()
  activities: Record<string, (input: unknown) => Promise<unknown>>;
  concurrency?: number; // default: 10
  queue?: string; // default: 'default'
  disconnectTimeoutMs?: number; // default: 30_000
  interceptors?: ActivityInterceptor[];
}
```

On connection, the worker sends a v1 `register` message with its identity, available activity names, concurrency limit, and queue. `connect()` resolves only after the server replies with `registerAck`; it rejects on `registerError` or if the socket closes before acknowledgement. The server tracks the accepted worker in the `WorkerRegistry`.

## Task dispatch

When the engine needs to execute an activity, the server finds a worker that has capacity and knows how to run it. Tasks arrive as JSON messages over the WebSocket:

```json
{
  "type": "task",
  "operationId": "abc-123",
  "activityName": "transcribe",
  "input": { "audioUrl": "..." }
}
```

The worker looks up the activity function, executes it, and sends back a result:

```json
{
  "type": "taskResult",
  "operationId": "abc-123",
  "status": "completed",
  "value": { "transcript": "..." }
}
```

If the activity function throws, the result message carries `"status": "failed"` with an error string. If the activity name isn't registered on this worker, an error result is sent immediately.

## Activity interceptors

You want to trace every remote activity with OpenTelemetry, log timing for the on-call dashboard, or validate that the headers coming across the wire carry the metadata you expect before anything touches your business logic. Sprinkling that code into every activity function is exactly the kind of duplication interceptors exist to solve.

Pass an array of `ActivityInterceptor` objects to `RemoteWorker`, and they wrap every task execution on this worker. The chain runs _after_ the task arrives off the WebSocket but _before_ your activity function sees the input, which means interceptors can read propagated headers, transform inputs, observe failures, and record timing without your activities knowing anything about them.

```typescript
import { RemoteWorker } from 'weft';
import type { ActivityInterceptor } from 'weft';

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
  serverUrl: 'wss://weft-server:7233/v1/tasks/default/stream',
  activities: {
    transcribe: async (input) => {
      /* ... */
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
import { createObservabilityInterceptors } from 'weft';

const { interceptor } = createObservabilityInterceptors();

const worker = new RemoteWorker({
  serverUrl: 'wss://weft-server:7233/v1/tasks/default/stream',
  activities: {
    /* ... */
  },
  interceptors: [interceptor],
});
```

Multiple interceptors compose like middleware: the first one in the array is the outermost wrapper, and each calls `next(interception)` to delegate inward. Registration order matters---put tracing first so it measures everything that happens inside, and put validation near the inside so it runs after logging has already captured the attempt. See the [interceptors guide](./interceptors.md) for the full composition model and the workflow-side counterparts.

> [!NOTE]
> If you pass zero interceptors (or omit the option entirely), the worker skips the composition path and calls your activity function directly. There's no overhead for workers that don't need instrumentation.

## Heartbeats

The `HeartbeatManager` sends periodic keep-alive messages (every 10 seconds by default) to prevent the server from considering the worker dead. It starts after the server acknowledges registration and stops on disconnect.

```typescript partial
// Internally, the worker does:
this.#heartbeat = new HeartbeatManager(() => {
  this.#sendMessage({ type: 'heartbeat', workerId: this.#options.workerId });
}, 10_000);
```

The `HeartbeatManager` is a simple interval wrapper with `start()`, `stop()`, and a `beat(details?)` method for one-off heartbeats with optional payload. The server's `WorkerRegistry` updates the worker's `lastHeartbeat` timestamp on each heartbeat.

## Queue-based routing

Workers register with a queue name. The server's `WorkerRegistry.findWorker()` uses **least-loaded routing**---it picks the worker with the lowest in-flight count among those that handle the requested activity and have available capacity.

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

Workers inside the server's reconnect grace window are temporarily excluded from routing by `serve()` so new tasks prefer eligible peers instead of landing on a socket that just closed. The grace window is configured with `serve({ workerReconnectGracePeriodMs })`; it defaults to `100` ms, is clamped to `0..5000`, and `0` disables the grace path for immediate requeue behavior.

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

- `register(info)` --- add a worker when it connects
- `unregister(workerId)` --- remove a worker, returns its info for task reassignment
- `heartbeat(workerId)` --- update last heartbeat timestamp
- `taskAssigned(workerId)` / `taskCompleted(workerId)` --- track in-flight counts
- `findWorker(activityName, options?)` --- least-loaded routing
- `assignTask(workerId, operationId, visibilityTimeout)` --- track task with deadline
- `checkExpiredTasks(now)` --- find tasks whose visibility timeout has expired
- `extendVisibility(operationId, extension)` --- extend a task's deadline (heartbeat-driven)
- `isAssignedToWorker(operationId, workerId)` --- trust-boundary ownership check for task results

The `checkExpiredTasks()` method returns tasks that have exceeded their visibility timeout, enabling the server to reassign them to other workers. When a task has been reassigned to a different worker, a late `taskResult` from the displaced worker is rejected with `protocolError` and ignored. In v1 this guard is keyed by `(operationId, workerId)`, so a stale completion from the same `workerId` on a later attempt still requires a future protocol revision with an attempt token on the wire.

## Long-poll fallback

Not every environment supports WebSockets. The `LongPollWorker` provides the same functionality over plain HTTP requests.

```typescript
import { LongPollWorker } from 'weft';

const worker = new LongPollWorker({
  serverUrl: 'http://weft-server:7233',
  activities: {
    transcribe: async (input) => {
      /* ... */
    },
  },
  concurrency: 5,
  queue: 'gpu',
  pollTimeout: 30_000, // how long each poll request blocks
});

worker.start();
```

The long-poll worker runs a loop: it `POST`s to `/poll` with its activity list and queue, blocks for up to `pollTimeout` milliseconds waiting for a task, executes it, and `POST`s the result to `/complete`. It respects the concurrency limit by pausing the poll loop when all slots are in use.

Error handling is built in---network failures trigger a 1-second backoff, abort errors during shutdown are suppressed.

## Graceful shutdown

Both worker types support graceful shutdown. The `RemoteWorker` drains in-flight tasks before closing the WebSocket:

```typescript partial
await worker.disconnect();
```

The server can also initiate shutdown by sending a `{ type: 'shutdown' }` message. The worker stops accepting new tasks, waits for in-flight work to complete, then closes.

Both classes implement `Disposable` for use with `using`:

```typescript partial
{
  using worker = new RemoteWorker(options);
  await worker.connect();
  // Worker runs...
} // Automatically cleaned up
```

The `connected`, `inFlight`, and `shuttingDown` properties let you monitor worker status for health checks and dashboards.
