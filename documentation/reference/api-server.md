# Server API

Weft includes a built-in HTTP + WebSocket server that exposes workflows over a REST API, JSON-RPC, WebSocket subscriptions, and authenticated fetch-based Server-Sent Events. The `serve()` function wraps `Bun.serve()` with WebSocket upgrade support and clean shutdown. The `handleRequest()` function is a platform-agnostic request handler you can embed in your own server.

## `serve()`

```ts partial
function serve(options: ServeOptions): WeftServer;
```

Start the Weft HTTP + WebSocket + SSE server. Returns a `WeftServer` handle for introspection and shutdown.

```ts partial
import { Engine, workflow } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';

const engine = new Engine();
engine.register(
  workflow({ name: 'greet' }).execute(async function* (context, name) {
    return `Hello, ${name}!`;
  }),
);

const server = serve({ engine, port: 7233 });
console.log(`Weft server running at ${server.url}`);
```

---

## `ServeOptions`

```ts partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  development?: boolean;
  dashboard?: DashboardRouteTarget;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cors?: CorsOptions;
  unauthenticatedAccess?: 'warn' | 'allow' | 'reject';
  maxRequestBodyBytes?: number;
  maxStreamConnectionsPerWorkflow?: number;
  visibilityPollIntervalMs?: number;
  workerReconnectGracePeriodMs?: number;
  workerShutdownTimeoutMs?: number;
  routingPolicy?: RoutingPolicy;
  schedulingPolicy?: SchedulingPolicy;
  prometheusExporter?: PrometheusExporter;
}
```

| Field                             | Type                            | Default          | Description                                                                               |
| --------------------------------- | ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `engine`                          | `Engine`                        | (required)       | The engine instance to expose over HTTP                                                   |
| `port`                            | `number`                        | `7233`           | TCP port to listen on                                                                     |
| `hostname`                        | `string`                        | `'0.0.0.0'`      | Hostname/IP to bind to                                                                    |
| `development`                     | `boolean`                       | `false`          | Enable development mode with verbose error responses                                      |
| `dashboard`                       | `DashboardRouteTarget`          | `undefined`      | External dashboard shell served at supported page routes when supplied                    |
| `auth`                            | `AuthConfig`                    | `undefined`      | Authentication configuration (JWT, mTLS, or custom)                                       |
| `rateLimit`                       | `RateLimitConfig`               | `undefined`      | Optional single-process request throttling                                                |
| `cors`                            | `CorsOptions`                   | `undefined`      | Optional browser cross-origin policy                                                      |
| `unauthenticatedAccess`           | `'warn' \| 'allow' \| 'reject'` | `'warn'`         | Startup policy when `auth` is omitted                                                     |
| `maxRequestBodyBytes`             | `number`                        | `1048576`        | Maximum body size for REST operation routes and JSON-RPC over HTTP                        |
| `maxStreamConnectionsPerWorkflow` | `number`                        | `100`            | Maximum concurrent workflow stream/watch WebSocket and event SSE connections per workflow |
| `visibilityPollIntervalMs`        | `number`                        | `5000`           | Polling interval for task visibility timeout checks                                       |
| `workerReconnectGracePeriodMs`    | `number`                        | `2000`           | Milliseconds before a disconnected worker's in-flight tasks are requeued                  |
| `workerShutdownTimeoutMs`         | `number`                        | `30000`          | Milliseconds `server.stop()` waits for connected workers to drain                         |
| `routingPolicy`                   | `RoutingPolicy`                 | `'least-loaded'` | Worker routing policy                                                                     |
| `schedulingPolicy`                | `SchedulingPolicy`              | `'priority'`     | Scheduling policy for task dispatch                                                       |
| `prometheusExporter`              | `PrometheusExporter`            | `undefined`      | Exporter that produces the response body for `/v1/metrics`                                |

