# Observability API Reference

The observability module provides an interceptor for W3C Trace Context propagation, span-like lifecycle events, and a metric catalogue following OpenTelemetry semantic conventions. Wire it up to the engine with `addInterceptor()`.

For a guided walkthrough, see the [Observability guide](../guides/observability.md).

---

## `createObservabilityInterceptors(options?)`

Factory that creates a unified interceptor. Its workflow-side hooks propagate trace context and emit spans for workflow start, activity calls, sleeps, and signal waits. Its activity-side `execute` hook extracts trace context from headers and wraps activity execution in a span.

```ts partial
function createObservabilityInterceptors(options?: ObservabilityOptions): {
  interceptor: Interceptor;
  metrics: MetricsCollector;
  /**
   * End the workflow root span. Usually wired automatically via `eventTarget`,
   * but exposed for callers that need to end spans manually.
   */
  endWorkflowSpan: (workflowId: string, status: 'ok' | 'error', errorMessage?: string) => void;
  /**
   * Unsubscribe workflow lifecycle listeners and end any still-open workflow
   * spans. Call when tearing down the engine so the interceptor doesn't leak.
   */
  dispose: () => void;
};
```

> [!IMPORTANT]
> Pass your `Engine` instance as `options.eventTarget`. The factory then subscribes to the engine's workflow lifecycle events (`workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`) and automatically ends the root span with the appropriate status. Without this wiring, root spans stay "in progress" forever and the internal span map grows unbounded.

### `ObservabilityOptions`

| Field            | Type                       | Default     | Description                                                                                                          |
| ---------------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `recordPayloads` | `boolean`                  | `false`     | Record activity/workflow inputs as span attributes                                                                   |
| `maxPayloadSize` | `number`                   | `1024`      | Maximum serialized payload size in bytes before truncation                                                           |
| `eventTarget`    | `EventTarget`              | `undefined` | Engine (or other `EventTarget`) that dispatches workflow lifecycle events. Required for automatic root-span cleanup. |
| `onSpanStart`    | `(span: SpanInfo) => void` | `undefined` | Callback when a span starts                                                                                          |
| `onSpanEnd`      | `(span: SpanInfo) => void` | `undefined` | Callback when a span ends                                                                                            |

### `SpanInfo`

```ts
interface SpanInfo {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
  startTime: number;
  endTime?: number;
  status?: 'ok' | 'error';
  error?: string;
}
```

Span names follow the pattern `workflow:<type>`, `activity:<name>`, `sleep`, or `waitForSignal`.

**Example:**

```ts
import { Engine } from '@lostgradient/weft';
import { createObservabilityInterceptors } from '@lostgradient/weft/observability';

const engine = new Engine();

const { interceptor, dispose } = createObservabilityInterceptors({
  recordPayloads: true,
  eventTarget: engine, // enables automatic root-span cleanup on terminal events
});

engine.addInterceptor(interceptor);

// When tearing down:
// dispose();
// engine[Symbol.dispose]();
```

---

## Metrics

### `METRICS`

A catalogue of metric definitions emitted by Weft. Each entry contains the metric `name`, `description`, `unit`, and `type`. These follow OpenTelemetry conventions and can be consumed by any metrics backend.

```ts partial
const METRICS: {
  workflowDuration: MetricDefinition;
  activityDuration: MetricDefinition;
  activityAttempts: MetricDefinition;
  workflowActive: MetricDefinition;
  workflowStarted: MetricDefinition;
  workflowCompleted: MetricDefinition;
  workflowFailed: MetricDefinition;
  promptCacheHits: MetricDefinition;
  promptCacheMisses: MetricDefinition;
  dpmoDefects: MetricDefinition;
  dpmoOperations: MetricDefinition;
  taskBacklog: MetricDefinition;
  taskQueueLatency: MetricDefinition;
  taskExecutionLatency: MetricDefinition;
  taskRetries: MetricDefinition;
  taskRequeues: MetricDefinition;
  taskStaleHeartbeats: MetricDefinition;
  workerCapacitySaturation: MetricDefinition;
};
```

