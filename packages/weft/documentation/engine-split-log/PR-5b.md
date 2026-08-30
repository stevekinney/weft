# PR 5b: WebSocket Runtime Extraction

`serve()` now delegates WebSocket upgrade, worker-session message handling, and
token stream socket bookkeeping to `src/server/runtime/`.

Moved pieces:

- `src/server/runtime/context.ts` exports the internal `ServerContext` shape
  introduced in PR 5a.
- `src/server/runtime/websocket-upgrade.ts` owns WebSocket URL classification
  and upgrade-data construction.
- `src/server/runtime/websocket-worker.ts` owns worker WebSocket registration,
  task-result, and heartbeat message dispatch.
- `src/server/runtime/websocket-stream.ts` owns token stream socket tracking,
  replay from durable storage, duplicate suppression, and live fan-out.

`src/server/index.ts` still owns the Bun server lifecycle, authentication gate,
HTTP task polling/result routes, dispatch, visibility scanning, reconciliation,
worker disconnect cleanup, and event broadcasting. The extracted helpers receive
`ServerContext`, `ServeOptions`, the Bun server handle, or
`cleanupWorkflowIndex()` explicitly where they previously closed over those
values.

No public exports were added from `src/index.ts`, and the WebSocket protocol,
upgrade handshake, and worker message semantics are intended to remain
unchanged.
