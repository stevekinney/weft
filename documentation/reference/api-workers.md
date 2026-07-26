# Workers API Reference

The workers module provides both in-process worker pools (Web Workers for CPU isolation) and remote worker clients for distributed activity execution. In-process pools live in `src/workers/`; remote workers that connect over WebSocket or HTTP long-poll live in `src/worker/`.

For a guided walkthrough, see the [Remote Workers guide](../guides/remote-workers.md).

---

## In-Process Workers

### `WorkerPool`

A bounded pool of Bun Web Workers with acquire/release semantics. Implements both `Disposable` (immediate termination) and `AsyncDisposable` (graceful shutdown -- waits for in-flight workers to be released before terminating).

```ts partial
class WorkerPool implements Disposable, AsyncDisposable {
  constructor(options: WorkerPoolOptions);

  async acquire(): Promise<Worker>;
  release(worker: Worker): void;

  get availableCount(): number;
  get totalCount(): number;
  get pendingCount(): number;

  [Symbol.dispose](): void;
  async [Symbol.asyncDispose](): Promise<void>;
}
```

| Method / Property         | Returns           | Description                                                                                 |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `acquire()`               | `Promise<Worker>` | Acquire a worker. Blocks if at capacity. Throws if disposed.                                |
| `release(worker)`         | `void`            | Return a worker to the pool. Hands directly to the next queued requester if one is waiting. |
| `availableCount`          | `number`          | Workers currently idle in the pool                                                          |
| `totalCount`              | `number`          | Total workers created (idle + in-flight)                                                    |
| `pendingCount`            | `number`          | Queued `acquire()` calls waiting for a worker                                               |
| `[Symbol.dispose]()`      | `void`            | Immediate termination -- terminates all workers                                             |
| `[Symbol.asyncDispose]()` | `Promise<void>`   | Graceful shutdown -- waits for in-flight workers, then terminates                           |

#### `WorkerPoolOptions`

| Field         | Type            | Default | Description                                               |
| ------------- | --------------- | ------- | --------------------------------------------------------- |
| `concurrency` | `number`        | --      | Maximum number of concurrent workers                      |
| `workerUrl`   | `string \| URL` | --      | URL of the worker script                                  |
| `smol`        | `boolean`       | `false` | Use Bun's `smol` worker mode for reduced memory footprint |

**Example:**

```ts partial
import { WorkerPool } from '@lostgradient/weft';

await using pool = new WorkerPool({
  concurrency: 4,
  workerUrl: new URL('./activity-worker.ts', import.meta.url),
});

const worker = await pool.acquire();
worker.postMessage({ type: 'run', payload: data });
// ... wait for result ...
pool.release(worker);
// pool is automatically disposed when scope exits
```

### `executeActivity(request, activityFunction, signal?)`

Execute an activity function with error handling and abort support. Returns a structured result indicating success or failure.

```ts partial
async function executeActivity(
  request: ActivityExecutionRequest,
  activityFunction: (...arguments_: unknown[]) => unknown,
  signal?: AbortSignal,
): Promise<ActivityExecutionResult>;
```

#### `ActivityExecutionRequest`

```ts
interface ActivityExecutionRequest {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt: number;
}
```

#### `ActivityExecutionResult`

```ts
interface ActivityExecutionResult {
  operationId: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
}
```

If `signal` is already aborted when called, returns a failed result immediately without invoking the function.

---

## Remote Workers

### `RemoteWorker`

WebSocket-based remote worker client. Connects to the Weft server, sends a v2 registration, waits for `registerAck`, and then processes tasks dispatched by the server. Implements `Disposable`.

```ts partial
class RemoteWorker implements Disposable {
  constructor(options: RemoteWorkerOptions);

  async connect(): Promise<void>;
  async disconnect(): Promise<void>;

  get inFlight(): number;
  get connected(): boolean;
  get shuttingDown(): boolean;

  [Symbol.dispose](): void;
}
```

| Method / Property    | Returns         | Description                                                                                |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `connect()`          | `Promise<void>` | Open the WebSocket, register with the server, wait for `registerAck`, and start processing |
| `disconnect()`       | `Promise<void>` | Graceful shutdown -- finish in-flight tasks, then close                                    |
| `inFlight`           | `number`        | Number of tasks currently being executed                                                   |
| `connected`          | `boolean`       | Whether the WebSocket is open                                                              |
| `shuttingDown`       | `boolean`       | Whether a graceful shutdown is in progress                                                 |
| `[Symbol.dispose]()` | `void`          | Immediate shutdown -- abort all listeners and close                                        |