| Key                        | Name                              | Type        | Unit        | Description                                                   |
| -------------------------- | --------------------------------- | ----------- | ----------- | ------------------------------------------------------------- |
| `workflowDuration`         | `weft.workflow.duration`          | `histogram` | `ms`        | Duration of workflow execution                                |
| `activityDuration`         | `weft.activity.duration`          | `histogram` | `ms`        | Duration of activity execution                                |
| `activityAttempts`         | `weft.activity.attempts`          | `counter`   | `attempts`  | Number of attempts per activity                               |
| `workflowActive`           | `weft.workflow.active`            | `gauge`     | `workflows` | Currently active workflows                                    |
| `workflowStarted`          | `weft.workflow.started`           | `counter`   | `workflows` | Total workflows started                                       |
| `workflowCompleted`        | `weft.workflow.completed`         | `counter`   | `workflows` | Total workflows completed                                     |
| `workflowFailed`           | `weft.workflow.failed`            | `counter`   | `workflows` | Total workflows failed                                        |
| `promptCacheHits`          | `weft.prompt_cache.hits`          | `counter`   | `hits`      | Total prompt prefix cache hits                                |
| `promptCacheMisses`        | `weft.prompt_cache.misses`        | `counter`   | `misses`    | Total prompt prefix cache misses                              |
| `dpmoDefects`              | `weft.dpmo.defects`               | `counter`   | `workflows` | Failed workflows for DPMO                                     |
| `dpmoOperations`           | `weft.dpmo.operations`            | `counter`   | `workflows` | Started workflows for DPMO                                    |
| `taskBacklog`              | `weft.task.backlog`               | `gauge`     | `tasks`     | Queued tasks waiting for workers                              |
| `taskQueueLatency`         | `weft.task.queue_latency`         | `histogram` | `ms`        | Time tasks spend queued before dispatch                       |
| `taskExecutionLatency`     | `weft.task.execution_latency`     | `histogram` | `ms`        | Time tasks spend executing after worker start                 |
| `taskRetries`              | `weft.task.retries`               | `counter`   | `retries`   | Retry attempts after first dispatch                           |
| `taskRequeues`             | `weft.task.requeues`              | `counter`   | `requeues`  | Visibility-timeout or disconnect requeues                     |
| `taskStaleHeartbeats`      | `weft.task.stale_heartbeats`      | `gauge`     | `tasks`     | In-flight tasks past the stale-heartbeat diagnostic threshold |
| `workerCapacitySaturation` | `weft.worker.capacity_saturation` | `gauge`     | `ratio`     | In-flight worker slots divided by total worker concurrency    |

### `MetricDefinition`

```ts
interface MetricDefinition {
  name: string;
  description: string;
  unit: string;
  type: MetricType;
}

type MetricType = 'counter' | 'gauge' | 'histogram';
```

Task metrics stay deliberately low-cardinality. Use `GET /api/v1/tasks/diagnostics` when you need workflow IDs, operation IDs, worker IDs, or queue-specific evidence for stuck work or dead-lettered task results; keep metric labels suitable for aggregation.

### Ownership lease health

`GET /api/v1/system/lease` is backed by the `weft.system.lease` operation and
requires `system:read`. It returns the serving engine process's last-known
ownership state without changing the anonymous `GET /v1/health` liveness probe:

```json
{
  "mode": "lease",
  "status": "healthy",
  "holdsLease": true,
  "holderId": "process-instance-id",
  "heldSince": 1720000000000,
  "expiresAt": 1720000030000,
  "lastRenewedAt": 1720000005000,
  "fencingEpoch": 7
}
```

| `mode`  | `status`    | Meaning                                                                                   |
| ------- | ----------- | ----------------------------------------------------------------------------------------- |
| `none`  | `disabled`  | This engine was not configured with lease ownership.                                      |
| `lease` | `no-lease`  | Lease mode is configured, but this process has not acquired or has stopped holding it.    |
| `lease` | `healthy`   | This process last acquired or renewed the lease successfully and currently claims it.     |
| `lease` | `contested` | This process lost ownership or can no longer prove it; inspect `lossReason` when present. |

