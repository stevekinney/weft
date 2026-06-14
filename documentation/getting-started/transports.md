# Choosing a transport

Weft exposes runtime operations over four operation-catalog transports, plus a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) surface for external MCP clients. The operation-catalog transports route through the same operation registry, so the operation you call and the result you get back are the same regardless of which one you pick. MCP is different: it maps registered workflows and workflow resources into the Model Context Protocol.

## REST (`/api/v1/*`)

The default. Every cataloged operation has a REST binding with a conventional HTTP method and path. Use REST when:

- You're calling from a language or tool that speaks HTTP fluently
- You want `curl` or Postman to work without any setup
- You're integrating with infrastructure that expects HTTP (load balancers, API gateways, proxies)

Discovery: `GET /openapi.json` returns the full OpenAPI 3.1 contract.

Workflow control operations share the same operation catalog as JSON-RPC. Recent workflow-lifecycle operations are available directly over REST:

- `POST /api/v1/workflows/start-or-signal` maps to `weft.workflows.startorsignal` and returns `201` with `{ "id": "<workflow-id>" }`.
- `POST /api/v1/workflows/:id/suspend` pauses an inline workflow without cancelling it.
- `POST /api/v1/workflows/:id/resume` re-drives a suspended workflow, or one left running by a previous process.

## JSON-RPC over HTTP (`POST /api/jsonrpc`)

One endpoint, all operations, named by method. Use JSON-RPC HTTP when:

- You want to batch multiple calls into a single round-trip
- You're building a client library and want a uniform dispatch path
- You prefer named params over REST's path/query/body split

A minimal client looks like this:

```ts partial
type JsonRpcError = { code: number; data?: unknown; message: string };
type JsonRpcEnvelope =
  | { error: JsonRpcError; result?: never }
  | { error?: never; result: { id: string } };

function isJsonRpcError(value: unknown): value is JsonRpcError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Record<string, unknown>;
  return typeof error['code'] === 'number' && typeof error['message'] === 'string';
}

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  const hasError = 'error' in envelope;
  const hasResult = 'result' in envelope;
  if (hasError === hasResult) return false;
  if (hasError) return isJsonRpcError(envelope['error']);
  return true;
}

const response = await fetch('http://localhost:7233/api/jsonrpc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'weft.workflows.start',
    // Named params only — the OpenRPC contract documents paramStructure: "by-name"
    params: { type: 'helloWorld', input: 'Alice' },
  }),
});

const raw = await response.json();
if (!isJsonRpcEnvelope(raw)) {
  throw new Error(`Malformed JSON-RPC response: ${JSON.stringify(raw)}`);
}
const envelope = raw;

if ('error' in envelope) {
  // JSON-RPC errors carry a code (Weft uses the -32000 application range),
  // a message, and structured data with the HTTP-equivalent status.
  console.error('RPC error:', envelope.error);
  process.exit(1);
}

console.log('Started workflow:', envelope.result.id);
```

Discovery: `GET /openrpc.json` returns the OpenRPC 1.3.2 contract. You can also call `rpc.discover` over JSON-RPC itself—it returns the same document.

## JSON-RPC over WebSocket (`WS /api/jsonrpc`)

Same JSON-RPC protocol, persistent connection. Use WebSocket when:

- You need live event streams or subscription notifications
- You're already using WebSocket for workflow observation and want one connection
- Latency matters—once the socket is established you skip the per-call HTTP request/response cycle

Authentication happens at upgrade time. Every subsequent call on the connection reuses the established principal; you don't re-authenticate per frame.

## JSON-RPC over stdio

Opt-in, disabled by default. Newline-delimited JSON over standard input/output. Use stdio when:

- You're building a local tool or CLI that embeds a Weft engine
- You want the full operation catalog accessible from a subprocess
- You don't want to run an HTTP server

Enable it explicitly in `serve()`—it is not started automatically. Local process boundaries are the default authorization guard; optional startup-token hardening is available for stricter deployments.

## MCP over Streamable HTTP and stdio

Use MCP when an MCP client should treat Weft workflows as durable tools and resources.

Remote MCP discovery is available at `GET /.well-known/mcp.json`. In production, configure `serve({ publicOrigin })` or `serve({ trustedHosts })` first because the discovery document emits absolute endpoint URLs. The document points clients at `POST /api/mcp`, `GET /api/mcp`, and `DELETE /api/mcp` when you start the Weft server. `initialize` creates a session and returns `Mcp-Session-Id`; subsequent POST, GET, and DELETE requests send that header plus the negotiated `Mcp-Protocol-Version`. POST carries client-to-server JSON-RPC messages, GET opens the server-to-client event stream, and DELETE closes the session.

When the transport runs **without authentication** (`authRequired: false`), every anonymous caller shares one identity, so the session id alone is not a credential — and because the client must send it on every continuation request, it is routinely exposed to proxy and access logs. To isolate concurrent anonymous callers, `initialize` also returns a one-time `Mcp-Session-Token`: store it from the `initialize` response and send it as the `Mcp-Session-Token` header on every subsequent POST, GET, and DELETE for that session. The token is disclosed only on the `initialize` response and never echoed on a continuation response, so a leaked session id alone cannot drive, read, or terminate another caller's session. Authenticated sessions already re-present their credential on each request and do not require this token; the session binding for authenticated callers is unchanged.

Local MCP is exposed through the `weft-mcp` binary. It runs an embedded Weft engine over newline-delimited stdio frames. Admission is mandatory: pass `--startup-token <token>` and send `weft.authenticate` as the first frame, or use `--allow-unauthenticated-local-admin` only for trusted local process boundaries.

MCP exposes:

- Registered workflows with an `inputSchema` as lowercase-underscore tools
- Engine-control tools such as `start_workflow`, `cancel_workflow`, and `get_workflow_state`
- Workflow state, events, checkpoints, and workflow-search resources
- Resource update notifications for subscribed workflow resources

Activities are not exposed as MCP tools. A workflow without an `inputSchema` is intentionally omitted from MCP tool discovery.

## What's not on the parity surface

A few endpoints are intentionally REST-only or unauthenticated:

- `GET /openapi.json`, `GET /openrpc.json`, and `GET /.well-known/mcp.json` — describe the catalog or transport discovery surface; mounting them as catalog operations creates a circular self-description
- `GET /v1/health` — anonymous liveness probe for load balancers
- `GET /v1/metrics` — Prometheus exposition format (`text/plain`); the JSON-shaped form is `weft.system.metrics` on the catalog

SSE (`GET /api/v1/workflows/:id/sse`) is transport-specific—the JSON-RPC analogue is WebSocket subscription notifications.