#### `RemoteWorkerOptions`

| Field                 | Type                                                                                                                                  | Default               | Description                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`           | `string`                                                                                                                              | --                    | WebSocket URL of the Weft server                                                                                                                                                                                                                |
| `workerId`            | `string`                                                                                                                              | `crypto.randomUUID()` | Unique worker identifier                                                                                                                                                                                                                        |
| `workflows`           | `Record<string, { name: string; activities: Record<string, (input: unknown, context?: RemoteActivityContext) => Promise<unknown>> }>` | (required)            | Maps each workflow type to its activity implementations; the SDK advertises each as `${workflowType}.${activityName}` and validates the key matches `workflow.name`. Activities may accept an optional `RemoteActivityContext` second parameter |
| `concurrency`         | `number`                                                                                                                              | `10`                  | Maximum concurrent tasks                                                                                                                                                                                                                        |
| `queue`               | `string`                                                                                                                              | `'default'`           | Task queue to subscribe to                                                                                                                                                                                                                      |
| `disconnectTimeoutMs` | `number`                                                                                                                              | `30_000`              | Time to wait for in-flight tasks before force-closing on disconnect                                                                                                                                                                             |
| `interceptors`        | `ActivityInterceptor[]`                                                                                                               | `[]`                  | Activity interceptors applied to all tasks processed by this worker                                                                                                                                                                             |
| `deploymentName`      | `string`                                                                                                                              | --                    | Operator-defined deployment group reported during registration                                                                                                                                                                                  |
| `buildId`             | `string`                                                                                                                              | --                    | Build or release identifier reported during registration                                                                                                                                                                                        |
| `runtimeVersion`      | `string`                                                                                                                              | --                    | Runtime or SDK version reported during registration                                                                                                                                                                                             |
| `gitSha`              | `string`                                                                                                                              | --                    | Source revision reported during registration                                                                                                                                                                                                    |
| `startedAt`           | `number`                                                                                                                              | `Date.now()`          | Worker process start time in epoch milliseconds                                                                                                                                                                                                 |
| `capabilities`        | `Record<string, JSON value>`                                                                                                          | `{}`                  | JSON metadata such as region, hardware class, or feature flags                                                                                                                                                                                  |

The worker sends heartbeats every 10 seconds after registration is acknowledged and handles server-initiated `shutdown` messages gracefully. `connect()` rejects if the server sends `registerError` or if the socket closes before acknowledgement.

**Example:**

```ts
import { RemoteWorker } from '@lostgradient/weft';

const worker = new RemoteWorker({
  serverUrl: 'ws://localhost:7233/api/v1/tasks/default/stream',
  workflows: {
    notifications: {
      name: 'notifications',
      activities: {
        sendEmail: async (input) => {
          /* ... */
        },
        processImage: async (input) => {
          /* ... */
        },
      },
    },
  },
  concurrency: 5,
});

await worker.connect();
// Worker is now processing tasks...

// Later, graceful shutdown:
await worker.disconnect();
```

---

### `HeartbeatManager`

Manages periodic heartbeat signals for keeping visibility timeouts alive.

```ts partial
class HeartbeatManager {
  constructor(
    sendHeartbeat: (details?: unknown) => void,
    intervalMs?: number, // default: 10_000
  );

  start(): void;
  stop(): void;
  beat(details?: unknown): void;

  get isRunning(): boolean;
}
```

| Method           | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `start()`        | Begin sending periodic heartbeats. No-op if already running. |
| `stop()`         | Stop the periodic interval.                                  |
| `beat(details?)` | Send a one-off heartbeat with optional details payload.      |

---

### `LongPollWorker`

HTTP long-poll fallback for environments without WebSocket support. Polls the server's `/poll` endpoint for tasks and reports results via `/complete`. Implements `Disposable`.

```ts partial
class LongPollWorker implements Disposable {
  constructor(options: LongPollWorkerOptions);

  start(): void;
  async stop(): Promise<void>;

  get inFlight(): number;
  get running(): boolean;

  [Symbol.dispose](): void;
}
```

#### `LongPollWorkerOptions`

| Field         | Type                                                   | Default     | Description                      |
| ------------- | ------------------------------------------------------ | ----------- | -------------------------------- |
| `serverUrl`   | `string`                                               | --          | Base HTTP URL of the Weft server |
| `activities`  | `Record<string, (input: unknown) => Promise<unknown>>` | --          | Activity functions               |
| `concurrency` | `number`                                               | `10`        | Maximum concurrent tasks         |
| `queue`       | `string`                                               | `'default'` | Task queue                       |
| `pollTimeout` | `number`                                               | `30_000`    | Long-poll timeout in ms          |

**Example:**

```ts
import { LongPollWorker } from '@lostgradient/weft';