When present, `lossReason` preserves the engine's real distinction: `deposed`
confirms that a successor won the lease or a fenced write, while
`renewal-unconfirmable` means a storage failure persisted past the last confirmed
expiry. An expired last-known record is contested even before a renewal produces a
specific loss reason. Holder and timestamp fields are last-known process-local
evidence. After confirmed deposition detaches the manager, the response keeps
`status: "contested"` and `lossReason: "deposed"` without guessing the successor's
identity. Holder IDs remain confined to this scoped JSON diagnostic and are never
emitted as metric labels.

### `GET /api/v1/tasks/detail/:operationId`

Returns one task's full durable ledger state — the wire-reachable counterpart to
the same-process-only `WeftServer.getTaskResult()`. The REST endpoint is backed
by the `weft.tasks.get` operation and requires `system:read`. The path lives
under `/detail/` rather than a bare `/api/v1/tasks/:operationId`: a
caller-supplied `operationId` is only required to be a nonempty bounded
string, so it can legally equal an existing sibling literal path — currently
`diagnostics` — and a bare parameterized route would make that task
permanently unreachable over REST.

```http
GET /api/v1/tasks/detail/op-123
```

The response is a discriminated union on `state`, distinguishing `queued`,
`leased`, `completing`, `cancelling`, `terminal`, and `deadLettered` — a finer
vocabulary than `GET /api/v1/tasks/diagnostics`, which collapses `leased`,
`completing`, and `cancelling` into one `inflight` value for alerting purposes.
Every variant carries the dispatch envelope (`operationId`, `workflowId?`,
`workflowExecutionToken?`, `workflowType`, `activityName`, `queue`,
`priority?`, `headerKeys`, `visibilityTimeoutMilliseconds`, `retryPolicy?`,
`scheduleToCloseDeadline?`, `executionRequirement?`, `fairShareKey?`,
`stickyWorkflowId?`, `createdAt`, `attempt`) plus state-specific fields — for
example a `terminal` record adds `disposition`, `terminalAt`, `adopted`, and
`adoptedAt?`; a `deadLettered` record adds `pendingStatus`, `resultDigest`,
`persistenceFailureReason`, and `deadLetteredAt`. `resultDigest` is present
on a `terminal` record only when `disposition` is `resolved` — the
`cancelled` and `retryExhausted` lineages store an internal placeholder
there instead of a real content hash, so it is omitted rather than returned.
`workflowExecutionToken` is not a secret — an external write fence, like
activity and finalizer attempt tokens — present when the task is
workflow-bound; it distinguishes the exact run that owns a retained task
when `start-new` reuses a workflow ID.

```json
{
  "operationId": "op-123",
  "workflowId": "wf-456",
  "workflowExecutionToken": "exec-abc123",
  "workflowType": "checkout",
  "activityName": "chargeCard",
  "queue": "payments",
  "headerKeys": ["x-trace-id"],
  "visibilityTimeoutMilliseconds": 30000,
  "retryPolicy": {
    "maxAttempts": 3,
    "initialBackoff": "1s",
    "backoffMultiplier": 2,
    "maxBackoff": "30s"
  },
  "createdAt": 1720000000000,
  "attempt": 2,
  "state": "terminal",
  "disposition": "resolved",
  "resultDigest": "sha256:...",
  "terminalAt": 1720000005000,
  "adopted": false
}
```

Faults `NotFound` if no ledger record exists for the `operationId` — either it
was never dispatched, or an adopted terminal record was already reaped by
`ServeOptions.taskRetentionWindowMs`. Faults `EngineFailure` (distinct from
`NotFound`) if the stored record exists but its bytes fail to decode into a
valid ledger record — a data-integrity concern that operators should
investigate, not a legitimately absent task.

