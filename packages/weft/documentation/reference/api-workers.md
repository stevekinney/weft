# Workers API Reference

The workers module provides both in-process worker pools (Web Workers for CPU isolation) and remote worker clients for distributed activity execution. In-process pools live in `src/workers/`; remote workers that connect over WebSocket or HTTP long-poll live in `src/worker/`.

For a guided walkthrough, see the [Remote Workers guide](../guides/remote-workers.md).

## In-Process Workers

### `WorkerPool`

A bounded pool of Bun Web Workers with acquire/release semantics. Implements both `Disposable` (immediate termination) and `AsyncDisposable` (graceful shutdown -- waits for in-flight workers to be released before terminating).

```ts
import { WorkerPool, type WorkerPoolOptions } from '@lostgradient/weft';

// The documented surface; assigning the real class checks it still matches.
type WorkerPoolSurface = Disposable &
  AsyncDisposable & {
    acquire(): Promise<Worker>;
    release(worker: Worker): void;
    readonly availableCount: number;
    readonly totalCount: number;
    readonly pendingCount: number;
  };

const WorkerPoolClass: new (options: WorkerPoolOptions) => WorkerPoolSurface = WorkerPool;
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

### `WorkerPoolOptions`

| Field         | Type            | Default | Description                                               |
| ------------- | --------------- | ------- | --------------------------------------------------------- |
| `concurrency` | `number`        | --      | Maximum number of concurrent workers                      |
| `workerUrl`   | `string \| URL` | --      | URL of the worker script                                  |
| `smol`        | `boolean`       | `false` | Use Bun's `smol` worker mode for reduced memory footprint |

**Example:**

```ts
import { WorkerPool } from '@lostgradient/weft';

declare const data: unknown;

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

```ts
import {
  executeActivity,
  type ActivityExecutionRequest,
  type ActivityExecutionResult,
} from '@lostgradient/weft';

const execute: (
  request: ActivityExecutionRequest,
  activityFunction: (...arguments_: unknown[]) => unknown,
  signal?: AbortSignal,
) => Promise<ActivityExecutionResult> = executeActivity;

const result = await execute(
  { operationId: 'op-1', activityName: 'greet', input: 'World', attempt: 1 },
  async (input) => `Hello, ${String(input)}!`,
);
console.log(result.status); // 'completed'
```

### `ActivityExecutionRequest`

```ts
import type { ActivityExecutionRequest } from '@lostgradient/weft';

const request: ActivityExecutionRequest = {
  operationId: 'op-1',
  activityName: 'greet',
  input: { name: 'World' },
  attempt: 1,
  workflowExecutionToken: 'run-token', // optional: the dispatching run's token
  activityAttemptToken: 'attempt-token', // optional: this dispatch's attempt token
};
```

### `ActivityExecutionResult`

```ts
import type { ActivityExecutionResult } from '@lostgradient/weft';

const completed: ActivityExecutionResult = {
  operationId: 'op-1',
  status: 'completed',
  value: 'Hello, World!',
};

const failed: ActivityExecutionResult = {
  operationId: 'op-1',
  status: 'failed',
  error: 'Activity "greet" aborted before execution',
  errorName: 'AbortError', // error constructor name, used by retry classification
};
```

If `signal` is already aborted when called, returns a failed result immediately without invoking the function.

## Remote Workers

### `RemoteWorker`

WebSocket-based remote worker client. Connects to the Weft server, sends a v8 registration, waits for `registerAck`, and then processes tasks dispatched by the server. Implements `Disposable`.

```ts
import { RemoteWorker, type RemoteWorkerOptions } from '@lostgradient/weft';

// The documented surface; assigning the real class checks it still matches.
type RemoteWorkerSurface = Disposable & {
  connect(): Promise<void>;
  disconnect(): Promise<{ unacknowledgedResults: number }>;
  readonly inFlight: number;
  readonly connected: boolean;
  readonly shuttingDown: boolean;
  readonly unacknowledgedResultCount: number;
};

const RemoteWorkerClass: new (options: RemoteWorkerOptions) => RemoteWorkerSurface = RemoteWorker;
```

| Method / Property           | Returns                                      | Description                                                                                                                                                            |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                 | `Promise<void>`                              | Open the WebSocket, register with the server, wait for `registerAck`, and start processing                                                                             |
| `disconnect()`              | `Promise<{ unacknowledgedResults: number }>` | Graceful shutdown -- finish in-flight tasks, then close. Resolves with the number of buffered results still awaiting a `taskResultAck` (COR-240, v4)                   |
| `inFlight`                  | `number`                                     | Number of tasks currently being executed                                                                                                                               |
| `connected`                 | `boolean`                                    | Whether the WebSocket is open                                                                                                                                          |
| `shuttingDown`              | `boolean`                                    | Whether a graceful shutdown is in progress                                                                                                                             |
| `unacknowledgedResultCount` | `number`                                     | Number of buffered results still awaiting a `taskResultAck` (COR-240, v4)                                                                                              |
| `[Symbol.dispose]()`        | `void`                                       | Immediate shutdown -- abort all listeners and close. Unlike `disconnect()`, this discards any unacknowledged results rather than preserving them for a later reconnect |

### `RemoteWorkerOptions`

| Field                 | Type                                                                                                                                  | Default               | Description                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`           | `string`                                                                                                                              | --                    | WebSocket URL of the Weft server                                                                                                                                                                                                                                                                    |
| `workerId`            | `string`                                                                                                                              | `crypto.randomUUID()` | Unique worker identifier                                                                                                                                                                                                                                                                            |
| `workflows`           | `Record<string, { name: string; activities: Record<string, (input: unknown, context?: RemoteActivityContext) => Promise<unknown>> }>` | (required)            | Maps each workflow type to its activity implementations; the SDK advertises each as `${workflowType}.${activityName}` and validates the key matches `workflow.name`. Activities may accept an optional `RemoteActivityContext` second parameter                                                     |
| `concurrency`         | `number`                                                                                                                              | `10`                  | Maximum concurrent tasks                                                                                                                                                                                                                                                                            |
| `queue`               | `string`                                                                                                                              | `'default'`           | Task queue to subscribe to. Conflicts with a `serverUrl` that already encodes a different queue throw at construction time                                                                                                                                                                          |
| `disconnectTimeoutMs` | `number`                                                                                                                              | `30_000`              | Time to wait for in-flight tasks before force-closing on disconnect                                                                                                                                                                                                                                 |
| `interceptors`        | `ActivityInterceptor[]`                                                                                                               | `[]`                  | Activity interceptors applied to all tasks processed by this worker                                                                                                                                                                                                                                 |
| `deploymentName`      | `string`                                                                                                                              | (required)            | Logical service this worker instance belongs to, included in its manifest                                                                                                                                                                                                                           |
| `buildId`             | `string`                                                                                                                              | (required)            | Operator-visible release this worker instance is running, included in its manifest                                                                                                                                                                                                                  |
| `artifactDigest`      | `string`                                                                                                                              | derived               | Trusted digest of the executable artifact. When omitted, a placeholder tagged `declared-shape:<hash>` is derived from the declared workflow and activity names. Ignored when `manifest` is supplied                                                                                                 |
| `manifest`            | `WorkerManifest`                                                                                                                      | derived               | A complete, real manifest—typically from [`buildWorkerManifestFromRegistry`](#buildworkermanifestfromregistryengine-options)—advertised verbatim instead of the `declared-shape:` placeholder. `manifest.workflows` must declare exactly the workflow types in `workflows`, checked at construction |
| `runtimeName`         | `string`                                                                                                                              | `'unknown'`           | Runtime name reported in the manifest, such as `'bun'` or `'node'`. The worker does not inspect its host, so the caller declares it. Ignored when `manifest` is supplied                                                                                                                            |
| `runtimeVersion`      | `string`                                                                                                                              | `'unknown'`           | Runtime or SDK version reported during registration                                                                                                                                                                                                                                                 |
| `startedAt`           | `number`                                                                                                                              | `Date.now()`          | Worker process start time in epoch milliseconds                                                                                                                                                                                                                                                     |
| `capabilities`        | `Record<string, JSON value>`                                                                                                          | `{}`                  | JSON metadata such as region, hardware class, or feature flags                                                                                                                                                                                                                                      |

The worker sends heartbeats every 10 seconds after registration is acknowledged and handles server-initiated `shutdown` messages gracefully. `connect()` rejects if the server sends `registerError` or if the socket closes before acknowledgement.

**Example:**

```ts
import { RemoteWorker } from '@lostgradient/weft';