const worker = new LongPollWorker({
  serverUrl: 'http://localhost:7233',
  activities: {
    sendEmail: async (input) => {
      /* ... */
    },
  },
});

worker.start();
// Later:
await worker.stop();
```

---

### `WorkerRegistry`

Server-side worker tracking and least-loaded routing. The server uses this to track connected workers, assign tasks, and detect expired visibility timeouts.

```ts partial
class WorkerRegistry {
  constructor(options?: WorkerRegistryOptions);

  register(info: Omit<WorkerInfo, 'connectedAt' | 'lastHeartbeat' | 'inFlight'>): void;
  unregister(workerId: string): WorkerInfo | undefined;
  heartbeat(workerId: string): void;

  taskAssigned(workerId: string): void;
  taskCompleted(workerId: string): void;
  findWorker(activityName: string, options?: RoutingOptions): WorkerInfo | undefined;
  markWorkerDraining(
    workerId: string,
    options?: WorkerDrainOptions,
  ): WorkerDrainMutationResult | undefined;
  clearWorkerDrain(workerId: string): WorkerDrainMutationResult | undefined;
  markDeploymentDraining(
    deploymentName: string,
    options?: WorkerDrainOptions,
  ): WorkerDrainMutationResult;
  clearDeploymentDrain(deploymentName: string): WorkerDrainMutationResult;

  assignTask(workerId: string, operationId: string, visibilityTimeout: number): void;
  checkExpiredTasks(now: number): InFlightTask[];
  extendVisibility(operationId: string, extension: number): number | undefined;
  isAssignedToWorker(operationId: string, workerId: string): boolean;

  getAll(): WorkerInfo[];
  getWorkerSummaries(now: number): WorkerSummary[];
  getDeploymentSummaries(now: number): WorkerDeploymentSummary[];
  get size(): number;
}
```

#### `WorkerRegistryOptions`

```ts partial
interface WorkerRegistryOptions {
  policy?: RoutingPolicy;
}
```

| Field    | Type            | Default          | Description                    |
| -------- | --------------- | ---------------- | ------------------------------ |
| `policy` | `RoutingPolicy` | `'least-loaded'` | Worker routing policy to apply |

#### `WorkerInfo`

```ts
interface WorkerInfo {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
  startedAt: number;
  capabilities: Record<string, unknown>;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  gitSha?: string;
}
```

#### `RoutingOptions`

```ts
interface RoutingOptions {
  sticky?: string; // preferred worker ID for cache locality
  queue?: string;
  fairShareKey?: string; // key used for fair-share routing policy
}
```

`findWorker()` applies the configured `RoutingPolicy` (least-loaded by default; supports `'round-robin'` and `'fair-share'`). It filters workers that can handle the activity and have capacity. For `'least-loaded'`, it returns the worker with the lowest `inFlight` count. If `sticky` is set and that worker has capacity, it is preferred.

Draining workers are excluded from `findWorker()` so no new tasks are assigned to them. `serve()` also excludes workers currently inside the reconnect grace window before routing new work. In-flight tasks remain tracked and finish normally, expire through the existing visibility timeout path, or requeue through the existing disconnection/shutdown path.

`isAssignedToWorker(operationId, workerId)` returns whether an in-flight task is currently owned by a specific worker. The server checks it before accepting `taskResult` frames so stale completions from a displaced worker are rejected instead of mutating engine state.

#### `WorkerDrainOptions`

```ts
interface WorkerDrainOptions {
  reason?: string;
  updatedAt?: number;
}
```

`updatedAt` records the drain start time in epoch milliseconds. When omitted, the registry uses `Date.now()`.

#### `InFlightTask`

```ts
interface InFlightTask {
  operationId: string;
  workerId: string;
  deadline: number; // absolute timestamp
  visibilityTimeout: number;
  fairShareKey?: string;
}
```

`checkExpiredTasks(now)` returns tasks whose visibility deadline has passed, suitable for reassignment.

## Fleet and queue observability

Two operator-facing endpoints expose the live worker fleet and the
in-memory task queue state. Both require the `system:read` scope.
Workers and task queues are server-wide infrastructure.

The read operations are reachable over
[JSON-RPC](https://www.jsonrpc.org/specification)
([HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP),
[WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API),
[stdio](https://en.wikipedia.org/wiki/Standard_streams)) as
[`weft.workers.list`](#get-apiv1workers) and
[`weft.task.queues.list`](#get-apiv1task-queues). They take no input parameters.

### `GET /api/v1/workers`

Returns every connected worker with its queue assignment, advertised
activities, concurrency, in-flight count, available capacity, connect
time, last heartbeat, heartbeat age, deployment identity, capabilities,
start time, and drain health. The top-level `routingPolicy` field reports
the routing strategy the server was configured with. The top-level
`deployments` field groups connected workers by reported deployment
identity and summarizes active, draining, and drained workers.

The server snapshots `Date.now()` exactly once per request, so every
`heartbeatAgeMs` in the response is consistent.

```ts
type WorkerHealth = 'active' | 'draining' | 'drained';

