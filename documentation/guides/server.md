# Server

You've built your workflows and tested them locally. Now you need to expose them over the network---accept HTTP requests to start workflows, send signals, query status, and stream results over WebSockets. Weft's server module wraps `Bun.serve()` with a complete REST API and WebSocket support.

## Starting the server

The `serve()` function takes an engine and optional network configuration, and returns a `WeftServer` handle.

```typescript partial
import { Engine } from 'weft';
import { serve } from 'weft/server';

const engine = new Engine({ storage });
engine.register('order', orderWorkflow);

const server = serve({ engine });

console.log(`Weft server listening at ${server.url}`);
```

The `ServeOptions` interface:

```typescript partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  development?: boolean; // enable Bun's development mode (HMR, source maps)
  auth?: AuthConfig; // API key or JWT authentication configuration
  routingPolicy?: RoutingPolicy; // task dispatch policy for remote workers; default: 'least-loaded'
  schedulingPolicy?: SchedulingPolicy; // workflow scheduling policy
  prometheusExporter?: PrometheusExporter; // Prometheus metrics exporter
  metricsCollector?: MetricsCollector; // @deprecated -- prefer prometheusExporter
}
```

## The WeftServer handle

`serve()` returns a `WeftServer` that exposes the resolved port, hostname, URL, and a `stop()` method that returns `Promise<void>`. It also implements `AsyncDisposable`, so you can use it with `await using` for correct async cleanup.

```typescript partial
interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly registry: WorkerRegistry;
  readonly taskQueue: TaskQueue;
  stop(): Promise<void>;
  dispatchTask(task: TaskDispatch): Promise<boolean>;
  shutdownWorker(workerId: string, options?: { timeoutMs?: number }): Promise<boolean>;
  shutdownAllWorkers(options?: { timeoutMs?: number }): Promise<void>;
  cancelTask(operationId: string): boolean;
}
```

```typescript partial
{
  await using server = serve({ engine });
  // Server is running...
} // Automatically stopped here
```

`WeftServer` implements `AsyncDisposable`, so `await using` is required for correct async cleanup.

## REST API endpoints

The server exposes a versioned REST API under `/v1/`. All endpoints return JSON by default, with content negotiation for MessagePack (`Accept: application/msgpack`).

**Health check:**

```
GET /v1/health
→ { "status": "ok" }
```

**API discovery:**

```
GET /openrpc.json
→ OpenRPC 1.3.2 document listing all JSON-RPC methods
```

The `rpc.discover` JSON-RPC method returns the same document over the JSON-RPC transport. These discovery endpoints were introduced in the Track 8 operation catalogue consolidation.

Engine-local definition introspection is separate from these transport documents. Use `engine.listWorkflowDefinitions()` and `engine.listActivityDefinitions()` when you need in-process metadata for registered user definitions; use `/openrpc.json`, `/openapi.json`, and `/asyncapi.json` when you need the server's network contract.

**Start a workflow:**

```
POST /v1/workflows
{ "type": "order", "input": { ... }, "id": "custom-id", "executionTimeout": "24h" }
→ 201 { "id": "workflow-id" }
```

The `id` and `executionTimeout` fields are optional. If `id` is omitted, one is generated. Starting a workflow with a duplicate ID returns `409 Conflict`.

**List workflows:**

```
GET /v1/workflows?status=running&type=order&limit=50&offset=0
→ { "items": [...], "total": 142, "offset": 0, "limit": 50 }
```

Filter by `status`, `type`, or [search attributes](./search-attributes.md) using `attr.*` query parameters.

**Get workflow state:**

```
GET /v1/workflows/:id
→ { "id": "...", "type": "order", "status": "running", ... }
```

**Get workflow result:**

```
GET /v1/workflows/:id/result
→ { "result": { ... } }
```

If the workflow is still running, this endpoint blocks for up to 30 seconds waiting for completion. Returns `408` on timeout, `422` if the workflow failed or was cancelled.

**Cancel a workflow:**

```
DELETE /v1/workflows/:id
→ 204 No Content
```

`DELETE` removes the workflow record from storage. To cancel a workflow while keeping its terminal state, use the cancel endpoint:

```
POST /v1/workflows/:id/cancel
→ 204 No Content
```

**Send a signal:**

```
POST /v1/workflows/:id/signal/:name
{ "payload": { ... } }
→ { "ok": true }
```

**Send an update (synchronous request-response):**

```
POST /v1/workflows/:id/update/:name
{ "payload": { ... }, "timeout": 5000, "idempotencyKey": "..." }
→ { "updateId": "...", "result": { ... } }
```

See the [synchronous updates guide](./synchronous-updates.md) for details on the update model.

**Check update result:**