const worker = new RemoteWorker({
  serverUrl: 'ws://localhost:7233/api/v1/tasks/default/stream',
  deploymentName: 'notifications',
  buildId: '2026.08.19-1',
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

### `HeartbeatManager`

Manages periodic heartbeat signals for keeping visibility timeouts alive.

```ts
import { HeartbeatManager } from '@lostgradient/weft';

const heartbeat = new HeartbeatManager(
  (details?: unknown) => console.log('heartbeat', details),
  10_000, // intervalMs, default: 10_000
);

heartbeat.start();
heartbeat.beat({ progress: 0.5 });
console.log(heartbeat.isRunning); // true
heartbeat.stop();
```

| Method           | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `start()`        | Begin sending periodic heartbeats. No-op if already running. |
| `stop()`         | Stop the periodic interval.                                  |
| `beat(details?)` | Send a one-off heartbeat with optional details payload.      |

### `RemoteActivityContext`

The optional second parameter every worker-executed activity function receives, on both `RemoteWorker` and `LongPollWorker`. Shared by both worker classes so an activity function does not need to know which transport dispatched it.

```ts
import type { RemoteActivityContext } from '@lostgradient/weft';

const context: RemoteActivityContext = {
  signal: new AbortController().signal,
  workflowExecutionToken: 'run-token',
  activityAttemptToken: 'attempt-token',
  heartbeat: (details?: unknown) => console.log(details),
  lastHeartbeatDetails: { done: 3 },
};
```

| Field                    | Type                          | Description                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`                 | `AbortSignal`                 | Fires when the server requests cancellation of this attempt. `signal.reason` (COR-223) carries the durably recorded, operator-supplied cancellation reason as a string when the signal was aborted by a server `cancel`; a signal aborted by shutdown, `dispose()`, or a drain timeout carries no string reason.                            |
| `workflowExecutionToken` | `string \| undefined`         | Durable per-run token for the workflow that dispatched this activity, when known.                                                                                                                                                                                                                                                           |
| `activityAttemptToken`   | `string \| undefined`         | The per-dispatch attempt token echoed from the `task` frame.                                                                                                                                                                                                                                                                                |
| `heartbeat`              | `(details?: unknown) => void` | Record heartbeat progress for this attempt (COR-226) — the SAME public shape as the inline engine's `ActivityContext.heartbeat()`, not a second heartbeat API. Sends `details` on the wire immediately, in addition to the worker's automatic per-attempt keepalive. `details` must be JSON-serializable and within `payloadSize.maxBytes`. |
| `lastHeartbeatDetails`   | `unknown`                     | The heartbeat details a PRIOR attempt of this operation recorded before being redispatched, or `undefined` when none exists — mirrors `ActivityContext.lastHeartbeatDetails`'s resumable-batch pattern for worker-executed activities.                                                                                                      |

### `LongPollWorker`

HTTP long-poll fallback for environments without WebSocket support. Registers the same canonical worker manifest as the WebSocket transport, receives a server-issued session token, then polls `/api/v1/worker-sessions/:sessionId/tasks` and reports durable results through `/api/v1/worker-sessions/:sessionId/results` with `Weft-Worker-Session-Token` on every continuation request. Implements `Disposable`.

```ts
import { LongPollWorker, type LongPollWorkerOptions } from '@lostgradient/weft';

// The documented surface; assigning the real class checks it still matches.
type LongPollWorkerSurface = Disposable & {
  start(): void;
  stop(): Promise<{ unacknowledgedResults: number }>;
  readonly inFlight: number;
  readonly running: boolean;
  readonly unacknowledgedResultCount: number;
};

const LongPollWorkerClass: new (options: LongPollWorkerOptions) => LongPollWorkerSurface =
  LongPollWorker;
```

| Method / Property           | Returns                                      | Description                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                   | `void`                                       | Start polling for tasks, and (COR-235) resume delivery of any result still buffered from a previous `stop()`                                                                                                                                      |
| `stop()`                    | `Promise<{ unacknowledgedResults: number }>` | Stop polling, wait for in-flight activities up to `disconnectTimeoutMs`, then suspend result delivery. Resolves with the number of buffered results still awaiting a durable disposition -- mirrors `RemoteWorker.disconnect()`'s identical shape |
| `inFlight`                  | `number`                                     | Number of activities currently executing                                                                                                                                                                                                          |
| `running`                   | `boolean`                                    | Whether the poll loop is active                                                                                                                                                                                                                   |
| `unacknowledgedResultCount` | `number`                                     | Number of buffered results still awaiting an `applied`/`duplicate`/`dead-lettered` disposition (COR-235) -- mirrors `RemoteWorker`'s identical getter                                                                                             |
| `[Symbol.dispose]()`        | `void`                                       | Immediate shutdown -- stop polling and abort in-flight activities. Unlike `stop()`, this discards any unacknowledged results rather than preserving them for a later `start()`                                                                    |

### `LongPollWorkerOptions`

| Field                    | Type                                                                                                                                  | Default     | Description                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`              | `string`                                                                                                                              | --          | Base HTTP URL of the Weft server                                                                                                                                                                                                             |
| `workflows`              | `Record<string, { name: string; activities: Record<string, (input: unknown, context?: RemoteActivityContext) => Promise<unknown>> }>` | --          | Required workflow map used to derive the canonical worker manifest and qualified activity names                                                                                                                                              |
| `deploymentName`         | `string`                                                                                                                              | --          | Logical deployment advertised in the worker manifest                                                                                                                                                                                         |
| `buildId`                | `string`                                                                                                                              | --          | Operator-visible build advertised in the worker manifest                                                                                                                                                                                     |
| `concurrency`            | `number`                                                                                                                              | `10`        | Maximum concurrent tasks                                                                                                                                                                                                                     |
| `queue`                  | `string`                                                                                                                              | `'default'` | Task queue                                                                                                                                                                                                                                   |
| `pollTimeout`            | `number`                                                                                                                              | `30_000`    | Long-poll timeout in ms                                                                                                                                                                                                                      |
| `heartbeatIntervalMs`    | `number`                                                                                                                              | `10_000`    | Per-activity heartbeat interval (COR-230) — see [Long-poll fallback](../guides/remote-workers.md#long-poll-fallback).                                                                                                                        |
| `disconnectTimeoutMs`    | `number`                                                                                                                              | `30_000`    | Bound on how long `stop()` waits for in-flight activities to finish after aborting them (COR-220) — matches `RemoteWorker`'s identical bound. A non-cooperative activity that ignores its `AbortSignal` cannot hold `stop()` open past this. |
| `resultRetryBaseDelayMs` | `number`                                                                                                                              | `1_000`     | Delay before the first retry of a result POST that failed or was transiently rejected (COR-235) — see [Result delivery and acknowledgement](../guides/remote-workers.md#result-delivery-and-acknowledgement).                                |
| `resultRetryMaxDelayMs`  | `number`                                                                                                                              | `30_000`    | Upper bound the result-retry delay backs off to (COR-235).                                                                                                                                                                                   |

**Example:**

```ts
import { LongPollWorker } from '@lostgradient/weft';

const worker = new LongPollWorker({
  serverUrl: 'http://localhost:7233',
  deploymentName: 'notifications-worker',
  buildId: '2026-09-28',
  workflows: {
    notifications: {
      name: 'notifications',
      activities: {
        sendEmail: async (input) => {
          /* ... */
        },
      },
    },
  },
});

worker.start();
// Later:
await worker.stop();
```

### `WorkerRegistry`

Server-side worker tracking and least-loaded routing. The server uses this to track connected workers, assign tasks, and detect expired visibility timeouts.

```ts
import {
  WorkerRegistry,
  type InFlightTask,
  type RoutingOptions,
  type WorkerInfo,
} from '@lostgradient/weft';

type WorkerRegistryOptions = ConstructorParameters<typeof WorkerRegistry>[0];
type WorkerRegistrationInfo = Parameters<WorkerRegistry['register']>[0];
type WorkerDrainOptions = Parameters<WorkerRegistry['markWorkerDraining']>[1];
type WorkerDrainMutationResult = ReturnType<WorkerRegistry['markDeploymentDraining']>;
type WorkerSummary = ReturnType<WorkerRegistry['getWorkerSummaries']>[number];
type WorkerDeploymentSummary = ReturnType<WorkerRegistry['getDeploymentSummaries']>[number];

// The documented surface; assigning the real class checks it still matches.
type WorkerRegistrySurface = {
  register(info: WorkerRegistrationInfo): void;
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

  assignTask(
    workerId: string,
    operationId: string,
    visibilityTimeout: number,
    fairShareKey: string | undefined,
    attemptToken: string,
    workflowRevision?: string,
  ): void;
  checkExpiredTasks(now: number): InFlightTask[];
  extendVisibility(operationId: string, extension: number): number | undefined;
  isAssignedToWorker(operationId: string, workerId: string): boolean;
  isAssignedToAttempt(operationId: string, workerId: string, attemptToken: string): boolean;

  getAll(): WorkerInfo[];
  getWorkerSummaries(now: number): WorkerSummary[];
  getDeploymentSummaries(now: number): WorkerDeploymentSummary[];
  readonly size: number;
};

const WorkerRegistryClass: new (options?: WorkerRegistryOptions) => WorkerRegistrySurface =
  WorkerRegistry;
```

### `WorkerRegistryOptions`

```ts
import { WorkerRegistry, type RoutingPolicy } from '@lostgradient/weft';

const policy: RoutingPolicy = 'least-loaded';
const registry = new WorkerRegistry({ policy });
console.log(registry.policy); // 'least-loaded'
```

| Field    | Type            | Default          | Description                    |
| -------- | --------------- | ---------------- | ------------------------------ |
| `policy` | `RoutingPolicy` | `'least-loaded'` | Worker routing policy to apply |

### `WorkerInfo`

```ts
import type { WorkerInfo, WorkerManifest } from '@lostgradient/weft';

declare const manifest: WorkerManifest;

const worker: WorkerInfo = {
  id: 'worker-1',
  queue: 'default',
  transport: 'websocket', // or 'long-poll'
  activities: ['checkout.charge'],
  concurrency: 10,
  inFlight: 2,
  connectedAt: 1_760_000_000_000, // epoch ms
  lastHeartbeat: 1_760_000_050_000, // epoch ms
  startedAt: 1_759_999_990_000, // epoch ms
  sessionGeneration: 1,
  capabilities: { region: 'us-east-1' },
  deploymentName: 'billing',
  buildId: '2026.08.18-3',
  runtimeVersion: '1.3.14',
  manifest, // the accepted canonical worker manifest
  acceptedManifestDigest: 'sha256:deadbeef',
  drainReason: 'maintenance', // set while the worker is drained
  drainStartedAt: 1_760_000_060_000, // epoch ms
};
```

### `RoutingOptions`

```ts
import type { RoutingOptions } from '@lostgradient/weft';

const routing: RoutingOptions = {
  sticky: 'worker-1', // preferred worker ID for cache locality
  queue: 'default',
  fairShareKey: 'tenant-42', // key used for fair-share routing policy
  excludeWorkerIds: new Set(['worker-2']), // e.g. workers inside the reconnect grace window
  workflowId: 'order-123',
};
```

`findWorker()` applies the configured `RoutingPolicy` (least-loaded by default; supports `'round-robin'` and `'fair-share'`). It filters workers that can handle the activity and have capacity. For `'least-loaded'`, it returns the worker with the lowest `inFlight` count. If `sticky` is set and that worker has capacity, it is preferred.

Draining workers are excluded from `findWorker()` so no new tasks are assigned to them. `serve()` also excludes workers currently inside the reconnect grace window before routing new work. In-flight tasks remain tracked and finish normally, expire through the existing visibility timeout path, or requeue through the existing disconnection/shutdown path.

`isAssignedToWorker(operationId, workerId)` returns whether an in-flight task is currently owned by a specific worker. The server checks it before accepting `taskResult` frames so stale completions from a displaced worker are rejected instead of mutating engine state.

### `WorkerDrainOptions`

```ts
import type { WorkerRegistry } from '@lostgradient/weft';

type WorkerDrainOptions = NonNullable<Parameters<WorkerRegistry['markWorkerDraining']>[1]>;

const drain: WorkerDrainOptions = {
  reason: 'maintenance',
  updatedAt: Date.now(), // drain start time in epoch ms
};
```

`updatedAt` records the drain start time in epoch milliseconds. When omitted, the registry uses `Date.now()`.

### `InFlightTask`

```ts
import type { InFlightTask } from '@lostgradient/weft';

const task: InFlightTask = {
  operationId: 'op-1',
  workerId: 'worker-1',
  deadline: 1_760_000_030_000, // absolute timestamp
  visibilityTimeout: 30_000, // original timeout duration in ms
  fairShareKey: 'tenant-42',
  attemptToken: 'attempt-token',
  // The dispatching workflow run's persisted revision (WFT-20), when the `TaskDispatch` carried one.
  workflowRevision: 'rev-88',
};
```

`checkExpiredTasks(now)` returns tasks whose visibility deadline has passed, suitable for reassignment.

**Visibility timeout vs. attempt deadline (COR-230).** `visibilityTimeout` governs `deadline` above — the heartbeat-renewable clock. Before v5, a bare session `heartbeat` renewed it for every in-flight task on the connection; as of v5, only a matching `activityHeartbeat` (`operationId` + `attemptToken`) renews a given task's `deadline`, and it can never renew it past that attempt's separate, fixed `attemptDeadline` (`RemoteTaskLeased.attemptDeadline`, `core/task-ledger/task-ledger-types.ts`). `visibilityTimeout` and the attempt deadline are two independent clocks: the first can be renewed indefinitely by a live worker; the second cannot be renewed at all.

## Canonical worker manifest

A worker manifest is how a worker answers every identity question about itself at once, with each question in its own field. The host validates that claim before the worker becomes routing-eligible, so worker readiness means _the server accepted a validated manifest_ rather than _a socket opened_.

| Field             | Question answered                                | Stability                       |
| ----------------- | ------------------------------------------------ | ------------------------------- |
| `manifestVersion` | Can the host parse this manifest shape?          | Changes with manifest schema    |
| `protocolVersion` | Can these peers exchange wire messages?          | Changes with wire semantics     |
| `sdkVersion`      | Which Weft worker SDK produced this worker?      | Package release                 |
| `runtime`         | Which runtime executes the worker?               | Runtime deployment              |
| `deployment.name` | Which logical service owns this worker?          | Stable service identity         |
| `buildId`         | Which operator-visible release is this?          | Immutable within a deployment   |
| `artifactDigest`  | Which exact executable bytes are loaded?         | Content-addressed and immutable |
| `workflowVersion` | Which replay compatibility boundary is declared? | Workflow author controlled      |
| `contractHash`    | Which public payload contract is implemented?    | Deterministic contract identity |

A Git SHA is deliberately absent: repositories may be dirty, builds may inject configuration, and one commit may produce several artifacts, so a commit is metadata rather than an executable identity.

### `WorkerManifest`

```ts
import { WORKER_MANIFEST_VERSION, type WorkerManifest } from '@lostgradient/weft';

const manifest: WorkerManifest = {
  manifestVersion: WORKER_MANIFEST_VERSION,
  protocolVersion: 4,
  sdkVersion: '0.18.0',
  runtime: { name: 'bun', version: '1.3.14' },
  deployment: { name: 'billing', buildId: '2026.08.18-3', artifactDigest: 'sha256:41d0e2' },
  workflows: {
    checkout: {
      workflowVersion: '2.1.0',
      workflowRevision: 'rev-88',
      contractHash: 'sha256:9ab3',
      activities: { charge: { contractHash: 'sha256:2b1f', implementationRevision: 'rev-41' } },
    },
  },
  capabilities: { gpu: true },
};

console.log(manifest.deployment.buildId);
```

Activity keys are canonical runtime activity names, qualified structurally by the workflow that contains them rather than only through a dotted string—so the same activity name may appear under two workflows without collision.

`capabilities` is bounded descriptive data. It never grants authorization and never affects routing without an explicit host policy.

### `parseWorkerManifest(value)` and `parseWorkerManifestJson(text)`

Both validate an untrusted manifest and return a result rather than throwing, because a malformed manifest is an ordinary wire condition on a boundary the host does not control. A success carries the normalized manifest _and_ its canonical serialization, so a caller that stores or digests the result never re-derives canonical form.

```ts
import { parseWorkerManifest } from '@lostgradient/weft';

const result = parseWorkerManifest(JSON.parse('{"manifestVersion":99}'));

if (!result.ok) {
  console.log(result.reason); // 'unsupported_manifest_version'
}
```

Prefer `parseWorkerManifestJson()` wherever the received JSON _text_ is still available. Duplicate object keys are only visible before parsing—`JSON.parse` resolves `{"artifactDigest":"a","artifactDigest":"b"}` to one of the two silently—and a manifest that could mean two different artifacts must be rejected, not resolved.

Rejection reasons are a closed union (`WorkerManifestRejectionReason`) precisely so operators can count manifest failures by reason without a high-cardinality metric label. The accompanying `message` and `path` are for diagnostics and must never be used as labels.

Validation enforces explicit semantic bounds after transport-size admission: identifier byte lengths, workflow and activity counts, capability count, capability nesting depth, capability string bytes, and the total normalized manifest size. The normalized size is measured against the _canonical_ form, so a whitespace-minimized payload cannot slip under the ceiling and then expand.

### `WorkerExecutionRequirement` and `WorkerExecutionIdentity`

Routing input and observed execution are separate types on purpose. A requirement asks a question and may leave fields unset; an identity answers it completely.

```ts
import {
  executionIdentitySatisfies,
  type WorkerExecutionIdentity,
  type WorkerExecutionRequirement,
} from '@lostgradient/weft';

// Pin the deployment; let policy choose any eligible build within it.
const requirement: WorkerExecutionRequirement = { deploymentName: 'billing' };

const identity: WorkerExecutionIdentity = {
  workerId: 'worker-1',
  manifestDigest: 'sha256:deadbeef',
  protocolVersion: 4,
  sdkVersion: '0.18.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.14',
  deploymentName: 'billing',
  buildId: '2026.08.18-3',
  artifactDigest: 'sha256:41d0e2',
  workflowType: 'checkout',
  workflowRevision: 'rev-88',
  activityName: 'charge',
  activityContractHash: 'sha256:2b1f',
};

console.log(executionIdentitySatisfies(requirement, identity)); // true
```

An omitted requirement field means policy may choose any eligible value. It is _not_ an empty-string wildcard. Once a task is leased its execution identity is complete and derived from the accepted manifest plus the live session—a worker cannot self-report a different execution identity in its result, which is what makes the identity safe to persist as provenance.

### `computeWorkerManifestDigest(manifest)`

Manifest digests are content-addressed and algorithm-tagged (`sha256:<hex>`). Two manifests that differ only in key insertion order digest identically; any difference the host cares about changes the digest.

```ts
import { computeWorkerManifestDigest, WORKER_MANIFEST_VERSION } from '@lostgradient/weft';

const digest = await computeWorkerManifestDigest({
  manifestVersion: WORKER_MANIFEST_VERSION,
  protocolVersion: 4,
  sdkVersion: '0.18.0',
  runtime: { name: 'bun', version: '1.3.14' },
  deployment: { name: 'billing', buildId: '2026.08.18-3', artifactDigest: 'sha256:41d0e2' },
  workflows: {},
  capabilities: {},
});

console.log(digest.startsWith('sha256:')); // true
```

This is a content digest rather than one of the package's FNV-1a helpers, which are documented as cache-key quality: `(deploymentName, buildId)` consistency depends on two different artifacts not colliding.

Use `digestCanonicalWorkerManifest()` when a canonical serialization is already in hand—`parseWorkerManifest()` returns one—to avoid serializing twice.

### `buildWorkerManifestFromRegistry(engine, options)`

Builds a real manifest from an engine's canonical workflow and activity registrations, replacing the `declared-shape:`-tagged placeholders `RemoteWorker` and the internal Worker realm derive by default. Intended for a build script: construct an `Engine` with every workflow the artifact bundles registered (never started), call this function, and pass the result as [`RemoteWorkerOptions.manifest`](#remoteworkeroptions).

```ts
import { buildWorkerManifestFromRegistry, Engine, workflow } from '@lostgradient/weft';

const engine = new Engine();
engine.register(workflow({ name: 'checkout', version: '2.1.0' }).execute(async function* () {}));

const manifest = await buildWorkerManifestFromRegistry(engine, {
  workflows: { checkout: [] },
  deployment: { name: 'billing', buildId: '2026.08.18-3', artifactDigest: 'sha256:41d0e2' },
  runtime: { name: 'bun', version: '1.3.14' },
});

console.log(manifest.workflows['checkout']?.workflowVersion); // '2.1.0'
engine[Symbol.dispose]();
```

`options.workflows` maps each workflow type to the activity names that instance can execute—the one association the registry cannot supply on its own, since the engine's activity registry is a flat namespace rather than partitioned per workflow. Every key must name a workflow the source `Engine` has registered, and every activity name must be one the same `Engine` has registered; an unregistered name throws `WorkerManifestBuildError` rather than silently omitting the entry.

`contractHash` is a real `sha256:`-tagged digest of the workflow's payload schemas (input, output, signals, updates, queries)—`description` and `tags` are excluded so a documentation edit never changes contract identity. `workflowRevision` answers a broader question—"which exact definition was loaded"—so it digests the full registry entry (schemas, `description`, and `tags`) plus the registered `version`; a description/tag edit or a version bump changes `workflowRevision` without necessarily changing `contractHash`, which is the intended distinction between the two fields, not drift in either one. `implementationRevision` on each activity contract is set to `options.deployment.buildId`: a schema identifies the contract, not the code behind it, so there is no honest schema-derived source for "which implementation" is bound.

`options.deployment` and `options.runtime` are required, never derived—a build script knows its own deploy target; live runtime detection at build time would assert the wrong identity when the build and deploy environments differ.

## Fleet and queue observability

Two operator-facing endpoints expose the live worker fleet and the in-memory task queue state. Both require the `system:read` scope. Workers and task queues are server-wide infrastructure.

The read operations are reachable over [JSON-RPC](https://www.jsonrpc.org/specification) ([HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP), [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API), [stdio](https://en.wikipedia.org/wiki/Standard_streams)) as [`weft.workers.list`](#get-apiv1workers) and [`weft.task.queues.list`](#get-apiv1task-queues). They take no input parameters.

### `GET /api/v1/workers`

Returns every connected worker with its queue assignment, advertised activities, concurrency, in-flight count, available capacity, connect time, last heartbeat, heartbeat age, deployment identity, capabilities, start time, and drain health. The top-level `routingPolicy` field reports the routing strategy the server was configured with. The top-level `deployments` field groups connected workers by reported deployment identity and summarizes active, draining, and drained workers.

The server snapshots `Date.now()` exactly once per request, so every `heartbeatAgeMs` in the response is consistent.

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type ListWorkersResponse = ClientOperationTypes['weft.workers.list']['output'];

const response: ListWorkersResponse = {
  items: [
    {
      id: 'worker-1',
      queue: 'default',
      transport: 'websocket', // or 'long-poll'
      activities: ['checkout.charge'],
      concurrency: 10,
      inFlight: 2,
      availableCapacity: 8, // max(0, concurrency - inFlight)
      connectedAt: 1_760_000_000_000, // epoch ms
      lastHeartbeatAt: 1_760_000_050_000, // epoch ms
      heartbeatAgeMs: 4_000, // now - lastHeartbeatAt at snapshot time
      startedAt: 1_759_999_990_000, // epoch ms
      capabilities: { region: 'us-east-1' },
      health: 'active', // 'active' | 'draining' | 'drained'
      deploymentName: 'billing',
      buildId: '2026.08.18-3',
      runtimeVersion: '1.3.14',
    },
  ],
  deployments: [
    {
      deploymentName: 'billing',
      buildId: '2026.08.18-3',
      runtimeVersion: '1.3.14',
      transports: ['websocket'],
      health: 'active',
      workers: 1,
      activeWorkers: 1,
      drainingWorkers: 0,
      drainedWorkers: 0,
      inFlight: 2,
      oldestStartedAt: 1_759_999_990_000,
    },
  ],
  routingPolicy: 'least-loaded', // or 'round-robin' | 'fair-share'
};
```

Workers are sorted by `id` ascending.

`health` is derived from drain state and in-flight work:

- `active`: the worker is eligible for new assignments.
- `draining`: drain state is set and the worker still has in-flight tasks.
- `drained`: drain state is set and the worker has no in-flight tasks.

### `POST /api/v1/workers/:workerId/drain`

Marks a connected worker as draining. Requires `system:admin`. The optional JSON request body may include a non-empty `reason`.

```json
{ "reason": "maintenance" }
```

Response:

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type WorkerDrainResponse = ClientOperationTypes['weft.workers.drain']['output'];

const response: WorkerDrainResponse = {
  target: 'worker',
  workerId: 'worker-1',
  affectedWorkers: 1,
  inFlight: 2,
  health: 'draining', // 'active' | 'draining' | 'drained'
};
```

The JSON-RPC operation name is `weft.workers.drain`.

### `DELETE /api/v1/workers/:workerId/drain`

Clears the explicit drain marker for one worker. Requires `system:admin`. If a deployment-level drain still applies, the worker remains drained by that deployment.

The JSON-RPC operation name is `weft.workers.resume`.

### `POST /api/v1/worker-deployments/:deploymentName/drain`

Marks every current and future worker that reports `deploymentName` as draining. Requires `system:admin`. The optional JSON request body may include a non-empty `reason`, and a non-empty `buildId` that narrows the drain to that one build of the deployment: only workers reporting that exact `(deploymentName, buildId)` pair stop receiving new tasks, and the deployment's other builds stay routable. A build the deployment catalog has not accepted, or has removed, is answered `404`, and nothing is marked.

Response:

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type DeploymentDrainResponse = ClientOperationTypes['weft.worker.deployments.drain']['output'];

const response: DeploymentDrainResponse = {
  target: 'deployment',
  deploymentName: 'billing',
  buildId: '2026.08.18-3', // present when the request named a build
  affectedWorkers: 3,
  inFlight: 0,
  health: 'drained', // 'active' | 'draining' | 'drained'
};
```

A build drain is also written to the deployment catalog as the build's `draining` state (whatever executions reference it), so it survives a restart and `weft.worker.deployments.diagnostics` reports the build as `draining`; a worker that registers on a draining or removed build joins drained.

Which drains survive a server restart:

| Drain                             | Survives a restart | Why                                                                                           |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| A build (`buildId` given)         | Yes                | The catalog records the build as `draining`, and a worker that registers on it joins drained. |
| A whole deployment (no `buildId`) | No                 | Only the registry's in-memory marker holds it.                                                |
| One worker (`weft.workers.drain`) | No                 | Only the registry's in-memory marker holds it.                                                |

Draining the current or ramping build of a routing pointer has a side effect: the build's catalog state is no longer `ready`, so new starts of workflows that carry a worker versioning policy find no routed build and are refused (`no-routed-deployment`) until the build is resumed or routing moves to another build. The console warns before draining such a build.

The JSON-RPC operation name is `weft.worker.deployments.drain`.

### `DELETE /api/v1/worker-deployments/:deploymentName/drain`

Clears the deployment-level drain marker. Requires `system:admin`. Any worker-specific drain markers remain in effect. Pass `?buildId=<id>` to clear one build's marker instead; a deployment-wide marker or a worker-specific marker that still applies keeps its workers drained, and clearing a build with no marker succeeds and changes nothing. Resuming a build also returns its catalog state to `ready`. A build the catalog has removed faults with `NotFound` and stays drained.

The JSON-RPC operation name is `weft.worker.deployments.resume`.

### `GET /api/v1/workers/:workerId/diagnostics`

Bounded instance and deployment-version diagnostics for one connected worker (WFT-29). Requires `system:read`. Returns `{ worker: null }` when `workerId` is not currently connected.

The response splits into two structurally distinct parts, mirroring the manifest's own split between "which process" and "which build":

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type WorkerDiagnosticsResponse = ClientOperationTypes['weft.workers.diagnostics']['output'];

const response: WorkerDiagnosticsResponse = {
  worker: {
    instance: {
      workerId: 'worker-1',
      queue: 'default',
      transport: 'websocket', // or 'long-poll'
      health: 'active', // 'active' | 'draining' | 'drained'
      inFlight: 2,
      sessionGeneration: 1,
      connectedAt: 1_760_000_000_000, // epoch ms
      startedAt: 1_759_999_990_000, // epoch ms
      lastHeartbeatAt: 1_760_000_050_000, // epoch ms
      heartbeatAgeMs: 4_000,
    },
    deploymentVersion: {
      deploymentName: 'billing',
      buildId: '2026.08.18-3',
      artifactDigest: 'sha256:41d0e2',
      runtimeName: 'bun',
      runtimeVersion: '1.3.14',
      sdkVersion: '0.18.0',
      manifestVersion: 1,
      protocolVersion: 8,
      manifestDigest: 'sha256:deadbeef',
      // Keyed by workflow type: workflowVersion, workflowRevision, contractHash,
      // and each activity's { contractHash, implementationRevision }.
      workflows: {
        checkout: {
          workflowVersion: '2.1.0',
          workflowRevision: 'rev-88',
          contractHash: 'sha256:9ab3',
          activities: { charge: { contractHash: 'sha256:2b1f', implementationRevision: 'rev-41' } },
        },
      },
    },
  }, // `null` when the worker is not connected
};
```

Deliberately excludes `capabilities` and every raw payload schema backing a `contractHash`—this surfaces identity for drift detection, not a schema dump.

The JSON-RPC operation name is `weft.workers.diagnostics`.

### `GET /api/v1/workers/registration-rejections`

Bounded, most-recent-first log of declined `register` attempts (WFT-29). Requires `system:read`. Accepts an optional `limit` query parameter (default `20`, max `100`).

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type ListWorkerRegistrationRejectionsResponse =
  ClientOperationTypes['weft.workers.rejections']['output'];
type RegistrationRejectionCode = ListWorkerRegistrationRejectionsResponse['items'][number]['code'];

const code: RegistrationRejectionCode = 'deployment_conflict';
// Also 'invalid_registration', 'unsupported_protocol_version', or 'registration_rejected'.

const response: ListWorkerRegistrationRejectionsResponse = {
  items: [
    {
      code,
      workerId: 'worker-1', // absent when the frame failed to parse before a workerId could be read
      rejectedAt: 1_760_000_000_000, // epoch ms
      queue: 'default',
      deploymentName: 'billing',
      buildId: '2026.08.18-3',
    },
  ],
  limit: 20,
};
```

Deliberately excludes the free-text rejection message and any manifest content—this is a bounded, auditable event log, not a diagnostic dump. The log is in-memory and capped at the 200 most recent entries per server process; it is not persisted.

The JSON-RPC operation name is `weft.workers.rejections`.

### `GET /api/v1/conformance/targets` and `POST /api/v1/conformance/targets/:target/report`

Remote-worker protocol conformance reports (COR-1365). `GET` lists the conformance targets registered with `serve({ conformanceTargets: createConformanceTargets({ ... }) })` and requires `system:read`. `POST` runs the `weft conformance` check sequence against one target in a private sandbox server and requires `system:admin`. A request names a target only. It can never supply a worker command.

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type ListConformanceTargetsResponse = ClientOperationTypes['weft.conformance.targets']['output'];
type RunConformanceReportResponse = ClientOperationTypes['weft.conformance.report']['output'];

const targets: ListConformanceTargetsResponse = {
  targets: [{ name: 'typescript-worker', timeoutMs: 10_000 }], // commands are never returned
};

const report: RunConformanceReportResponse = {
  target: 'typescript-worker',
  startedAt: 1_760_000_000_000, // epoch ms
  completedAt: 1_760_000_004_000, // epoch ms
  ok: true,
  protocolVersion: 8,
  supportedProtocolVersions: [8],
  checks: [{ name: 'register', ok: true, message: 'registerAck received' }],
};
```

An unregistered target answers `NotFound`. See [Conformance reports as an operation](./remote-worker-protocol.md#conformance-reports-as-an-operation) for how targets are configured and why the operation runs them only in a sandbox.

The JSON-RPC operation names are `weft.conformance.targets` and `weft.conformance.report`.

### `GET /api/v1/tasks/diagnostics`

Bounded task-attempt diagnostics (COR-198): stuck queued tasks, stale in-flight attempts, retry storms, queues where every worker is at capacity, dead letters, expected-delayed tasks, and terminal records still awaiting adoption. Requires `system:read`. Item shapes vary by `kind`; see [`get-task-diagnostics.ts`](../../src/server/operations/get-task-diagnostics.ts) for the full per-kind response type.

Every filter is optional and independently bounded; supplying several combines them with AND:

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type GetTaskDiagnosticsInput = ClientOperationTypes['weft.tasks.diagnostics']['input'];

const input: GetTaskDiagnosticsInput = {
  operationId: 'op-1',
  workflowId: 'order-123',
  queue: 'default',
  // Execution-identity filters, sourced from each matching task's current
  // TaskAttemptRecord.executionIdentity—see "Attempt history and
  // provenance" in the remote task recovery guide for what that identity
  // is and how it differs from the ledger's routing requirement.
  deploymentName: 'billing',
  buildId: 'b47',
  artifactDigest: 'sha256:41d0e2',
  workerId: 'worker-1',
  workflowRevision: 'rev-88',
  staleQueuedAfterMs: 60_000, // default 60000
  staleHeartbeatAfterMs: 60_000, // default 60000
  retryStormMinimumAttempts: 3, // default 3
  includeExpectedDelayed: false, // default false
  unadoptedAfterMs: 60_000, // default 60000
  limit: 50, // default 50, max 200
};
```

The five identity filters answer "which attempts ran on this build/deployment/artifact/worker/workflow revision"—for example, `?buildId=b47` returns only diagnostics for tasks whose current attempt actually executed on build `b47`, regardless of what a task's dispatch-time `WorkerExecutionRequirement` asked for. A `queued` task (no attempt has claimed it yet) never matches any of these; it is excluded, not treated as a wildcard. A long-poll attempt has no `executionIdentity` (no registered manifest to build one from) and is likewise unfilterable by these five fields—filter by `operationId`, `workflowId`, or `queue` instead when long-poll attempts matter.

```bash
curl -sS 'http://127.0.0.1:7233/api/v1/tasks/diagnostics?buildId=b47&limit=10' \
  -H "Authorization: Bearer $API_KEY"
```

The JSON-RPC operation name is `weft.tasks.diagnostics`.

### `GET /api/v1/tasks/detail/:operationId/deliveries`

The transport-level answer every `taskResult` submission for one operation received, oldest first (COR-1366). Each entry is a `taskResultAck` disposition (`applied`, `duplicate`, `dead-lettered`) or a hard rejection with its `rejectionCode` and redacted `reason`. Requires `system:read`. The server keeps the 32 most recent entries per operation, and `droppedCount` reports older ones. Answers `NotFound` when the operation has no ledger record. The [remote task recovery guide](../guides/remote-task-recovery.md#result-delivery-history) has the full entry shape and its `task:result-delivery` live event.

The JSON-RPC operation name is `weft.tasks.deliveries`.

### `GET /api/v1/tasks/detail/:operationId/dead-letter`

A dead-lettered attempt's retained result value, not only its digest (COR-1366). Requires `system:admin`, the scope that may clear the dead letter. Accepts an optional `maxBytes` query parameter (default `65536`, max `1048576`). A larger value is reported as `{ kind: 'omitted', serializedBytes, maxBytes }` and is never truncated. The raw attempt token, task input, and headers are never returned. Answers `NotFound` unless the task is dead-lettered. The [remote task recovery guide](../guides/remote-task-recovery.md#dead-lettered-result-values) explains the access model.

The JSON-RPC operation name is `weft.tasks.deadletters.get`.

### `POST /api/v1/tasks/detail/:operationId/dead-letter/retry`

Queues a dead-lettered task again (COR-1973). The task keeps its `operationId`, becomes `queued` with a new attempt number, and `requeueCount` goes up by one; the next worker to claim it runs it as that attempt. Nothing is deleted. The dead attempt's attempt record (disposition `deadLettered`, with its reason and time) and the task's delivery history stay readable through `GET /api/v1/tasks/detail/:operationId`. What the retry replaces is the retained result on the ledger record, so `GET /api/v1/tasks/detail/:operationId/dead-letter` answers `NotFound` afterwards, and so does clearing it. A result or heartbeat that still carries the dead attempt's token is refused. The operation counts toward the `weft.task.requeues` and `weft.task.retries` metrics. Requires `system:admin`, the scope that reads and clears a dead letter.

The body is optional. `attemptTokenDigest` is the digest of the dead-lettered attempt the caller read (`attemptTokenDigest` from the dead-letter read); the retry is refused when the dead letter is no longer that attempt. Any other body key is rejected.

```bash
curl -sS -X POST 'http://127.0.0.1:7233/api/v1/tasks/detail/invoice-42/dead-letter/retry' \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{ "attemptTokenDigest": "<digest from the dead-letter read>" }'
```

The response is `{ operationId, state: 'queued', attempt, requeueCount }`. Faults:

- `NotFound`: no task has that `operationId`, or it was cleared.
- `Conflict`: the task is not dead-lettered (queued, leased, completing, cancelling, or terminal); the supplied `attemptTokenDigest` is not the dead-lettered attempt; the workflow that owns the task has finished or been deleted; or the task kept changing while the retry ran. A refused retry changes nothing. REST does not disclose which of these it was beyond the message; the JSON-RPC fault carries the reason (`not-dead-lettered`, `dead-letter-changed`, `workflow-finished`, `concurrent-change`).

Two retries sent together queue the task once: one succeeds and the other is refused. The retry does not check `retryPolicy.maxAttempts`, so a task that dead-lettered on its last allowed attempt can still be retried, and the next automatic requeue may then end it as `retryExhausted`. The activity runs again, so any side effects the dead attempt already performed repeat unless the activity is idempotent. The operation is not exposed to MCP.

The JSON-RPC operation name is `weft.tasks.deadletters.retry`.

### `GET /api/v1/task-queues`

Returns per-queue health. The queue set is the union of three sources:

1. Queues with one or more pending tasks.
2. Queues with one or more parked long-poll waiters.
3. Queues that have at least one connected worker (so an idle queue with capacity but no work still appears).

`inFlight` is summed across the workers currently assigned to that queue. `connectedWorkers` counts workers whose `queue` matches.

```ts
import type { ClientOperationTypes } from '@lostgradient/weft';

type ListTaskQueuesResponse = ClientOperationTypes['weft.task.queues.list']['output'];

const response: ListTaskQueuesResponse = {
  items: [
    {
      queue: 'default',
      backlog: 3, // pending tasks
      oldestEnqueuedAt: 1_760_000_000_000, // epoch ms, null if backlog == 0
      oldestQueuedAgeMs: 12_000,
      waitingPollers: 0,
      schedulingPolicy: 'fifo', // 'priority' | 'fifo' | 'lifo'
      inFlight: 2,
      connectedWorkers: 1,
    },
  ],
};
```

Queues are sorted by `queue` ascending.

## Worker start override

A terminal workflow whose worker-versioning policy is `auto-upgrade` keeps the build it last ran on when it is restarted with `onTerminalConflict: "start-new"`. To restart it on the build routing now selects, an operator first asks for a preview and then spends the resulting token on the restart.

`POST /v1/worker-start-overrides/preview` (JSON-RPC `weft.worker.startoverrides.preview`, `system:admin`) takes `{ workflowId, ttlMs? }` and returns `{ preview }`: a server-signed, single-use token scoped to that workflow, the binding it replaces, and the build routing selects now, valid for `ttlMs` (default 60 seconds, at most 5 minutes). It needs the server to be configured with a `workerStartOverrideSigningSecret`.

Pass the whole `preview` object as `workerStartOverridePreview` to `weft.workflows.startorsignal` (with `id`, `signalId`, and `onTerminalConflict: "start-new"`), or to `weft.workflows.start`. The token is consumed with the replacement, atomically, so it works once.

These operations answer with typed faults a client can branch on:

| Fault                   | When                                                                                                                                                                                                                                                                                                                                                                               | Data                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `NotFound`              | The preview names a workflow that does not exist.                                                                                                                                                                                                                                                                                                                                  | `resource: "workflow"`, `identifier`           |
| `Conflict`              | The preview cannot be issued: the workflow is not terminal (`workflow-not-terminal`), has no durable binding (`no-worker-binding`), is not `auto-upgrade` (`policy-not-auto-upgrade`), no ready routed build provides its revision (`no-routed-deployment`), or the candidate build does not satisfy the policy (`upgrade-<reason>`, for example `upgrade-incompatible-contract`). | `reason` (JSON-RPC)                            |
| `UnsupportedCapability` | The server has no signing secret.                                                                                                                                                                                                                                                                                                                                                  | `capability: "workerStartOverrideSigning"`     |
| `Conflict`              | A start carries a token that cannot authorize it: expired, already used, for another workflow, stale against the accepted binding, forged, or unverifiable.                                                                                                                                                                                                                        | `reason: "override-token-rejected"` (JSON-RPC) |
| `InvalidParams`         | The token is not shaped like a preview.                                                                                                                                                                                                                                                                                                                                            | `issues: []`                                   |

## Revision-aware deployment routing

`WorkerDeploymentCatalog` stores immutable `(deploymentName, buildId)` versions and a conditional routing pointer in the configured storage backend. A version records its artifact and manifest digests, accepted manifest, lifecycle state, first-seen time, and execution references, which are computed when the version is read and never stored. Re-registering a build with different digests is rejected. Routing pointers carry a monotonically increasing generation, a current build, an optional ramping build, an integer `rampBasisPoints` value from `0` through `10_000`, and an optional `previousBuildId`; stale expected generations are rejected. `previousBuildId` is the build that was current before the latest change of `currentBuildId`, the target a rollback returns to. `setRouting` derives it inside its conditional write, from the record it replaces: a write that changes the current build records the replaced one, and a write that keeps the current build (a ramp, or clearing one) carries it over unchanged. A caller cannot supply it, and a pointer written before the field existed has none until its current build next changes.

`selectWorkerDeployment` resolves a task to one exact build before applying worker policy. A pinned `buildId`, `artifactDigest`, `workflowRevision`, or activity contract never falls forward to another build. Unpinned traffic chooses the ramping build when the deterministic `worker-rollout-v1` bucket for `(deploymentName, workflowId, generation)` is below `rampBasisPoints`, otherwise it chooses the current build. Candidate workers are then filtered for the requested workflow/activity, capacity, and drain state, and ties are ordered by worker ID.

A version's execution references are the durable work bound to its build: every run that is not terminal (`running`, `pending`, or `suspended`) whose current worker binding names the build, under any worker-versioning policy, and every task-ledger entry that is not terminal whose execution requirement names the build. A dead-lettered ledger entry is not terminal, so it keeps the build until `weft.tasks.diagnostics.deadletters.clear` resolves it. Schedules and revision realms do not pin a build and do not count. The count comes from one scan of the run records and one of the task ledger each time versions are listed or a build is removed, so it falls to zero as the work finishes, and `GET /v1/worker-deployments/diagnostics` reports it as `executionReferences`.

A build is removed in two steps. First drain it (`weft.worker.deployments.drain` with a `buildId`, or `catalog.setVersionState(deploymentName, buildId, "draining")`): a draining build can no longer be chosen by a start or an upgrade, including an auto-upgrade policy whose `compatibility.buildId` names it. Then remove it. Removal is irreversible, and it refuses a build that is not draining, that the routing pointer names, or that has any execution reference.

Removal is optimistic concurrency, not a lock. Two small records sit beside the version record and the routing pointer. The binding stamp is 64 shards per build, at `worker-deployment-binding:<deployment>:<build>:<k>` where `<k>` is two lowercase hex digits, `00` to `3f`; each shard holds sixteen random bytes. Every commit binding durable work to the build writes a fresh value to exactly one shard, blind, in the same batch as the work: a run's worker binding (a fresh start, a `start-new` restart, a child start, a fork, an automatic upgrade, `bindWorkflowWorkerAtStart`, and the retry of a failed run) and a task-ledger entry whose requirement names the build. The shard is the 32-bit FNV-1a hash of the binding's own key (the run id, or the ledger entry's operation id) over its UTF-8 bytes, modulo 64, so concurrent bindings land on different shards. That matters on Postgres and Neon, which run every conditional batch at `SERIALIZABLE`: bindings that all wrote one row would abort each other and fail after five retries, with no removal involved. An absent shard means no binding has used it. The removal tombstone, at `worker-deployment-removed:<deployment>:<build>`, is one opaque byte written once, in the same batch as the version record's `removed` state, and never deleted. Deployment names and build ids are URI-encoded in these keys as in a version record's key. Neither record is ever decoded: the shards are compared, the tombstone is tested for presence. **The shard count, 64, is persisted format** and cannot change without reading the old shards too. All four prefixes are reserved. Only the shard count, 64, is persisted format. The hash that picks a binding's shard is not, because `remove` conditions on every shard: a binding on any shard is caught, so the choice can change without reading old data.

`remove` reads the version (it must be `draining`), then the routing pointer, then all 64 stamp shards, and only then scans the run records and the non-terminal ledger entries. If anything references the build it refuses with `version-referenced`. Otherwise it writes `removed` and the tombstone in one batch conditioned on the exact bytes of the version record, the routing pointer and every stamp shard it read, an absent shard being conditioned as absent. A binding that commits after its shard was read changes that shard, so the write fails and the removal reads again: a build that is now `removed` answers as removed, one no longer draining or now routed answers that, and anything else rescans. Three attempts in all; after the third the answer is `Conflict` `version-busy`, which is retryable. A binding that commits after the removal meets the tombstone, whose absence every binding commit requires, and fails with `version-removed` without binding anything. Two removals race harmlessly (the second loses on the version bytes and answers removed), nothing is held between steps, and a crash at any point leaves nothing to reconcile. A restart, a fork and the retry of a failed run also read the version record first, which fails fast and covers a build removed before tombstones existed.

Diagnostic failures distinguish revision incompatibility from unavailable capacity so an unavailable build does not hide runnable work on another version. The catalog is durable, but connected worker sessions and in-flight leases remain live registry state and must be recovered through the normal task-ledger recovery path.

The operational surface is scoped to `system:admin` for mutations and `system:read` for diagnostics. Use `POST /v1/worker-deployments/preview` to validate both target builds before changing state; it returns `currentGeneration`, the pointer's generation as it stands (`0` before the first change), to pass as `expectedGeneration`. Then `POST /v1/worker-deployments/routing` advances the conditional generation. `POST /v1/worker-deployments/promote` moves a validated build to current traffic; `POST /v1/worker-deployments/rollback` does the same for a previously registered build; both accept the same optional `expectedGeneration`, and without it they apply against the generation current at the time of the call. `POST /v1/worker-deployments/remove` marks a build removed. `GET /v1/worker-deployments/diagnostics` returns bounded version records and the selected routing pointer. The equivalent JSON-RPC operation names are `weft.worker.deployments.preview`, `weft.worker.deployments.setrouting`, `weft.worker.deployments.promote`, `weft.worker.deployments.rollback`, `weft.worker.deployments.remove`, and `weft.worker.deployments.diagnostics`.

These operations answer with typed faults a client can branch on, not message text:

| Fault           | When                                                                                                                                                                               | Data                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Conflict`      | The routing pointer is no longer at `expectedGeneration`, or it or a target build changed between the read and the write.                                                          | `reason: "stale-generation"` and `currentGeneration` (JSON-RPC; REST discloses `currentGeneration`). Retry with that generation.                                                                |
| `Conflict`      | A target build exists but is not `ready` (for example, draining).                                                                                                                  | `reason: "version-not-ready"` (JSON-RPC).                                                                                                                                                       |
| `Conflict`      | `remove` names a build that is not `draining`.                                                                                                                                     | `reason: "version-not-draining"` (JSON-RPC). The build is left as it was; drain it first.                                                                                                       |
| `Conflict`      | `remove` names a build that durable work is still bound to (see the reference rules above).                                                                                        | `reason: "version-referenced"` (JSON-RPC). The build is left as it was.                                                                                                                         |
| `Conflict`      | Work would be bound to a build that has been removed: a start, a restart (`onTerminalConflict: "start-new"`), a fork, a child start, an automatic upgrade, or a task-ledger entry. | `reason: "version-removed"` (JSON-RPC). Nothing is created. The retry of a failed run reports it per run in the bulk result's `errors` (`reason: "version-removed"`) and leaves the run failed. |
| `Conflict`      | `remove` kept losing to bindings that landed on the build during its scans.                                                                                                        | `reason: "version-busy"` (JSON-RPC). The build is left as it was; retry.                                                                                                                        |
| `Conflict`      | `remove` names the current or ramping build of the routing pointer.                                                                                                                | `reason: "version-routed"` (JSON-RPC). The build is left as it was; route new traffic to another build first.                                                                                   |
| `NotFound`      | A named build does not exist or has been removed.                                                                                                                                  | `resource: "workerDeploymentVersion"`, `identifier: "<deployment>/<build>"`.                                                                                                                    |
| `InvalidParams` | The ramping build equals the current build.                                                                                                                                        | `issues: []`.                                                                                                                                                                                   |

```bash
curl -sS -X POST http://127.0.0.1:7233/v1/worker-deployments/preview \
  -H 'Authorization: Bearer '$API_KEY \
  -H 'Content-Type: application/json' \
  -d '{"deploymentName":"billing","currentBuildId":"build-a","rampingBuildId":"build-b","rampBasisPoints":1000}'
```

Preview and mutation reject unknown or removed versions, malformed persisted identities, stale routing generations, and invalid ramp values before writing. Exact execution requirements never fall forward; an unavailable build reports a version-specific failure, allowing another revision partition to run without head-of-line blocking. Rollback affects only new unpinned selection—existing task and schedule bindings retain their pinned build. Drain and removal are conditional on execution references, so a concurrent lease cannot be lost. Terminal task records are retention data and do not keep a build referenced; only the execution references described above do: runs that are not terminal and are bound to the build, and task-ledger entries that are not terminal and require it. Routing metrics use deployment/build identity only in bounded diagnostics and do not create unbounded workflow-label series. Discovery exposes the same generated operation catalog and client types as the REST and JSON-RPC surfaces.