See [configuration.md](./configuration.md) for `AuthConfig`, `RateLimitConfig`, `CorsOptions`, `RoutingPolicy`, and `SchedulingPolicy` details. The [server guide](../guides/server.md#rate-limiting) covers rate limiting, and the [CORS section](../guides/server.md#cross-origin-resource-sharing-cors) covers browser cross-origin policy.

When `auth` is omitted, [`serve()`](#serve) defaults to `unauthenticatedAccess: 'warn'`: it starts, logs a startup warning, and leaves non-public operations reachable to any network client. Set `unauthenticatedAccess: 'reject'` or [`WEFT_SERVER_AUTHENTICATION_REQUIRED=1`](./configuration.md#environment-variables) in production so startup fails before binding unless an `auth` configuration is present. Set `unauthenticatedAccess: 'allow'` only for intentionally open local process boundaries; it does not override `WEFT_SERVER_AUTHENTICATION_REQUIRED`.

`workerReconnectGracePeriodMs` is clamped to `0..5000`. A same-`workerId` reconnect inside the window cancels the pending requeue and keeps the worker's in-flight assignments. The default is `2000` ms because Weft's common single-node and local-first deployments need a short buffer for transient socket churn without delaying genuine dead-worker detection for a full cloud drain window. Set `100` only for low-latency test or embedded scenarios. Set `5000` for cloud or load-balancer deployments where replacement workers commonly need several seconds to reconnect. `0` disables the grace period and requeues synchronously from the close handler.

`maxRequestBodyBytes` applies to REST operation routes and JSON-RPC over HTTP; oversized bodies return `413 Payload Too Large` before the full body is buffered. `maxStreamConnectionsPerWorkflow` applies to `/v1/workflows/:id/stream`, `/v1/workflows/:id/watch`, and `/v1/workflows/:id/events/sse`; connections over the per-workflow cap are closed with WebSocket policy-violation code `1008` or rejected with `429` for workflow SSE.

`server.stop()` drains connected remote workers before stopping the Bun server. It sends each worker a shutdown frame, accepts in-flight `taskResult` messages during the drain window, and waits up to `workerShutdownTimeoutMs` before teardown continues. The CLI `serve` signal handlers use the same stop path.

---

## `WeftServer`

```ts
interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): Promise<void>;
}
```

| Property                  | Type                  | Description                                       |
| ------------------------- | --------------------- | ------------------------------------------------- |
| `port`                    | `number`              | The resolved port the server is listening on      |
| `hostname`                | `string`              | The resolved hostname                             |
| `url`                     | `string`              | Full URL string, e.g. `http://0.0.0.0:7233`       |
| `stop()`                  | `() => Promise<void>` | Gracefully shut down the server                   |
| `[Symbol.asyncDispose]()` | `() => Promise<void>` | Same as `stop()` -- supports `await using` syntax |

```ts partial
{
  await using server = serve({ engine });
  // server shuts down when this block exits
}
```

---

## `handleRequest()`

```ts partial
async function handleRequest(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response>;
```

A pure HTTP request handler that maps a `Request` to a `Response`. Has no Bun-specific dependencies -- suitable for embedding in any server framework that uses the Web `Request`/`Response` API.

`HandlerOptions` accepts an operation registry, REST bindings, a Prometheus exporter, and optional live `WorkerRegistry` and `TaskQueue` instances. Pass the worker registry and task queue when embedding Weft in a host that constructs its own `handleRequest()` pipeline; the default operation registry uses those instances for worker, queue, and task-diagnostics routes. Omit both to use the defaults created by the handler.

```ts partial
import { handleRequest } from '@lostgradient/weft/server/handler';

// Use inside a custom Bun.serve, Deno.serve, or any framework
const response = await handleRequest(request, engine);
```

---

## REST API Routes

The handler exposes the following routes under the `/v1` prefix:

### Health

| Method | Path         | Description                                                                                                                    |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/health` | Health check. Returns `{ status: 'ok' }`. Anonymous — no authentication required. Supports content negotiation (JSON/msgpack). |

### Workflows

| Method   | Path                                        | Description                                                                          |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST`   | `/api/v1/workflows`                         | Start a new workflow                                                                 |
| `GET`    | `/api/v1/workflows`                         | List workflows — see [Visibility filters](#list-workflows----query-parameters) below |
| `GET`    | `/api/v1/workflows/aggregate`               | Group-by counts over the same filter shape                                           |
| `POST`   | `/api/v1/workflows/start-or-signal`         | Start a workflow or signal an existing non-terminal run atomically                   |
| `GET`    | `/api/v1/workflows/:id`                     | Get workflow state                                                                   |
| `GET`    | `/api/v1/workflows/:id/schedule-provenance` | Get the schedule occurrence that launched the workflow                               |
| `GET`    | `/api/v1/workflows/:id/finalizer`           | Get durable finalizer progress or outcome                                            |
| `DELETE` | `/api/v1/workflows/:id`                     | Cancel a workflow                                                                    |
| `GET`    | `/api/v1/workflows/:id/result`              | Await workflow result (30s default long-poll timeout, configurable up to 60s)        |
| `POST`   | `/api/v1/workflows/:id/suspend`             | Suspend an inline workflow without settling `result()`                               |
| `POST`   | `/api/v1/workflows/:id/resume`              | Resume a suspended workflow or a persisted running workflow                          |

#### Start Workflow -- Request Body

```json
{
  "type": "send-email",
  "input": { "to": "user@example.com", "body": "Hello!" },
  "id": "optional-custom-id",
  "executionTimeout": "5m"
}
```

Returns `201` with `{ "id": "<workflow-id>" }`.

#### Start or Signal Workflow -- Request Body

```json
{
  "type": "approval",
  "input": { "orderId": "order-123" },
  "signalName": "payment",
  "signalPayload": { "status": "succeeded" },
  "idempotencyKey": "payment-webhook-order-123"
}
```

Returns `201` with `{ "id": "<workflow-id>", "outcome": "started" | "signalled" }`. Supply exactly one of `signalId` or `idempotencyKey`. Concurrent callers converge only with a shared `idempotencyKey`, or with a shared `id` plus `signalId`; a bare `signalId` does not converge absent-target callers because each one generates a different workflow id. Terminal targets return `409 Conflict` by default. To replace a terminal prior run under a stable id, send `onTerminalConflict: "start-new"` with `id` and `signalId`; this option rejects `idempotencyKey`. Spent idempotency keys also return `409 Conflict`.

#### List Workflows -- Query Parameters

| Parameter                                              | Type     | Description                                                                          |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `status`                                               | `string` | Filter by status. Repeat for an OR filter (e.g. `?status=running&status=pending`).   |
| `type`                                                 | `string` | Filter by workflow type.                                                             |
| `schedule_id`                                          | `string` | Filter by the schedule that launched the workflow.                                   |
| `parent_workflow_id`                                   | `string` | Filter to direct children of this stable parent workflow ID.                         |
| `parent_workflow_execution_token`                      | `string` | Isolate one parent run; requires `parent_workflow_id`.                               |
| `tag`                                                  | `string` | Filter by tag. Repeat to AND multiple tags.                                          |
| `id_prefix`                                            | `string` | Match workflow ids starting with this prefix. Restricted to `[A-Za-z0-9_-]+`.        |
| `failure_category`                                     | `string` | One of `application`, `timeout`, `cancellation`, `resource`, `system`. Repeats OR.   |
| `created_at_{gte,gt,lte,lt}`                           | `number` | Filter by `createdAt` (ms epoch). At most one of `gte`/`gt` and one of `lte`/`lt`.   |
| `updated_at_{gte,gt,lte,lt}`                           | `number` | Filter by `updatedAt` (ms epoch).                                                    |
| `execution_deadline_{gte,gt,lte,lt}`                   | `number` | Filter by `executionDeadline` (ms epoch).                                            |
| `attribute.<name>`, `attribute.<name>.{gte,gt,lte,lt}` | `string` | Filter by indexed search attribute (equality or range).                              |
| `include`                                              | `string` | Set to `failureCategory` to populate `WorkflowSummary.failureCategory` on responses. |
| `limit`                                                | `number` | Page size (max 1000).                                                                |
| `offset`                                               | `number` | Page offset.                                                                         |

Results are ordered by `createdAt` descending with `id` ascending as the tiebreaker. Invalid filter values surface as a `400` (`Unprocessable`) with a structured error before any storage scan begins.

#### Aggregate Workflows -- Query Parameters

`GET /api/v1/workflows/aggregate` accepts every list-workflow filter parameter (except `limit`/`offset`, which are interpreted differently) plus:

| Parameter  | Type     | Description                                                                                    |
| ---------- | -------- | ---------------------------------------------------------------------------------------------- |
| `group_by` | `string` | Required. One of `status`, `type`, `failureCategory`, or `attribute:<name>`.                   |
| `limit`    | `number` | Cap on the number of returned groups (default 1000, max 10000). Excess groups set `truncated`. |

Response shape:

```json
{
  "total": 42,
  "groups": [
    { "key": "running", "count": 24 },
    { "key": "completed", "count": 18 }
  ],
  "truncated": false
}
```

Groups are sorted by `count` descending with `key` ascending as the tiebreaker. Workflows missing the dimension bucket under `key: null`.

If an aggregate would materialize more than 100,000 distinct group keys the request fails with a `400` (`Unprocessable`) rather than silently truncating, since truncation would let scan-order bias which groups "win." Narrow the filter or choose a lower-cardinality `group_by`.

### Signals

| Method | Path                                 | Description      |
| ------ | ------------------------------------ | ---------------- |
| `POST` | `/api/v1/workflows/:id/signal/:name` | Deliver a signal |

Request body: `{ "payload": <any> }` (optional).

### Updates

| Method | Path                                 | Description                           |
| ------ | ------------------------------------ | ------------------------------------- |
| `POST` | `/api/v1/workflows/:id/update/:name` | Send an update and await the response |
| `GET`  | `/api/v1/updates/:updateId`          | Poll for an update result             |

Update request body:

```json
{
  "payload": { "key": "value" },
  "timeout": 30000,
  "idempotencyKey": "optional-dedup-key"
}
```

### Attributes

| Method  | Path                               | Description                 |
| ------- | ---------------------------------- | --------------------------- |
| `GET`   | `/api/v1/workflows/:id/attributes` | Get search attributes       |
| `PATCH` | `/api/v1/workflows/:id/attributes` | Set/merge search attributes |

PATCH body: `{ "attributes": { "key": "value" } }`.

### Schedules

| Method   | Path                           | Description        |
| -------- | ------------------------------ | ------------------ |
| `POST`   | `/api/v1/schedules`            | Create a schedule  |
| `GET`    | `/api/v1/schedules`            | List schedules     |
| `GET`    | `/api/v1/schedules/:id`        | Get schedule state |
| `PATCH`  | `/api/v1/schedules/:id`        | Update a schedule  |
| `DELETE` | `/api/v1/schedules/:id`        | Cancel a schedule  |
| `POST`   | `/api/v1/schedules/:id/pause`  | Pause a schedule   |
| `POST`   | `/api/v1/schedules/:id/resume` | Resume a schedule  |

Use `POST /api/v1/schedules/:id/resume` to resume a paused schedule. There is no
`/unpause` alias.

`PATCH /api/v1/schedules/:id` requires exactly one cadence field —
`cronExpression` or `every` — and also accepts `description`, `overlap`,
`backfill`, and `jitter`. Omitted options retain their persisted values; the
schedule id, workflow type, and input cannot be changed. `description: null` is
invalid, while an omitted `description` leaves it unchanged. Active schedules
replace their next timer; paused schedules remain paused.

Schedule read and mutation operations are also available over JSON-RPC as
`weft.schedules.get`, `weft.schedules.update`, `weft.schedules.cancel`,
`weft.schedules.pause`, and `weft.schedules.resume`. Schedule operations use
their operation-catalog access policy consistently across REST and JSON-RPC:

| Operation                                   | Access policy                    |
| ------------------------------------------- | -------------------------------- |
| `weft.schedules.list`, `weft.schedules.get` | Authenticated principal required |
| `weft.schedules.create`                     | Public operation entry           |
| `weft.schedules.update`                     | Public operation entry           |
| `weft.schedules.cancel`                     | Public operation entry           |
| `weft.schedules.pause`                      | Public operation entry           |
| `weft.schedules.resume`                     | Public operation entry           |

Transport-level authenticators can still reject a request before it reaches the
operation catalog.

### Bulk Operations

Bulk operations are filter-driven and require a scoped `filter` object. A
filter can include `status`, `type`, `tags`, `attributes`, `limit`, and
`offset`, matching the `engine.list()` filter shape used by the in-process
API. On authenticated servers, callers must have the `workflows:admin` scope.

| Method   | Path                            | Description                              |
| -------- | ------------------------------- | ---------------------------------------- |
| `POST`   | `/api/v1/workflows/bulk/cancel` | Cancel multiple workflows                |
| `POST`   | `/api/v1/workflows/bulk/signal` | Signal multiple workflows                |
| `DELETE` | `/api/v1/workflows/bulk`        | Delete multiple terminal workflows       |
| `PATCH`  | `/api/v1/workflows/bulk/tags`   | Add or remove tags on multiple workflows |

Run a preview first by sending `dryRun: true` and an optional `requestId`:

```json
{
  "filter": {
    "status": "running",
    "type": "checkout",
    "tags": ["nightly"]
  },
  "dryRun": true,
  "requestId": "ops-2026-05-12"
}
```

The preview returns a stable confirmation token plus the matched count, scope
summary, and sampled workflow IDs:

```json
{
  "dryRun": true,
  "action": "cancel",
  "matched": 2,
  "requestId": "ops-2026-05-12",
  "confirmationToken": "bulk:...",
  "confirmationTokenVersion": 1,
  "sampleWorkflowIds": ["wf-1", "wf-2"],
  "scope": {
    "matched": 2,
    "filter": { "status": "running", "type": "checkout", "tags": ["nightly"] },
    "statuses": ["running"],
    "workflowTypes": ["checkout"],
    "sampleWorkflowIds": ["wf-1", "wf-2"],
    "sampleLimit": 20
  }
}
```

Commit the operation by resending the same scoped filter with the
`confirmationToken` returned by the preview. If the current matched workflow
scope has changed, the commit fails and the caller must preview again.
Committed operations persist a durable audit event with the credential-safe
caller principal, action, request ID, filter summary, affected count, sampled
workflow IDs, and confirmation token.

Signal requests also include `name` and an optional `payload` field. Tag
requests include `operation: "add" | "remove"` and a `tags` array. Bulk delete
only applies to terminal workflows and returns `422` if the filter would match
pending or running workflows.

### Checkpoints & Replay

| Method | Path                                | Description                       |
| ------ | ----------------------------------- | --------------------------------- |
| `GET`  | `/api/v1/workflows/:id/checkpoints` | List workflow checkpoints         |
| `POST` | `/api/v1/workflows/:id/replay`      | Replay workflow from a checkpoint |
| `POST` | `/api/v1/workflows/:id/fork`        | Fork a workflow from a checkpoint |

### Reviews

| Method | Path                                 | Description                                   |
| ------ | ------------------------------------ | --------------------------------------------- |
| `GET`  | `/api/v1/reviews`                    | List human reviews, optionally with filters   |
| `POST` | `/api/v1/reviews/:reviewId/decision` | Submit a review decision for a pending review |

`GET /api/v1/reviews` defaults to pending reviews only. Optional query parameters:

- `status=pending|completed`
- `workflowId=<workflow-id>`
- `reviewType=<review-type>`

Each response item includes a `status` discriminator. Pending entries expose the original review request metadata. Completed entries include the persisted reviewer decision plus the original request metadata.

When server authentication is enabled, `GET /api/v1/reviews` requires the `reviews:read` scope.

### Async Activities

| Method | Path                                             | Description                                      |
| ------ | ------------------------------------------------ | ------------------------------------------------ |
| `GET`  | `/api/v1/workflows/:id/pending-async-activities` | List durable pending tokens with bounded cursors |
| `POST` | `/api/v1/activities/complete`                    | Complete a deferred activity by task token       |
| `POST` | `/api/v1/activities/fail`                        | Fail a deferred activity by task token           |

Activities that call `ActivityContext.completeAsync()` park their workflow until an external process resolves the durable task token announced by the `activity:async-pending` event. `complete` accepts `{ "token": string, "result"?: unknown }`; `fail` accepts `{ "token": string, "error": { "message": string, "name"?: string } }`. Both return `{ "ok": true }` on success.

`weft.workflows.activities.pending.list` exposes the query over every JSON-RPC transport. It accepts `workflowId`, optional `limit` (default 50, maximum 200), and an opaque optional `cursor`, and returns `{ "items": [...], "nextCursor"?: string }`. Each item contains `token`, `operationId`, `activityName`, `step`, `attempt`, and `createdAt`. Pages follow deterministic durable-key order. Malformed records and acknowledged resolution records are omitted; the cursor still advances over them so they cannot stall pagination. The query requires `workflows:read`.

The mutation operation names are `weft.activities.complete` and `weft.activities.fail`, and both require `workflows:write` over REST and JSON-RPC. Configure server authentication before exposing these routes; anonymous callers receive `Unauthorized`, while authenticated callers without the required scope receive `Forbidden`.

The token travels in the JSON body, never the URL path. Tokens are deterministic identifiers, not secrets, and they are single-use: an unknown or already-consumed token returns `404` / `NotFound`; malformed JSON or oversized completion payloads return `400` / `InvalidParams` before consuming the token. Unexpected engine failures keep the normal REST/JSON-RPC fault split: REST masks internal failures, while JSON-RPC receives the operation fault object.

### Discovery

The operation catalog is the unified, transport-neutral registry of every operation Weft exposes. The discovery routes serve machine-readable schemas derived from the same registry that powers REST, JSON-RPC, and WebSocket dispatch.

| Method | Path                       | Description                                      |
| ------ | -------------------------- | ------------------------------------------------ |
| `GET`  | `/.well-known/api-catalog` | RFC 9264 linkset for API discovery documents     |
| `GET`  | `/.well-known/mcp.json`    | MCP discovery document for Weft MCP transports   |
| `GET`  | `/openapi.json`            | OpenAPI 3.1 contract for the operation catalog   |
| `GET`  | `/openrpc.json`            | OpenRPC 1.3.2 contract with Weft MCP metadata    |
| `GET`  | `/asyncapi.json`           | AsyncAPI 3.0 contract for streaming and channels |

**`GET /openapi.json`** — OpenAPI 3.1 document describing every REST-bound operation. Useful for client codegen, request validation, and Swagger-style UIs. Schemas are generated from the same Zod definitions the server uses at runtime, so the document never drifts from the implementation.

**`GET /openrpc.json`** — OpenRPC 1.3.2 document describing every JSON-RPC method. Pair this with `/api/jsonrpc` (WebSocket) or JSON-RPC-over-HTTP for typed RPC clients. The root-level `x-weft-mcp` extension identifies the live MCP discovery surface and marks MCP-exposable operation methods with method-level `x-weft-mcp` metadata.

Every operation-catalog entry in both documents carries `x-weft-access`, a faithful copy of the operation's static access policy. The extension preserves the policy structure instead of flattening it into a scope list:

- `{ "kind": "public" }` means the operation catalog adds no authentication requirement.
- `{ "kind": "authenticated" }` requires an authenticated principal.
- `{ "kind": "scoped", "scopes": { "kind": "anyOf" | "allOf", "scopes": [...] } }` preserves whether any listed scope or every listed scope is required.
- `{ "kind": "optionalAuth", "authenticatedScopes": ... }` permits anonymous callers but applies the nested scope requirement when credentials are present.
- `{ "kind": "scopedAlternatives", "alternatives": [...] }` preserves each acceptable `anyOf` or `allOf` requirement as a separate alternative.

When authorization varies with an input field, the entry also carries `x-weft-parameterizedAccess`. Its `discriminator` names the input field, optional `defaultValue` records the behavior when that field is omitted, and each `{ "value", "access" }` variant uses the same complete access-policy shape. `x-weft-access` remains the static catalog gate applied to every invocation; `x-weft-parameterizedAccess` describes the additional parameter-aware authorization performed by that operation.

These extensions describe operation authorization, while OpenAPI's standard `security` arrays continue to describe supported credential mechanisms. Weft's bearer and API-key schemes therefore keep their standard empty scope arrays. Direct HTTP infrastructure routes such as health and discovery documents are not operation-catalog entries, retain their existing `security` declarations, and do not carry the Weft access extensions. The synthetic OpenRPC `rpc.discover` method is dispatched before operation authorization and therefore advertises `{ "kind": "public" }` explicitly. A `public` operation policy also does not override authentication that the surrounding server or deployment requires.

**`GET /.well-known/mcp.json`** — minimal MCP discovery document. It points remote clients at the Streamable HTTP MCP endpoint (`POST`, `GET`, and `DELETE /api/mcp`), names `tools/list` as the canonical live tool introspection method, and includes the `weft-mcp` stdio command for local clients.

The OpenAPI and OpenRPC documents enumerate operations from the unified catalog. To see which transports an operation is bound to, look at the `tags` and binding metadata in the document. To see the input/output schemas for an operation, follow the `$ref` links into `components.schemas`. To build a scope matrix without guessing from tags or operation names, read `x-weft-access` and any `x-weft-parameterizedAccess` variants.

### MCP Server

The MCP server exposes Weft workflows to [Model Context Protocol](https://modelcontextprotocol.io/) clients. It is not a fifth operation-catalog transport: `tools/list`, `tools/call`, and `resources/read` are MCP methods that adapt registered workflows and workflow resources into the MCP protocol.

Discovery starts at `GET /.well-known/mcp.json`. The document advertises the live Streamable HTTP endpoint, the local `weft-mcp` stdio command, and the live MCP methods clients should call for tool and resource introspection. In production, configure `serve({ publicOrigin })` or `serve({ trustedHosts })` before serving this route because it emits absolute endpoint URLs.

| Method   | Path       | Description                                             |
| -------- | ---------- | ------------------------------------------------------- |
| `POST`   | `/api/mcp` | Client-to-server MCP JSON-RPC messages                  |
| `GET`    | `/api/mcp` | Server-to-client event stream for session notifications |
| `DELETE` | `/api/mcp` | Close an MCP session identified by `Mcp-Session-Id`     |

`POST /api/mcp` accepts `initialize` without an existing session and returns `Mcp-Session-Id`. It also returns `Mcp-Session-Token` on that initialize response. Every subsequent POST, GET, or DELETE request sends the session id; anonymous sessions created while server authentication is disabled must also send the continuation token, so a leaked session id alone cannot drive, read, or close another caller's MCP session. Requests may also send `Mcp-Protocol-Version`; unsupported versions return `400`.

When server authentication is enabled, MCP requests pass through the same authentication bridge as REST and JSON-RPC before they reach the MCP dispatcher. The authenticated principal is bound to the MCP session created by `initialize`, and every subsequent request is authorized against that principal's scopes. Authenticated sessions re-present their credential on continuation requests, so the continuation token is only an extra gate for anonymous sessions.

MCP tool discovery includes:

- Built-in workflow-control tools: `start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, and `get_workflow_state`
- Registered workflows that provide an `inputSchema`; tool names are lowercase with underscores

Activities are never exposed as standalone MCP tools. Workflow tool failures are returned as MCP tool results with `isError: true` instead of JSON-RPC protocol errors.

MCP resource discovery includes workflow state, event log, checkpoint history, and workflow-search templates. Subscribing to a workflow resource sends `notifications/resources/updated` over the GET event stream when that workflow changes.

The `@lostgradient/weft/mcp` subpath exports the server helpers for embedding, and the `weft-mcp` binary runs a local MCP stdio session against memory or SQLite storage. Local stdio admission is explicit: use `--startup-token <token>` for a first-frame authentication gate, or `--allow-unauthenticated-local-admin` only for trusted local process boundaries.

When `--startup-token` is set, the first newline-delimited stdio frame must be a JSON-RPC request using `weft.authenticate`:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "weft.authenticate", "params": { "token": "<value>" } }
```

A matching token receives:

```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

Invalid JSON, a missing token, or a mismatched token returns JSON-RPC error code `-32010` and exits with code `2`. A clean stdio session exits `0`; an unexpected session error exits `1`.

### Storage Operations

> [!NOTE]
> The raw key-value routes are HTTP-only — they're not exposed over JSON-RPC, WebSocket, or stdio. Their operation names (`weft.storage.get`, `weft.storage.put`, etc.) appear in `/openapi.json` but not in `/openrpc.json`. Capability discovery is read-only and is available through every REST and JSON-RPC transport as `weft.storage.capabilities`.

Raw key-value access to the engine's storage layer, used by `HTTPStorage` and any client that wants to treat a Weft server as a remote storage backend. The capability discovery route (`GET /api/v1/storage/-/capabilities`) reports adapter metadata and accepts either `storage:read` or `storage:admin`. All other routes operate directly on the unscoped keyspace and require the `storage:admin` scope.

| Method   | Path                                  | Description                             |
| -------- | ------------------------------------- | --------------------------------------- |
| `GET`    | `/api/v1/storage/-/capabilities`      | Report the backend's capability profile |
| `GET`    | `/api/v1/storage/:key`                | Read a single value                     |
| `PUT`    | `/api/v1/storage/:key`                | Write a single value                    |
| `DELETE` | `/api/v1/storage/:key`                | Delete a single value                   |
| `GET`    | `/api/v1/storage`                     | Scan keys by prefix (NDJSON stream)     |
| `POST`   | `/api/v1/storage/-/batch`             | Apply a batch of put/delete operations  |
| `POST`   | `/api/v1/storage/-/conditional-batch` | Apply a compare-and-swap batch          |

#### Authorization

Every storage route requires authentication. Required scopes:

| Routes                                      | Required scope                    |
| ------------------------------------------- | --------------------------------- |
| `GET /api/v1/storage/-/capabilities`        | `storage:read` or `storage:admin` |
| Every endpoint that reads or mutates raw KV | `storage:admin`                   |

#### Keyspace access

Raw storage routes operate on the unscoped keyspace, so narrower `storage:read` and `storage:write` scopes do not grant access, even when a principal holds both. Without `storage:admin`, the server returns 403 with a `Forbidden` fault.

#### `GET /api/v1/storage/-/capabilities`

Report the exact `StorageCapabilities` profile returned by the engine's connected storage adapter. This endpoint exposes deployment metadata, not raw keys or values, so the narrower `storage:read` scope is sufficient; existing storage-administrator credentials are also accepted. The equivalent `weft.storage.capabilities` operation is available through JSON-RPC over HTTP, WebSocket, and stdio, including `LocalClient.operations`, `HttpClient.operations`, and `client.call()`.

- **Required scope** — `storage:read` or `storage:admin`.
- **Success response** — `200 OK`, `Content-Type: application/json`.

```json
{
  "persistence": "local",
  "readAfterWrite": "linearizable",
  "scanConsistency": "snapshot",
  "atomicBatch": true,
  "conditionalBatch": true,
  "boundedRangeDelete": true
}
```

The values are the adapter's honest self-report; the server does not infer or strengthen them. See [`StorageCapabilities`](api-storage.md#storagecapabilities) for each field's contract.

#### `GET /api/v1/storage/:key`

Read a value by key.

- **Path parameter `:key`** — URL-encoded storage key. The server decodes it before lookup, so application keys can contain any characters except those forbidden in URL paths.
- **Required scope** — `storage:admin`.
- **Success response** — `200 OK`, `Content-Type: application/octet-stream`, body is the raw value bytes.
- **Missing key** — `404 Not Found`, empty body.

```http
GET /api/v1/storage/wf%3Acheckout-123 HTTP/1.1
Authorization: Bearer <token>
```

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream

<raw bytes>
```

#### `PUT /api/v1/storage/:key`

Write a value by key. Overwrites any existing value.

- **Path parameter `:key`** — URL-encoded storage key.
- **Required headers** — `Authorization`, `Content-Type: application/octet-stream`.
- **Request body** — raw value bytes.
- **Required scope** — `storage:admin`.
- **Success response** — `204 No Content`.

```http
PUT /api/v1/storage/wf%3Acheckout-123 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/octet-stream

<raw bytes>
```

```http
HTTP/1.1 204 No Content
```

#### `DELETE /api/v1/storage/:key`

Delete a value by key. No-op if the key does not exist.

- **Path parameter `:key`** — URL-encoded storage key.
- **Required scope** — `storage:admin`.
- **Success response** — `204 No Content`.

#### `GET /api/v1/storage`

Stream key-value pairs whose keys start with a prefix.

- **Query parameters** (verified against `extractStorageScanInput`):
  - `prefix` (optional) — prefix to scan. Defaults to empty string, which scans everything visible to the principal.
  - `limit` (optional) — positive integer; maximum number of entries returned.
  - `reverse` (optional) — `"true"` or `"false"` (string-typed in the query). Reverses lexicographic order.
  - `gt`, `gte`, `lt`, `lte` (optional) — string bounds on the key.
- **Required scope** — `storage:admin`.
- **Success response** — `200 OK`, `Content-Type: application/x-ndjson`. Each line is `{"key": "...", "value": "<base64>"}\n`. The stream is lazy: the underlying storage scan only advances as the response body is consumed.

The `HTTPStorage` client enforces a 64 MB total response cap on its side; if your scan would exceed that, narrow the prefix or paginate with `limit` and `gt`.

```http
GET /api/v1/storage?prefix=wf%3A&limit=100 HTTP/1.1
Authorization: Bearer <token>
```

```http
HTTP/1.1 200 OK
Content-Type: application/x-ndjson

{"key":"wf:checkout-123","value":"AAEC..."}
{"key":"wf:checkout-456","value":"AwQF..."}
```

#### `POST /api/v1/storage/-/batch`

Apply multiple put/delete operations as a single batch.

- **Required headers** — `Authorization`, `Content-Type: application/json`.
- **Request body**:

  ```json
  {
    "operations": [
      { "type": "put", "key": "string", "value": "<base64>" },
      { "type": "delete", "key": "string" }
    ]
  }
  ```

  Values are base64-encoded byte strings.

- **Required scope** — `storage:admin`.
- **Success response** — `204 No Content`.

The interface-level guarantee: the operations are submitted to the underlying storage's `batch` primitive in a single call. Atomicity guarantees come from the backend—`SQLiteStorage`, `IndexedDBStorage`, `LMDBStorage`, and `TursoStorage` apply batches inside a transaction; see [the storage backend configuration notes](../guides/storage.md#per-backend-configuration) for per-backend behavior.

#### `POST /api/v1/storage/-/conditional-batch`

Apply a compare-and-swap batch: validate every condition before applying any operation. If any condition fails, no operation runs.

- **Required headers** — `Authorization`, `Content-Type: application/json`.
- **Request body**:

  ```json
  {
    "conditions": [{ "key": "string", "expectedValue": "<base64-or-null>" }],
    "operations": [
      { "type": "put", "key": "string", "value": "<base64>" },
      { "type": "delete", "key": "string" }
    ]
  }
  ```

  `expectedValue: null` asserts the key is currently missing; a base64 string asserts the key currently holds those exact bytes.

- **Required scope** — `storage:admin`.
- **Success response** — `200 OK`, `Content-Type: application/json`, body `{ "applied": true }` or `{ "applied": false }`.

The `applied` boolean tells the caller whether the conditions all passed and the operations ran. The HTTP status is `200` either way—a `false` result is not an error, it's an expected CAS failure.

The interface-level guarantee: all conditions are checked before any operation is applied. If any condition fails, no operation runs. The application of the operations themselves is delegated to the storage backend's batch primitive; backend-specific transaction guarantees vary—see [the storage backend configuration notes](../guides/storage.md#per-backend-configuration).

### Metrics

| Method | Path          | Description                                |
| ------ | ------------- | ------------------------------------------ |
| `GET`  | `/v1/metrics` | Prometheus-compatible metrics (text/plain) |

### Live Event Streaming Routes

WebSocket upgrade is supported on the following paths:

| Path                           | Description                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| `/api/v1/workflows/:id/watch`  | Observe workflow lifecycle events; requires `events:read` with auth |
| `/api/v1/workflows/:id/stream` | Stream workflow token chunks; requires `streams:read` with auth     |
| `/api/v1/tasks/:queue/stream`  | Worker task stream                                                  |
| `/api/jsonrpc`                 | JSON-RPC over WebSocket session for the unified operation catalog   |

REST SSE is supported on the following paths when the request has `Accept: text/event-stream`:

| Path                               | Description                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `/api/v1/workflows/:id/events/sse` | Stream workflow event envelopes with `selector=events`; requires `events:read`  |
| `/api/v1/workflows/:id/events/sse` | Stream workflow token envelopes with `selector=tokens`; requires `streams:read` |
| `/api/v1/events/sse`               | Stream the fleet event feed; requires `events:read`                             |

Workflow stream/watch WebSockets and workflow event SSE connections share the `maxStreamConnectionsPerWorkflow` per-workflow cap. The default is `100`; excess WebSockets are closed with WebSocket code `1008`, and excess workflow SSE requests return `429`.

The raw WebSocket `/stream` and `/watch` routes accept `?resumeFrom=<sequence>` cursors. The cursor grammar is `-1` or a non-negative decimal integer; malformed values reject the WebSocket upgrade with `400`. A missing cursor starts before the first retained frame, and a future cursor above the durable tail is clamped to the tail so the socket can remain connected for later live frames. Raw watch replay sends at most 1,000 retained events per socket and buffers at most 1,000 live frames while replay is catching up; older cursors or overloaded replay buffers close the socket with code `1008`. The listed scope requirements apply when `auth` is configured; without `auth`, raw WebSocket routes are open to any client that can connect. Raw watch frames preserve the `{ type, timestamp, data }` event shape and include `sequence` / `cursor` fields for resumption.

The live SSE routes use the committed workflow and fleet event feeds. Data frames include `id: <cursor>`, `event: <event kind>`, and `data: <JSON event envelope>`. Connections emit `event: ping` with JSON metadata and no `id`, so keepalives never advance replay cursors. The first replay handoff ping includes `replayComplete: true`, which marks the point where initial replay has drained and live delivery is active. After headers are sent, stream failures emit a sanitized `event: error` frame and then close. Workflow SSE accepts `selector=events|tokens` and `fromCursor=<cursor>`; fleet SSE accepts `workflowId`, `kind`, and `fromCursor`. For both routes, the `Last-Event-ID` header takes precedence over `fromCursor` so reconnecting clients resume from the server-confirmed cursor. Invalid cursors fail with `400`, and requests without `Accept: text/event-stream` fail with `406`.

JSON-RPC over HTTP remains request/response only. JSON-RPC clients can subscribe to per-workflow events with `weft.workflows.subscribe` or to one fleet-wide event feed with `weft.events.subscribe` over WebSocket or stdio; both deliver notifications as `weft.events.deliver`. Fleet-wide subscriptions expose workflow-facing operational events and worker connection lifecycle events, accept optional `workflowId` and `kind` filters, reject replay windows above 1,000 matching retained events, and order their cursor on the server process that owns the durable store under Weft's current one-server-process-per-durable-store model. The finite token replay SSE route, `/api/v1/workflows/:id/sse`, remains a separate historical token stream and does not emit live `ping` keepalives.

### Error Responses

Most REST operation faults return JSON with an `error` field:

```json
{
  "error": "Workflow \"abc\" not found",
  "data": { "resource": "workflow", "identifier": "abc" }
}
```

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `400`  | Bad request (missing fields, invalid JSON, unknown workflow type) |
| `404`  | Resource not found                                                |
| `408`  | Timeout waiting for result or update response                     |
| `409`  | Conflict (duplicate workflow ID)                                  |
| `422`  | Workflow failed or cancelled (result endpoint)                    |
| `500`  | Internal server error                                             |

REST operation handlers mask unexpected `EngineFailure` faults to
`{ "error": "Internal server error" }` with status `500`, so raw engine
messages, storage details, stack traces, and file paths do not cross the HTTP
boundary. Declared client faults keep their mapped status and public message.
REST includes only audited structured fields under `data`; authentication
reasons, generic internal reasons, subscription identifiers, raw causes, and
workflow identifiers outside the caller-supplied not-found identifier remain
withheld. JSON-RPC transports receive their distinct operation fault projection
instead of the REST body shape. The [Error Codes](./api-errors.md#faultcode)
reference documents the source-complete `FaultCode` vocabulary, HTTP status
mapping, and both data projections.

---

## Service Worker

The `@lostgradient/weft/service-worker` module provides bootstrap functions for running the Weft engine inside a Service Worker. These functions wire `handleRequest()` into the Service Worker event model.

```ts partial
import {
  ServiceWorkerScheduler,
  createFetchHandler,
  createLifecycleHandlers,
  createPeriodicSyncHandler,
} from '@lostgradient/weft/service-worker';
```

---

### `ServiceWorkerOptions`

```ts partial
interface ServiceWorkerOptions {
  engine: Engine;
  pathPrefix?: string;
}
```

| Field        | Type     | Default    | Description                                       |
| ------------ | -------- | ---------- | ------------------------------------------------- |
| `engine`     | `Engine` | (required) | The engine instance to handle requests            |
| `pathPrefix` | `string` | `'/weft/'` | URL path prefix that identifies Weft API requests |

---

### `createFetchHandler()`

```ts partial
function createFetchHandler(options: ServiceWorkerOptions): (event: FetchEvent) => void;
```

Returns a `fetch` event listener. When the request URL matches the `pathPrefix`, the listener calls `event.respondWith()` with the result of `handleRequest()`. Non-matching requests pass through to the network.

```ts partial
self.addEventListener('fetch', createFetchHandler({ engine, pathPrefix: '/weft/' }));
```

---

### `createPeriodicSyncHandler()`

```ts partial
function createPeriodicSyncHandler(
  scheduler: { tick(): Promise<void> },
  tag?: string,
): (event: { tag: string; waitUntil(promise: Promise<unknown>): void }) => void;
```

Returns a `periodicsync` event listener. The default tag is `'weft-timers'`. Matching events call `scheduler.tick()` inside `event.waitUntil(...)`; non-matching events are ignored.

```ts partial
const scheduler = new ServiceWorkerScheduler({
  storage,
  onTimerFired: (entry) => engine.fireTimer(entry),
});
self.addEventListener('periodicsync', createPeriodicSyncHandler(scheduler));
```

Pass a custom tag when the page registers a non-default Periodic Background Sync tag:

```ts partial
self.addEventListener('periodicsync', createPeriodicSyncHandler(scheduler, 'custom-timers'));
```

---

### `createLifecycleHandlers()`

```ts partial
function createLifecycleHandlers(): {
  install: (event: ExtendableEvent) => void;
  activate: (event: ExtendableEvent) => void;
};
```

Returns `install` and `activate` event handlers.

- **`install`**: Calls `skipWaiting()` so the new Service Worker activates immediately without waiting for existing clients to close.
- **`activate`**: Calls `clients.claim()` so the Service Worker takes control of all open tabs without requiring a page reload.

```ts partial
const { install, activate } = createLifecycleHandlers();
self.addEventListener('install', install);
self.addEventListener('activate', activate);
```

---

### Timer wakeup

Use `createPeriodicSyncHandler()` or the exported `ServiceWorkerScheduler` from the Service Worker event handler:

```ts partial
const scheduler = new ServiceWorkerScheduler({
  storage,
  onTimerFired: (entry) => engine.fireTimer(entry),
});
self.addEventListener('periodicsync', createPeriodicSyncHandler(scheduler));
```

The manual equivalent is:

```ts partial
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'weft-timers') return;
  event.waitUntil(scheduler.tick());
});
```

Register the matching tag from page code with `registration.periodicSync.register(...)`. See the [Service Worker guide](../guides/service-worker.md) for the full browser setup.