```
GET /v1/updates/:updateId
→ { "status": "completed", "result": { ... } }
→ { "status": "pending" }  (202 if still processing)
```

**Get/set search attributes:**

```
GET  /v1/workflows/:id/attributes
PATCH /v1/workflows/:id/attributes
{ "attributes": { "priority": 5, "region": "us-east" } }
```

**Metrics (Prometheus-compatible):**

```
GET /v1/metrics
→ text/plain with HELP/TYPE/value lines
```

## WebSocket upgrade paths

The server supports WebSocket connections for real-time streaming. When a request includes the `Upgrade: websocket` header, the server upgrades the connection and subscribes it to the matching path.

Three WebSocket routes are available:

- `/v1/workflows/:id/watch` --- observe workflow state changes in real time
- `/v1/workflows/:id/stream` --- stream tokens from agent workflows
- `/v1/tasks/:queue/stream` --- [remote worker](./remote-workers.md) task dispatch

## The `handleRequest()` function

Under the hood, `serve()` delegates to `handleRequest()`---a pure function that maps a `Request` to a `Response` with no Bun-specific dependencies. This is intentional. If you need to embed Weft's API inside an existing server or use a different HTTP framework, import `handleRequest` directly:

```typescript partial
import { handleRequest } from 'weft/server/handler';

// Inside your existing server
const response = await handleRequest(request, engine);
```

Route matching uses a table of regex patterns. Each route extracts named parameters (`:id`, `:name`, etc.) from the URL path and dispatches to the appropriate handler function.

## Content negotiation

All response-producing endpoints support content negotiation. If the `Accept` header includes `application/msgpack`, responses are serialized with MessagePack instead of JSON. This reduces payload size for binary-heavy responses. JSON is the default fallback.

## Service Worker

The same `handleRequest()` function that powers the Bun server also powers the Service Worker runtime. In the browser, a Service Worker intercepts `fetch` events and routes them through the engine---your client code calls `fetch("/weft/v1/workflows", ...)` and the Service Worker responds, no network required.

The `weft/service-worker` module provides bootstrap functions for lifecycle, fetch, and periodic-sync wiring. Timer wakeup uses the engine scheduler from the Service Worker event.

```typescript partial
/// <reference lib="webworker" />
import { Engine } from 'weft';
import { IndexedDBStorage } from 'weft/storage/indexeddb';
import {
  createFetchHandler,
  createLifecycleHandlers,
  createPeriodicSyncHandler,
} from 'weft/service-worker';

const storage = new IndexedDBStorage('weft');
const engine = new Engine({ storage });

await engine.recoverAll();

const { install, activate } = createLifecycleHandlers();
self.addEventListener('install', install);
self.addEventListener('activate', activate);
self.addEventListener('fetch', createFetchHandler({ engine, pathPrefix: '/weft/' }));
self.addEventListener('periodicsync', createPeriodicSyncHandler(engine.scheduler));
```

See the [Service Worker guide](./service-worker.md) for registration, Periodic Background Sync setup, fallback polling, and debugging details.

### `createFetchHandler()`

Creates a `fetch` event listener that intercepts requests matching the path prefix and routes them through `handleRequest()`. Non-matching requests pass through to the network.

```typescript partial
function createFetchHandler(options: ServiceWorkerOptions): (event: FetchEvent) => void;
```

| Option       | Type     | Default    | Description                                       |
| ------------ | -------- | ---------- | ------------------------------------------------- |
| `engine`     | `Engine` | (required) | The engine instance to handle requests            |
| `pathPrefix` | `string` | `'/weft/'` | URL path prefix that identifies Weft API requests |

### Periodic timer wakeup

Workflows that use `ctx.sleep()` depend on periodic wakeup to advance. In the browser, listen for `periodicsync` and call `engine.scheduler.tick()`. The tag must match the tag registered from page code with `registration.periodicSync.register(...)`.

### `createLifecycleHandlers()`

Returns `install` and `activate` event handlers. The `install` handler calls `skipWaiting()` so the new Service Worker activates immediately. The `activate` handler calls `clients.claim()` so the Service Worker takes control of all open tabs without requiring a page reload.

```typescript partial
function createLifecycleHandlers(): {
  install: (event: ExtendableEvent) => void;
  activate: (event: ExtendableEvent) => void;
};
```

### Limitations

Service Workers have constrained execution time. Browsers terminate a Service Worker shortly after it finishes handling an event, so long-running synchronous work is not viable. For workflows that need hours or days of execution, use a server deployment.

Periodic Background Sync support varies by browser. As of May 4, 2026, MDN marks it experimental and limited; Chromium-based browsers support it, while Firefox and Safari do not. Without Periodic Background Sync, fallback polling only runs while a controlled tab is open.
