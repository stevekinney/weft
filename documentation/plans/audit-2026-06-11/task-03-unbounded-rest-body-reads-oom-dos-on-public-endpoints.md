# Task 03: Unbounded REST body reads (OOM DoS on public endpoints)

**Severity:** critical

## Unbounded REST body reads enable memory exhaustion / OOM DoS

- **Severity:** critical (security)
- **Files:** `src/server/operations/start-workflow-rest-input.ts`, `src/server/operations/bulk-filter-helpers.ts`, `src/server/operations/storage.ts`

**Evidence:** JSON-RPC HTTP and MCP paths call readBodyBounded() with 1 MB cap. REST operation paths do not: start-workflow-rest-input.ts:24 calls bare request.json(), bulk-filter-helpers.ts:102 calls request.text(), storage.ts:430 calls request.arrayBuffer() — all with no size limit. Bun buffers the entire body before resolving, so a multi-GB POST to any unauthenticated REST endpoint exhausts server memory before auth or payload-size policy fires.

**Required fix:** Extract a readRestBodyBounded(request, maxBytes) helper mirroring readBodyBounded in the JSON-RPC path (check Content-Length pre-flight, cap stream at configurable ceiling, default 1 MB). Call it from every REST extractInput function that currently calls request.json(), request.text(), or request.arrayBuffer().

## No per-workflow or global cap on stream/watch WebSocket connections

- **Severity:** medium (security)
- **Files:** `src/server/runtime/websocket-stream.ts`, `src/server/runtime/websocket-upgrade.ts`

**Evidence:** websocket-stream.ts:41-52 addStreamSocket adds to context.streamSockets with zero size guards. JSON-RPC WebSocket path has DEFAULT_MAX_SUBSCRIPTIONS=100 per session. Stream/watch upgrade path has no equivalent — an attacker can open thousands of sockets to a single workflow exhausting file descriptors.

**Required fix:** Add a maxStreamConnectionsPerWorkflow cap (default 100, configurable in ServeOptions) enforced in addStreamSocket. If exceeded, close the incoming socket with 1008 Policy Violation. Mirror the pattern from DEFAULT_MAX_SUBSCRIPTIONS in json-rpc-websocket.ts.
