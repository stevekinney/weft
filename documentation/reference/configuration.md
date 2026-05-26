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
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  broadcastEvents?: boolean;
  retention?: RetentionPolicy;
  compression?: CompressionOptions;
  workerExecution?: WorkerExecutionOptions;
  activityExecution?: ActivityExecutionOptions;
  alerts?: AlertOptions[];
}
```

| Field                            | Type                       | Default               | Description                                                                                                                |
| -------------------------------- | -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `storage`                        | `Storage`                  | `new MemoryStorage()` | Storage backend. Use `SQLiteStorage` for persistence or `MemoryStorage` for ephemeral/testing use.                         |
| `development`                    | `boolean`                  | `false`               | Enable development mode. Validates checkpoint round-trips and emits `DevelopmentWarningEvent` for non-serializable fields. |
| `serializer`                     | `Serializer`               | Built-in codec        | Pluggable serialization. The default uses structured clone via the built-in `encode`/`decode` codec.                       |
| `checkpointHistory`              | `number`                   | `10`                  | Number of historical checkpoints to retain per workflow.                                                                   |
| `checkpointSizeWarningThreshold` | `number`                   | `65_536` (64 KB)      | Checkpoint size in bytes at which a `CheckpointSizeWarningEvent` is emitted.                                               |
| `maxNestingDepth`                | `number`                   | `10`                  | Maximum child workflow nesting depth.                                                                                      |
| `broadcastEvents`                | `boolean`                  | `false`               | Enable `BroadcastChannel` for cross-worker event coordination. Lazily creates the channel on first use.                    |
| `retention`                      | `RetentionPolicy`          | `undefined`           | Default retention policy for completed/failed/cancelled workflows                                                          |
| `compression`                    | `CompressionOptions`       | `undefined`           | Enable framed storage payload compression for checkpoints and activity results.                                            |
| `workerExecution`                | `WorkerExecutionOptions`   | `undefined`           | Configuration for offloading workflow execution to Web Workers                                                             |
| `activityExecution`              | `ActivityExecutionOptions` | `undefined`           | Configuration for activity execution behavior                                                                              |
| `alerts`                         | `AlertOptions[]`           | `undefined`           | Metric alert thresholds that fire `AlertFiredEvent` / `AlertResolvedEvent`                                                 |

**Example:**

```ts
import { Engine } from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

const engine = new Engine({
  storage: new SQLiteStorage('data/weft.db'),
  development: true,
  checkpointHistory: 20,
  maxNestingDepth: 5,
  compression: { algorithm: 'gzip', threshold: 4096 },
});
```

---

## `ServeOptions`

Passed to the `serve()` function to start the Weft HTTP + WebSocket server.

```ts partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  development?: boolean;
  dashboard?: unknown;
  auth?: AuthConfig;
  visibilityPollIntervalMs?: number;
  routingPolicy?: RoutingPolicy;
  schedulingPolicy?: SchedulingPolicy;
  prometheusExporter?: PrometheusExporter;
}
```

| Field                      | Type                 | Default          | Description                                                |
| -------------------------- | -------------------- | ---------------- | ---------------------------------------------------------- |
| `engine`                   | `Engine`             | (required)       | The engine instance to expose over HTTP                    |
| `port`                     | `number`             | `7233`           | TCP port to listen on                                      |
| `hostname`                 | `string`             | `'0.0.0.0'`      | Hostname/IP to bind to                                     |
| `development`              | `boolean`            | `false`          | Enable development mode with verbose error responses       |
| `dashboard`                | `unknown`            | `undefined`      | Dashboard HTML/module import served at `/ui` when supplied |
| `auth`                     | `AuthConfig`         | `undefined`      | Authentication configuration (JWT, mTLS, or custom)        |
| `visibilityPollIntervalMs` | `number`             | `5000`           | Polling interval for task visibility timeout checks        |
| `routingPolicy`            | `RoutingPolicy`      | `'least-loaded'` | Worker routing policy                                      |
| `schedulingPolicy`         | `SchedulingPolicy`   | `'priority'`     | Scheduling policy for task dispatch                        |
| `prometheusExporter`       | `PrometheusExporter` | `undefined`      | Exporter that produces the response body for `/v1/metrics` |

The returned `WeftServer` exposes the resolved `port`, `hostname`, and `url`, along with a `stop()` method and `AsyncDisposable` support.

**Example:**

```ts partial
import { Engine } from 'weft';
import { serve } from 'weft/server';

const engine = new Engine();
const server = serve({ engine, port: 8080 });
console.log(`Weft server running at ${server.url}`);
```

---

## Environment Variables

Weft's library API does not require environment variables. These variables are read by user-facing runtime, CLI, or conformance paths when you opt into those features. Internal benchmark, coverage, and smoke-test toggles are intentionally documented near the tests and scripts that consume them instead of in this runtime configuration reference.

| Variable                                  | Consumed by                                   | Description                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEFT_DEFAULT_STORAGE_PATH`               | `src/storage/auto.ts`                         | Default SQLite path used by automatic storage resolution when no explicit storage path is supplied.                                                               |
| `WEFT_STRICT_FAULTS`                      | `src/server/operation-catalog/raise-fault.ts` | Set to `1` to use strict server fault details even when `NODE_ENV` is `production`.                                                                               |
| `WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN` | `src/server/handler/route-dispatch.ts`        | Local development or CI escape hatch for serving browser-facing API catalog routes without a trusted same-origin request; do not use as production configuration. |
| `WEFT_TOKEN`                              | `src/cli/codegen.ts`                          | Bearer token fallback for `weft codegen --server` when `--token` is omitted.                                                                                      |
| `WEFT_WORKER_URL`                         | `src/cli/conformance.ts`                      | Temporary WebSocket task-stream URL injected into worker commands launched by `weft conformance`.                                                                 |
| `WEFT_WORKER_QUEUE`                       | `src/cli/conformance.ts`                      | Queue name injected into worker commands launched by `weft conformance`.                                                                                          |
| `WEFT_WORKER_ACTIVITIES`                  | `src/cli/conformance.ts`                      | Comma-separated activity names the conformance worker must expose.                                                                                                |
| `WEFT_WORKER_PROTOCOL_VERSION`            | `src/cli/conformance.ts`                      | Remote worker protocol version expected by the conformance harness.                                                                                               |
| `WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS`  | `src/cli/conformance.ts`                      | Heartbeat interval injected into repository conformance fixtures; custom workers can ignore it unless needed.                                                     |

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
