# Server

You've built your workflows and tested them locally. Now you need to expose them over the network—accept HTTP requests to start workflows, send signals, query status, and stream results over WebSockets. Weft's server module wraps `Bun.serve()` with a complete REST API and WebSocket support.

> [!NOTE]
> [`serve()`](../reference/api-server.md#serve) and the `/v1` REST surface are candidate-stable, provisional surfaces. [MCP discovery](../reference/api-server.md#mcp-server), the bundled dashboard, and the exact [OpenTelemetry](./observability.md) metric names remain experimental until the Tier-0 failure-semantics work finishes and the launch contract is frozen.

## Starting the server

The `serve()` function takes an engine and optional network configuration, and returns a `WeftServer` handle.

```typescript partial
import { Engine, workflow } from 'weft';
import { serve } from 'weft/server';

const engine = new Engine({ storage });
engine.register(workflow({ name: 'order' }).execute(orderWorkflow));

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
  dashboard?: unknown; // dashboard HTML/module import served at /
  auth?: AuthConfig; // API key or JWT authentication configuration
  cors?: CorsOptions; // cross-origin policy for browser clients; omit for same-origin only
  unauthenticatedAccess?: 'warn' | 'allow' | 'reject'; // startup policy when auth is omitted
  visibilityPollIntervalMs?: number; // task visibility scanner interval; default: 5000
  workerReconnectGracePeriodMs?: number; // reconnect grace before requeue; default: 100
  routingPolicy?: RoutingPolicy; // task dispatch policy for remote workers; default: 'least-loaded'
  schedulingPolicy?: SchedulingPolicy; // workflow scheduling policy
  prometheusExporter?: PrometheusExporter; // Prometheus metrics exporter
}
```

When [`auth`](../reference/configuration.md#serveoptions) is omitted, [`serve()`](../reference/api-server.md#serve) starts in an open local-development mode and logs a loud startup warning because every non-public operation is reachable by anyone who can connect to the server. Production wrappers should pass `unauthenticatedAccess: 'reject'` or set [`WEFT_SERVER_AUTHENTICATION_REQUIRED=1`](../reference/configuration.md#environment-variables); either setting makes `serve()` fail before binding unless `auth` is configured. Use `unauthenticatedAccess: 'allow'` only when an intentionally open local process boundary should start without a warning.

`workerReconnectGracePeriodMs` is clamped to `0..5000`. The default `100` ms gives a worker that drops and reconnects with the same `workerId` a short window to keep its in-flight task assignments; set it to `0` when tests or embedded servers need close handling to requeue immediately.

## Authentication

Use [`auth`](../reference/configuration.md#serveoptions) to lock down the [REST](../reference/api-server.md#rest-api-routes), [JSON-RPC](../getting-started/transports.md#json-rpc-over-http-post-apijsonrpc), [WebSocket](../getting-started/transports.md#json-rpc-over-websocket-ws-apijsonrpc), worker, and [MCP](../getting-started/transports.md#mcp-over-streamable-http-and-stdio) surfaces. Public discovery and health routes remain public, while operation routes enforce the scope policy declared by the operation catalog.

```typescript partial
import { Engine } from 'weft';
import { serve } from 'weft/server';

const engine = new Engine({ storage });

const server = serve({
  engine,
  auth: { apiKeys: [process.env.WEFT_API_KEY!] },
  unauthenticatedAccess: 'reject',
});
```

The built-in API-key configuration grants the configured key the default authenticated scope set. JWT and custom authenticators can provide narrower scope sets such as `workflows:read`, `workflows:write`, `workflows:admin`, and `system:read`; requests missing the required scope fail with `401` or `403` before the operation runs.

### Audit trail

Every non-public authentication decision—admission or rejection—emits one structured audit event. By default the event is written as a single JSON line to the console (`console.info` for success, `console.warn` for failure) under the discriminator `weft.auth-audit`, carrying the authenticated `subject`, `method`, request `path`, `httpMethod`, `outcome`, and—on failure—a one-way `credentialFingerprint`. The presented credential itself is **never** logged. Supply `auth.auditSink` to forward events to a SIEM instead:

```typescript partial
const server = serve({
  engine,
  auth: {
    apiKeys: [process.env.WEFT_API_KEY!],
    auditSink: (event) => myStructuredLogger.info('auth', event),
  },
});
```

Public-path bypasses (health, metrics, discovery) are not audited—no credential is examined.

### Credential redaction

`redactCredential` and `redactHeaders` (exported from `weft/server`) mask `Authorization`, `X-API-Key`, `Cookie`, and `Proxy-Authorization` values before they reach a log line. Reach for them whenever you log request headers in custom middleware: a masked value keeps a short, non-reversible fingerprint for correlation without exposing the secret.

## Rate limiting

Set `rateLimit` to shed a flood from a single principal or IP. The limiter is a fixed-window counter keyed by the authenticated principal's `subject` when available, otherwise the client address. Once a key exceeds its budget within the window, the request gets a `429` with `Retry-After` and `X-RateLimit-*` headers; public-path requests and CORS preflight are exempt.

```typescript partial
const server = serve({
  engine,
  auth: { apiKeys: [process.env.WEFT_API_KEY!] },
  rateLimit: { maxRequests: 100, windowMs: 60_000 },
});
```

> [!WARNING] This is a single-process guardrail, not a distributed quota.
> Behind multiple instances each process keeps its own counters. Deployments that need a global budget should still front Weft with a shared reverse-proxy limiter—the in-process limiter exists so a single instance cannot be trivially flooded even when no proxy is present.

## Rotating API keys

Static `apiKeys` are fixed for the lifetime of a `serve()` call, so rotating them means a config change and a restart. `createRotatingApiKeyStore` (from `weft/server`) closes that gap: it is a mutable, in-process key registry the authenticator consults on every request through the `resolveApiKeyPrincipal` hook. Add the replacement key, let it run alongside the outgoing one, then revoke the old key—all without downtime. During the overlap window both keys authenticate.

```typescript partial
import { createRotatingApiKeyStore, serve } from 'weft/server';

const keys = createRotatingApiKeyStore();
keys.add('key-v1', { subject: 'service-account', scopes: ['workflows:read'] });

const server = serve({
  engine,
  auth: { resolveApiKeyPrincipal: keys.resolve },
});

// Later, rotate without restarting:
keys.add('key-v2', { subject: 'service-account', scopes: ['workflows:read'] });
// ...migrate clients to key-v2, then:
keys.revoke('key-v1');
```

Each key may also carry an absolute `expiresAt` timestamp, after which it is rejected automatically without an explicit `revoke`.

## Cross-Origin Resource Sharing (CORS)

The dashboard and the [Service Worker browser runtime](#service-worker) are browser clients. When they run on the **same origin** as the API—the default when the CLI serves the dashboard from `/`, or when a reverse proxy puts the UI and API behind one hostname—no CORS configuration is needed, and Weft ships nothing by default: `serve()` emits no `Access-Control-*` headers and only same-origin browser requests succeed. **The default is deliberately restrictive; Weft never sends `Access-Control-Allow-Origin: *`.**

Configure `cors` only when a browser client calls the API from a **different origin** (a dashboard hosted separately, a web app embedding Weft's API, or a Service Worker registered under another origin):

```typescript partial
import { Engine } from 'weft';
import { serve } from 'weft/server';

const engine = new Engine({ storage });

const server = serve({
  engine,
  auth: { apiKeys: [process.env.WEFT_API_KEY!] },
  cors: {
    allowedOrigins: ['https://dashboard.example.com'],
    // Set credentials only when the browser must send cookies / HTTP auth via
    // `fetch(..., { credentials: 'include' })`. A bearer `Authorization` header
    // is governed by allowedHeaders, not by this flag.
    credentials: true,
  },
});
```

With `cors` set, `serve()`:

- answers CORS preflight (`OPTIONS`) requests **before** authentication—browsers never attach credentials to a preflight, so it must not be auth-gated;
- adds `Access-Control-Allow-Origin` (echoing the exact request origin) plus `Vary: Origin` to responses for allowed origins;
- when `auth` is configured, automatically advertises `Authorization` in `Access-Control-Allow-Headers` so authenticated browser clients can preflight successfully;
- rejects cross-origin **WebSocket** upgrades (`/jsonrpc`, `/v1/.../stream`, `/watch`) from disallowed origins with `403`, because CORS does not govern the WebSocket handshake.

Origins are matched as canonical origin tuples (scheme, host, port), so case, default-port elision, and trailing slashes do not cause mismatches. The literal `Origin: null` (sandboxed iframes, `file://`) never matches.

Two combinations fail fast—`serve()` throws before binding the port:

- `credentials: true` with `allowedOrigins: ['*']`. A wildcard origin is illegal for credentialed CORS; list explicit origins instead.
- `allowedOrigins: ['*']` together with an `Authorization` entry in `allowedHeaders`. That would let any web origin send bearer tokens and read the response—almost never intended. Use an explicit allowlist, or drop `Authorization` from `allowedHeaders` if the wildcard is genuinely meant for a public, unauthenticated API.

A wildcard origin is allowed only for a public, non-credentialed API that does not accept an `Authorization` header. For everything else, list the exact origins your browser clients are served from.

## Dashboard

The built-in dashboard is served at `/` when you pass a dashboard HTML/module import to `serve({ dashboard })`. The CLI loads the bundled dashboard by default and prints the dashboard URL after startup; pass `--no-ui` to run only the API and worker endpoints. For production, do not expose a CLI-started dashboard directly on a public interface unless access is controlled in front of Weft. Put an authenticated reverse proxy or custom wrapper in front of `/` before exposing it beyond a trusted operator network. During dashboard development, `bun run dev:dashboard` starts the server with the dashboard artifact from `src/dashboard/index.html`, which is the same kind of value you can pass through `ServeOptions.dashboard` in an embedded server.

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

Stopping the server also disposes the in-memory task queue. Pending task
expiration timers are cleared, parked long-poll waiters settle with no task,
and queued state is dropped without invoking completion callbacks against a
disposed engine.

## REST API endpoints

The server exposes a versioned REST API under `/api/v1/`. All endpoints return JSON by default, with content negotiation for MessagePack (`Accept: application/msgpack`).

**Health check:**

```
GET /v1/health
→ { "status": "ok" }
```

**API discovery:**

```
GET /openrpc.json
→ OpenRPC 1.3.2 document listing all JSON-RPC methods

GET /.well-known/mcp.json
→ MCP discovery document pointing clients at /api/mcp
```

The `rpc.discover` JSON-RPC method returns the OpenRPC document exposed at `GET /openrpc.json` over the JSON-RPC transport. MCP discovery is separate. These discovery endpoints were introduced in the Track 8 operation catalogue consolidation.

Engine-local definition introspection is separate from these transport documents. Use `engine.listWorkflowDefinitions()` and `engine.listActivityDefinitions()` when you need in-process metadata for registered user definitions; use `/openrpc.json`, `/openapi.json`, and `/asyncapi.json` when you need the server's network contract.

**Start a workflow:**

```
POST /api/v1/workflows
{ "type": "order", "input": { ... }, "id": "custom-id", "executionTimeout": "24h" }
→ 201 { "id": "workflow-id" }
```

The `id` and `executionTimeout` fields are optional. If `id` is omitted, one is generated. Starting a workflow with a duplicate ID returns `409 Conflict`.

**List workflows:**

```
GET /api/v1/workflows?status=running&type=order&limit=50&offset=0
→ { "items": [...], "total": 142, "offset": 0, "limit": 50 }
```

Filter by `status`, `type`, `id_prefix`, `failure_category`, created/updated/deadline ranges, or [search attributes](./search-attributes.md) using `attribute.<name>` query parameters. Repeat `status` and `failure_category` for OR filters. Add `include=failureCategory` when the response needs `WorkflowSummary.failureCategory`; the default list path avoids the extra projection work.

**Aggregate workflows:** `GET /api/v1/workflows/aggregate?group_by=status` returns grouped counts such as `{ "total": 42, "groups": [{ "key": "running", "count": 24 }], "truncated": false }`.

Use aggregates for dashboard counts. Supported groupings are `status`, `type`, `failureCategory`, and `attribute:<name>`.

**Get workflow state:**

```
GET /api/v1/workflows/:id
→ { "id": "...", "type": "order", "status": "running", ... }
```

**Get workflow result:**

```
GET /api/v1/workflows/:id/result
→ { "result": { ... } }
```

If the workflow is still running, this endpoint blocks for up to 30 seconds waiting for completion. Returns `408` on timeout, `422` if the workflow failed or was cancelled.

**Cancel a workflow:**

```
DELETE /api/v1/workflows/:id
→ 204 No Content
```

`DELETE` removes the workflow record from storage. To cancel a workflow while keeping its terminal state, use the cancel endpoint:

```
POST /api/v1/workflows/:id/cancel
→ 204 No Content
```

**Send a signal:**

```
POST /api/v1/workflows/:id/signal/:name
{ "payload": { ... } }
→ { "ok": true }
```

**Send an update (synchronous request-response):**

```
POST /api/v1/workflows/:id/update/:name
{ "payload": { ... }, "timeout": 5000, "idempotencyKey": "..." }
→ { "updateId": "...", "result": { ... } }
```

See the [synchronous updates guide](./synchronous-updates.md) for details on the update model.

**Check update result:**

```
GET /api/v1/updates/:updateId
→ { "status": "completed", "result": { ... } }
→ { "status": "pending" }  (202 if still processing)
```

**Get/set search attributes:**

```
GET  /api/v1/workflows/:id/attributes
PATCH /api/v1/workflows/:id/attributes
{ "attributes": { "priority": 5, "region": "us-east" } }
```

**Metrics (Prometheus-compatible):**

```
GET /v1/metrics
→ text/plain with HELP/TYPE/value lines
```

**Task diagnostics:**

```
GET /api/v1/tasks/diagnostics?workflowId=<workflow-id>&queue=default&limit=25
→ { "items": [...], "summary": { ... }, "limit": 25 }
```

The diagnostics endpoint requires `system:read` and returns bounded evidence for stuck queued tasks, stale in-flight tasks, retry storms, and all-workers-at-capacity conditions. Use it when low-cardinality task metrics show a problem and you need workflow, operation, queue, or worker-level context.

## WebSocket upgrade paths

The server supports WebSocket connections for real-time streaming. When a request includes the `Upgrade: websocket` header, the server upgrades the connection and subscribes it to the matching path.

Three WebSocket routes are available:

- `/api/v1/workflows/:id/watch` — observe workflow state changes in real time
- `/api/v1/tasks/:queue/stream` — [remote worker](./remote-workers.md) task dispatch

HTTP long-poll task requests use the request's `AbortSignal`. If the client
disconnects before or during the poll, the waiter settles promptly and does
not claim a pending task for a caller that can no longer complete it.

## The `handleRequest()` function

Under the hood, `serve()` delegates to `handleRequest()`—a pure function that maps a `Request` to a `Response` with no Bun-specific dependencies. This is intentional. If you need to embed Weft's API inside an existing server or use a different HTTP framework, import `handleRequest` directly:

```typescript partial
import { handleRequest } from 'weft/server/handler';

// Inside your existing server
const response = await handleRequest(request, engine);
```

Route matching uses a table of regex patterns. Each route extracts named parameters (`:id`, `:name`, etc.) from the URL path and dispatches to the appropriate handler function.

## Content negotiation

All response-producing endpoints support content negotiation. If the `Accept` header includes `application/msgpack`, responses are serialized with MessagePack instead of JSON. This reduces payload size for binary-heavy responses. JSON is the default fallback.

## Service Worker

The same `handleRequest()` function that powers the Bun server also powers the Service Worker runtime. In the browser, a Service Worker intercepts `fetch` events and routes them through the engine—your client code calls `fetch("/weft/v1/workflows", ...)` and the Service Worker responds, no network required.

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
// `recover: false` defers recovery until after registration — register your
// activities and workflows below, then call `await engine.recoverAll()` once.
const engine = await Engine.create({ storage, recover: false });

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
