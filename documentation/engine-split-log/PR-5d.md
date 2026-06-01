# PR 5d: Final Server Runtime Extraction

`serve()` now delegates the remaining shutdown, authentication, and live-event
runtime pieces to `src/server/runtime/`, leaving `src/server/index.ts` as the
Bun server coordinator.

Moved pieces:

- `src/server/runtime/shutdown.ts` owns worker shutdown messages, the default
  shutdown timeout, and all-worker shutdown fan-out.
- `src/server/runtime/authentication-bridge.ts` owns the Bun request
  authentication bridge, HTTP fetch routing, supported OpenAPI auth-scheme
  derivation, and WebSocket handler wiring.
- `src/server/runtime/event-broadcasting.ts` owns engine event serialization,
  durable event and token-stream persistence, WebSocket publication, terminal
  workflow bookkeeping cleanup, and workflow-cancellation propagation.

`src/server/index.ts` still owns the public `serve()` options and server handle
types, context construction, Bun server startup, resource disposal order,
in-flight restore, and visibility/reconciliation intervals.

No public `WeftServer` methods changed. `wireEventBroadcasting` and
`EventBroadcastingHandle` remain available from `@lostgradient/weft/server` through
re-exports from `src/server/index.ts`.