Three fields are deliberately never returned: `attemptToken`, `workerSessionId`,
and `executionIdentity` are worker ownership/session internals with no business
being public — the same exclusion `TaskResultView` documents for its own
same-process shape. `headers` are summarized as key names only (`headerKeys`);
the task's `input` value and a dead-lettered record's pending result value are
never included — this is a "digest not value" read surface, matching how a
resolved task's own result value is never re-delivered. This operation is
read-only: there is no HTTP path to `adoptTaskResult` (adoption stays
same-process-only, since it is an explicit caller assertion that a workflow
incorporated a result — a browser-based caller cannot honestly make that
assertion on the workflow's behalf).

### `GET /api/v1/tasks/diagnostics`

Returns bounded task diagnostics for queued, in-flight, and task-result dead-letter activity records. The REST endpoint is backed by the `weft.tasks.diagnostics` operation and requires `system:read`.

```http
GET /api/v1/tasks/diagnostics?workflowId=checkout-123&queue=payments&limit=25
```

Query parameters:

| Parameter                   | Type     | Default | Description                                               |
| --------------------------- | -------- | ------- | --------------------------------------------------------- |
| `operationId`               | `string` |         | Limit results to one activity operation.                  |
| `workflowId`                | `string` |         | Limit results to one workflow.                            |
| `queue`                     | `string` |         | Limit results to one task queue.                          |
| `staleQueuedAfterMs`        | `number` | `60000` | Queue latency threshold for `stuck-queued` diagnostics.   |
| `staleHeartbeatAfterMs`     | `number` | `60000` | Heartbeat age threshold for `stale-inflight` diagnostics. |
| `retryStormMinimumAttempts` | `number` | `3`     | Minimum retry count for `retry-storm` diagnostics.        |
| `limit`                     | `number` | `50`    | Maximum returned items. The server caps this at `200`.    |

Each item has a `kind` of `stuck-queued`, `stale-inflight`, `retry-storm`, `all-workers-at-capacity`, or `dead-lettered`, plus bounded evidence strings. `retry-storm` only ever reports queued or in-flight tasks — the durable task ledger does not retain attempt-count history once a task resolves, so a resolved task cannot trigger it. A dead-lettered entry is the task's current authoritative ledger state, created when a worker's result cannot be durably persisted after storage retries are exhausted; the operationId stays blocked from a fresh dispatch until the entry is cleared.

Use the clear action after the storage problem is understood and the operator is ready to let the operationId be dispatched again:

```http
DELETE /api/v1/tasks/diagnostics/dead-letter/:operationId
```

The clear action is backed by `weft.tasks.diagnostics.deadletters.clear`, requires `system:admin`, deletes the dead-lettered ledger record, and returns `{ "ok": true }`. It faults `NotFound` if no dead-lettered record currently exists for the given `operationId` — either it was never dispatched, or its current state is something other than `deadLettered`. The diagnostics response also includes summary counts so callers can tell when more matching diagnostics exist than the requested item limit.

`HttpClient` and `LocalClient` expose this REST-only mutation through the typed
generated operation surface:

```ts
import { HttpClient } from '@lostgradient/weft/client';

const client = new HttpClient({ baseUrl: 'https://weft.example.com' });
await client.operations['weft.tasks.diagnostics.deadletters.clear']({
  operationId: 'op-123',
});
```

The generated client keeps the operation's REST method, path parameter, and
success shape in catalog metadata; callers do not need to construct the route
or reproduce `HttpClientError` parsing.

---

## Trace Propagation

Implements parsing, formatting, and injection/extraction of the W3C `traceparent` header.

### `generateTraceId()`

Generate a random trace ID -- 32 hex characters (16 bytes).

```ts partial
function generateTraceId(): string;
```

### `generateSpanId()`

Generate a random span ID -- 16 hex characters (8 bytes).

```ts partial
function generateSpanId(): string;
```

### `formatTraceParent(context)`

Format a `TraceContext` to a W3C traceparent string.

```ts partial
function formatTraceParent(context: TraceContext): string;
// Returns: "00-<traceId>-<spanId>-<flags>"
```

### `parseTraceParent(value)`

Parse a W3C traceparent header string. Returns `null` if the format is invalid or IDs are all zeros.

```ts partial
function parseTraceParent(value: string): TraceContext | null;
```

### `TraceContext`

```ts
interface TraceContext {
  version: string; // "00"
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  traceFlags: number; // bitmask (1 = sampled)
}
```

**Example:**

```ts
import {
  generateTraceId,
  generateSpanId,
  formatTraceParent,
  parseTraceParent,
} from '@lostgradient/weft/observability';

const traceId = generateTraceId();
const spanId = generateSpanId();

const header = formatTraceParent({
  version: '00',
  traceId,
  spanId,
  traceFlags: 1,
});
// "00-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-1a2b3c4d5e6f7a8b-01"

const parsed = parseTraceParent(header);
// { version: '00', traceId: '...', spanId: '...', traceFlags: 1 }
```