type ListWorkersResponse = {
  items: Array<{
    id: string;
    queue: string;
    activities: string[];
    concurrency: number;
    inFlight: number;
    availableCapacity: number; // max(0, concurrency - inFlight)
    connectedAt: number; // epoch ms
    lastHeartbeatAt: number; // epoch ms
    heartbeatAgeMs: number; // now - lastHeartbeatAt at snapshot time
    startedAt: number; // epoch ms
    capabilities: Record<string, unknown>;
    health: WorkerHealth;
    deploymentName?: string;
    buildId?: string;
    runtimeVersion?: string;
    gitSha?: string;
  }>;
  deployments: Array<{
    deploymentName: string | null;
    buildId: string | null;
    runtimeVersion: string | null;
    gitSha: string | null;
    health: WorkerHealth;
    workers: number;
    activeWorkers: number;
    drainingWorkers: number;
    drainedWorkers: number;
    inFlight: number;
    oldestStartedAt: number | null;
  }>;
  routingPolicy: 'least-loaded' | 'round-robin' | 'fair-share';
};
```

Workers are sorted by `id` ascending.

`health` is derived from drain state and in-flight work:

- `active`: the worker is eligible for new assignments.
- `draining`: drain state is set and the worker still has in-flight tasks.
- `drained`: drain state is set and the worker has no in-flight tasks.

### `POST /api/v1/workers/:workerId/drain`

Marks a connected worker as draining. Requires `system:admin`. The optional
JSON request body may include a non-empty `reason`.

```json
{ "reason": "maintenance" }
```

Response:

```ts
type WorkerDrainResponse = {
  target: 'worker';
  workerId: string;
  affectedWorkers: 1;
  inFlight: number;
  health: WorkerHealth;
};
```

The JSON-RPC operation name is `weft.workers.drain`.

### `DELETE /api/v1/workers/:workerId/drain`

Clears the explicit drain marker for one worker. Requires `system:admin`.
If a deployment-level drain still applies, the worker remains drained by
that deployment.

The JSON-RPC operation name is `weft.workers.resume`.

### `POST /api/v1/worker-deployments/:deploymentName/drain`

Marks every current and future worker that reports `deploymentName` as
draining. Requires `system:admin`. The optional JSON request body may
include a non-empty `reason`.

Response:

```ts
type DeploymentDrainResponse = {
  target: 'deployment';
  deploymentName: string;
  affectedWorkers: number;
  inFlight: number;
  health: WorkerHealth;
};
```

The JSON-RPC operation name is `weft.worker.deployments.drain`.

### `DELETE /api/v1/worker-deployments/:deploymentName/drain`

Clears the deployment-level drain marker. Requires `system:admin`. Any
worker-specific drain markers remain in effect.

The JSON-RPC operation name is `weft.worker.deployments.resume`.

### `GET /api/v1/task-queues`

Returns per-queue health. The queue set is the union of three sources:

1. Queues with one or more pending tasks.
2. Queues with one or more parked long-poll waiters.
3. Queues that have at least one connected worker (so an idle queue with
   capacity but no work still appears).

`inFlight` is summed across the workers currently assigned to that
queue. `connectedWorkers` counts workers whose `queue` matches.

```ts
type ListTaskQueuesResponse = {
  items: Array<{
    queue: string;
    backlog: number; // pending tasks
    oldestEnqueuedAt: number | null; // epoch ms, null if backlog == 0
    oldestQueuedAgeMs: number | null;
    waitingPollers: number;
    schedulingPolicy: 'priority' | 'fifo' | 'lifo';
    inFlight: number;
    connectedWorkers: number;
  }>;
};
```

Queues are sorted by `queue` ascending.
