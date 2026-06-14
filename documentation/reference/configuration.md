# Configuration Reference

Most configuration flows through typed option objects rather than environment variables. Some integrations ([OpenTelemetry](https://opentelemetry.io/), observability exporters) may read standard env vars from their own SDKs, and a small set of Weft CLI/server paths read explicit `WEFT_*` overrides listed below.

---

## `EngineOptions`

Passed to the `Engine` constructor. All fields are optional with sensible defaults.

```ts partial
interface EngineOptions {
  storage?: Storage;
  development?: boolean;
  serializer?: Serializer;
  retention?: RetentionPolicy;
  retentionSweepInterval?: Duration;
  retentionSweepBatchSize?: number;
  history?: HistoryPolicy;
  archive?: ArchiveAdapter;
  payloadSize?: PayloadSizePolicy;
  compression?: CompressionOptions;
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  broadcastEvents?: boolean;
  detectSecondInstance?: boolean;
  secondInstanceHeartbeatInterval?: Duration;
  workflowExecutionMode?: 'inline' | 'worker';
  workerExecution?: WorkerExecutionOptions;
  activityExecution?: ActivityExecutionOptions;
  alerts?: AlertOptions[];
  interceptors?: readonly Interceptor[];
  onLog?: (record: WorkflowLogRecord) => void;
}
```

| Field                             | Type                       | Default               | Description                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                         | `Storage`                  | `new MemoryStorage()` | Storage backend. Use `SQLiteStorage` for persistence or `MemoryStorage` for ephemeral/testing use.                                                                                                                                                                                                                                                     |
| `development`                     | `boolean`                  | `false`               | Enable development mode. Validates checkpoint round-trips and emits `DevelopmentWarningEvent` for non-serializable fields.                                                                                                                                                                                                                             |
| `serializer`                      | `Serializer`               | Built-in codec        | Pluggable serialization. The default uses structured clone via the built-in `encode`/`decode` codec.                                                                                                                                                                                                                                                   |
| `retention`                       | `RetentionPolicy`          | `undefined`           | Default retention policy for completed, failed, and cancelled workflows.                                                                                                                                                                                                                                                                               |
| `retentionSweepInterval`          | `Duration`                 | internal default      | Interval for automatic retention sweeps.                                                                                                                                                                                                                                                                                                               |
| `retentionSweepBatchSize`         | `number`                   | internal default      | Maximum workflows considered by one retention sweep.                                                                                                                                                                                                                                                                                                   |
| `history`                         | `HistoryPolicy`            | `undefined`           | History circuit-breaker and event-log compaction policy. Omit to disable both.                                                                                                                                                                                                                                                                         |
| `archive`                         | `ArchiveAdapter`           | `undefined`           | Best-effort sink for event-log ranges discarded by compaction.                                                                                                                                                                                                                                                                                         |
| `payloadSize`                     | `PayloadSizePolicy`        | `undefined`           | Optional admission-time cap for workflow inputs, signal payloads, and activity results.                                                                                                                                                                                                                                                                |
| `compression`                     | `CompressionOptions`       | `undefined`           | Enable framed storage payload compression for checkpoints and activity results.                                                                                                                                                                                                                                                                        |
| `checkpointHistory`               | `number`                   | `10`                  | Number of historical checkpoints to retain per workflow.                                                                                                                                                                                                                                                                                               |
| `checkpointSizeWarningThreshold`  | `number`                   | `65_536` (64 KB)      | Checkpoint size in bytes at which a `CheckpointSizeWarningEvent` is emitted.                                                                                                                                                                                                                                                                           |
| `maxNestingDepth`                 | `number`                   | `10`                  | Maximum child workflow nesting depth.                                                                                                                                                                                                                                                                                                                  |
| `broadcastEvents`                 | `boolean`                  | `false`               | Enable `BroadcastChannel` for cross-worker event coordination. Lazily creates the channel on first use.                                                                                                                                                                                                                                                |
| `detectSecondInstance`            | `boolean`                  | `false`               | Enable a best-effort, warn-only liveness detector for a second engine on the same store. See the [singleton guide](../guides/singleton-service-deployment.md#optional-the-second-instance-detector).                                                                                                                                                   |
| `secondInstanceHeartbeatInterval` | `Duration`                 | `15s`                 | Heartbeat interval for `detectSecondInstance`. Keep it above your deploy drain window so a normal handoff does not sustain two ticks of overlap; the warn path is sequence-based, so host clock skew does not affect it. Ignored when detection is off.                                                                                                |
| `workflowExecutionMode`           | `'inline' \| 'worker'`     | `'inline'`            | Choose inline or Worker workflow execution. Omitting defaults to inline; Worker mode requires `workerExecution`.                                                                                                                                                                                                                                       |
| `workerExecution`                 | `WorkerExecutionOptions`   | `undefined`           | Configuration for offloading workflow execution to Web Workers                                                                                                                                                                                                                                                                                         |
| `activityExecution`               | `ActivityExecutionOptions` | `undefined`           | Configuration for activity execution behavior                                                                                                                                                                                                                                                                                                          |
| `alerts`                          | `AlertOptions[]`           | `undefined`           | Metric alert thresholds that fire `AlertFiredEvent` / `AlertResolvedEvent`                                                                                                                                                                                                                                                                             |
| `interceptors`                    | `readonly Interceptor[]`   | `undefined`           | Unified workflow/activity interceptors registered at construction.                                                                                                                                                                                                                                                                                     |
| `onLog`                           | `(record) => void`         | `undefined`           | Host sink for `ctx.log` records. When set, non-replayed inline records route here (pino / winston / OpenTelemetry, etc.) instead of the console; when omitted, the default console behavior is preserved. If the sink throws, Weft falls back to the matching console method and the workflow continues. Worker-mode routing is tracked in issue #529. |

**Example:**

```ts
import { Engine } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

const engine = new Engine({
  storage: new SQLiteStorage('data/weft.db'),
  development: true,
  history: { maxEvents: 100_000, retentionWindow: 10_000 },
  payloadSize: { maxBytes: 1_048_576 },
  checkpointHistory: 20,
  maxNestingDepth: 5,
  compression: { algorithm: 'gzip', threshold: 4096 },
});
```

### History and Payload Limits

`history.maxEvents` is a lifetime event-log circuit breaker. Exactly `maxEvents` records are allowed; the record that would exceed the limit forces the workflow to terminal `timed-out` with the `history-circuit-breaker` termination reason. The count is lifetime sequence, so event-log compaction does not reset it.

`history.retentionWindow` is storage reclamation, not a semantic reset. When set to a positive safe integer, checkpoint commits may delete older event-log records behind a confirmed checkpoint while keeping at most that many recent records. Compaction writes a durable watermark atomically with the checkpoint batch so `EventLog.verify()` can seed verification from the watermark instead of genesis. `0`, `undefined`, or omission disables compaction.

`archive` is an optional best-effort notification sink for compacted ranges. It runs after the truncation commit. A rejected or throwing archive adapter never rolls back the checkpoint or restores deleted event records, so operators who need guaranteed archival must make that durable before compaction can delete the primary records.

`payloadSize.maxBytes` caps the codec-encoded byte length of each workflow input, signal payload, and activity result at admission time. A payload exactly at the limit is allowed; one byte over the limit throws `PayloadSizeExceededError` before any durable write. `0`, `null`, `undefined`, or omission disables the cap and the disabled path performs no extra encode. The cap is separate from storage compression and from Worker protocol message bounds.

### Workflow Execution Mode

Inline execution remains the default for trusted single-tenant deployments:

```ts
import { Engine } from '@lostgradient/weft';

const trustedEngine = new Engine({
  workflowExecutionMode: 'inline',
});

void trustedEngine;
```

Use Worker execution for untrusted multi-tenant workflow code. Explicit Worker mode requires `workerExecution` and applies hardened defaults for the Worker protocol:

```ts
import { Engine } from '@lostgradient/weft';

const untrustedEngine = new Engine({
  workflowExecutionMode: 'worker',
  workerExecution: {
    workerUrl: new URL('./workflow-worker.ts', import.meta.url),
    poolSize: 4,
  },
});

void untrustedEngine;
```

When `workflowExecutionMode` is omitted, Weft defaults to inline execution. Worker execution is the hardened untrusted posture and must be requested explicitly with `workflowExecutionMode: 'worker'`, which requires `workerExecution` and applies the hardened turn-timeout and protocol-message defaults. Providing `workerExecution` without `workflowExecutionMode: 'worker'` is rejected at construction so a trust posture is never selected implicitly. `workflowExecutionMode: 'inline'` rejects `workerExecution` for the same reason.

Worker mode executes workflow generator turns outside the engine isolate. It protects engine liveness and engine heap access by driving the workflow through bounded `postMessage` turns, but it is not an operating-system sandbox. Workflow code still runs inside the Worker global realm and may access APIs exposed by that runtime, including Worker globals, imports, network APIs, filesystem APIs in Bun, and environment APIs when the runtime exposes them.

#### `WorkerExecutionOptions`

```ts
interface WorkerExecutionOptions {
  workerUrl: string | URL;
  poolSize?: number;
  smol?: boolean;
  workflowTurnTimeoutMs?: number;
  maxProtocolMessageBytes?: number;
}
```

| Field                     | Type            | Default                    | Description                                                                                         |
| ------------------------- | --------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `workerUrl`               | `string \| URL` | required                   | Worker entrypoint URL, for example `new URL('./workflow-worker.ts', import.meta.url)`.              |
| `poolSize`                | `number`        | `4`                        | Maximum concurrent workflow Workers.                                                                |
| `smol`                    | `boolean`       | `false`                    | Pass Bun's smaller-memory Worker option when the runtime supports it.                               |
| `workflowTurnTimeoutMs`   | `number`        | `1_000` in Worker mode     | Host-enforced wall-clock budget for each Worker `run` or `resume` turn. Positive safe integer only. |
| `maxProtocolMessageBytes` | `number`        | `1_048_576` in Worker mode | Maximum encoded size of Weft-owned Worker protocol messages. Minimum accepted value is `4_096`.     |

The Worker protocol byte limit is separate from `payloadSize.maxBytes`. Payload limits guard workflow inputs, signals, and activity results at API boundaries. `maxProtocolMessageBytes` guards Weft-owned Worker envelopes, checkpoints, and operation-result messages crossing `postMessage`.

---

## `ServeOptions`

Passed to the `serve()` function to start the Weft HTTP + WebSocket server.

```ts partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  development?: boolean;
  dashboard?: DashboardRouteTarget;
  auth?: AuthConfig;
  unauthenticatedAccess?: 'warn' | 'allow' | 'reject';
  visibilityPollIntervalMs?: number;
  routingPolicy?: RoutingPolicy;
  schedulingPolicy?: SchedulingPolicy;
  prometheusExporter?: PrometheusExporter;
}
```

| Field                      | Type                            | Default          | Description                                                |
| -------------------------- | ------------------------------- | ---------------- | ---------------------------------------------------------- |
| `engine`                   | `Engine`                        | (required)       | The engine instance to expose over HTTP                    |
| `port`                     | `number`                        | `7233`           | TCP port to listen on                                      |
| `hostname`                 | `string`                        | `'0.0.0.0'`      | Hostname/IP to bind to                                     |
| `development`              | `boolean`                       | `false`          | Enable development mode with verbose error responses       |
| `dashboard`                | `DashboardRouteTarget`          | `undefined`      | External dashboard shell served at supported page routes   |
| `auth`                     | `AuthConfig`                    | `undefined`      | Authentication configuration (JWT, mTLS, or custom)        |
| `unauthenticatedAccess`    | `'warn' \| 'allow' \| 'reject'` | `'warn'`         | Startup policy when `auth` is omitted                      |
| `visibilityPollIntervalMs` | `number`                        | `5000`           | Polling interval for task visibility timeout checks        |
| `routingPolicy`            | `RoutingPolicy`                 | `'least-loaded'` | Worker routing policy                                      |
| `schedulingPolicy`         | `SchedulingPolicy`              | `'priority'`     | Scheduling policy for task dispatch                        |
| `prometheusExporter`       | `PrometheusExporter`            | `undefined`      | Exporter that produces the response body for `/v1/metrics` |

The returned `WeftServer` exposes the resolved `port`, `hostname`, and `url`, along with a `stop()` method and `AsyncDisposable` support.

When `auth` is omitted, [`serve()`](./api-server.md#serve) defaults to `unauthenticatedAccess: 'warn'`: it logs a startup warning and runs open for local development. Set `unauthenticatedAccess: 'reject'` or [`WEFT_SERVER_AUTHENTICATION_REQUIRED=1`](#environment-variables) for production deployments so startup fails before binding unless `auth` is configured. `auth` satisfies the requirement; `unauthenticatedAccess: 'allow'` suppresses the local warning but does not override `WEFT_SERVER_AUTHENTICATION_REQUIRED`.

**Example:**

```ts partial
import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';

const engine = new Engine();
const server = serve({ engine, port: 8080 });
console.log(`Weft server running at ${server.url}`);
```

---

## Environment Variables

Weft's library API does not require environment variables. These variables are read by user-facing runtime, CLI, or conformance paths when you opt into those features. Internal benchmark, coverage, and smoke-test toggles are intentionally documented near the tests and scripts that consume them instead of in this runtime configuration reference.

| Variable                                  | Consumed by                                   | Description                                                                                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEFT_DEFAULT_STORAGE_PATH`               | `src/storage/auto.ts`                         | Default SQLite path used by automatic storage resolution when no explicit storage path is supplied.                                                                                                                                 |
| `WEFT_SERVER_AUTHENTICATION_REQUIRED`     | `src/server/serve-internals.ts`               | Set to `1`, `true`, `yes`, or `on` to make `serve()` fail closed when no `auth` configuration is supplied. Set to `0`, `false`, `no`, or `off` to leave the `unauthenticatedAccess` option in control. Invalid values fail startup. |
| `WEFT_STRICT_FAULTS`                      | `src/server/operation-catalog/raise-fault.ts` | Set to `1` to use strict server fault details even when `NODE_ENV` is `production`.                                                                                                                                                 |
| `WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN` | `src/server/handler/route-dispatch.ts`        | Local development or CI escape hatch for serving browser-facing API catalog routes without a trusted same-origin request; do not use as production configuration.                                                                   |
| `WEFT_TOKEN`                              | `src/cli/codegen.ts`                          | Bearer token fallback for `weft codegen --server` when `--token` is omitted.                                                                                                                                                        |
| `WEFT_WORKER_URL`                         | `src/cli/conformance.ts`                      | Temporary WebSocket task-stream URL injected into worker commands launched by `weft conformance`.                                                                                                                                   |
| `WEFT_WORKER_QUEUE`                       | `src/cli/conformance.ts`                      | Queue name injected into worker commands launched by `weft conformance`.                                                                                                                                                            |
| `WEFT_WORKER_ACTIVITIES`                  | `src/cli/conformance.ts`                      | Comma-separated activity names the conformance worker must expose.                                                                                                                                                                  |
| `WEFT_WORKER_PROTOCOL_VERSION`            | `src/cli/conformance.ts`                      | Remote worker protocol version expected by the conformance harness.                                                                                                                                                                 |
| `WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS`  | `src/cli/conformance.ts`                      | Heartbeat interval injected into repository conformance fixtures; custom workers can ignore it unless needed.                                                                                                                       |

---

## `RetryPolicy`

Controls retry behavior for activity execution.

```ts partial
interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}
```

| Field                | Type       | Default               | Description                                          |
| -------------------- | ---------- | --------------------- | ---------------------------------------------------- |
| `maxAttempts`        | `number`   | `3`                   | Total attempts (including the first).                |
| `initialBackoff`     | `Duration` | `1000` (1 second)     | Delay before the first retry.                        |
| `backoffMultiplier`  | `number`   | `2`                   | Multiplier applied to the backoff after each retry.  |
| `maxBackoff`         | `Duration` | `30_000` (30 seconds) | Upper bound on backoff duration.                     |
| `nonRetryableErrors` | `string[]` | `undefined`           | Error message substrings that should not be retried. |

The backoff for attempt N is `min(initialBackoff * backoffMultiplier^(N-1), maxBackoff)`.

---

## Constants

### `DEFAULT_RETRY_POLICY`

```ts partial
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoff: 1000,
  backoffMultiplier: 2,
  maxBackoff: 30_000,
};
```

### `DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD`

```ts
const DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD = 65_536; // 64 KB
```

Checkpoint size in bytes at which the engine emits a `CheckpointSizeWarningEvent`. Override via `EngineOptions.checkpointSizeWarningThreshold`.

### `DEFAULT_MAX_NESTING_DEPTH`

```ts
const DEFAULT_MAX_NESTING_DEPTH = 10;
```

Maximum depth of child workflow nesting. Override via `EngineOptions.maxNestingDepth`.

### `DEFAULT_VISIBILITY_TIMEOUT_MS`

```ts
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000; // 30 seconds
```

Default task visibility timeout. After this window, the task server considers a task unacknowledged and eligible for reassignment. Override via worker options.

---

## `ObservabilityOptions`

Passed to `createObservabilityInterceptors()`. See the [Observability API reference](./api-observability.md).

```ts
interface ObservabilityOptions {
  recordPayloads?: boolean;
  maxPayloadSize?: number;
  eventTarget?: EventTarget;
  onSpanStart?: (span: SpanInfo) => void;
  onSpanEnd?: (span: SpanInfo) => void;
}
```

| Field            | Type                       | Default     | Description                                                               |
| ---------------- | -------------------------- | ----------- | ------------------------------------------------------------------------- |
| `recordPayloads` | `boolean`                  | `false`     | Record activity/workflow inputs as span attributes.                       |
| `maxPayloadSize` | `number`                   | `1024`      | Maximum serialized payload size before truncation.                        |
| `eventTarget`    | `EventTarget`              | `undefined` | Engine or EventTarget for automatic root-span cleanup on terminal events. |
| `onSpanStart`    | `(span: SpanInfo) => void` | `undefined` | Span start callback.                                                      |
| `onSpanEnd`      | `(span: SpanInfo) => void` | `undefined` | Span end callback.                                                        |
