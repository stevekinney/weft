# PR 5c: Task Runtime Extraction

`serve()` now delegates task dispatch, HTTP long-poll task handling, and
in-flight task reconciliation to `src/server/runtime/`.

Moved pieces:

- `src/server/runtime/task-dispatch.ts` owns task priority resolution,
  WebSocket worker dispatch, long-poll queue fallback, delayed redispatch
  timers, and task cancellation messages.
- `src/server/runtime/task-polling.ts` owns `/v1/tasks/:queue` long-poll
  requests, `/v1/tasks/:queue/result` result submission, and the long-poll
  queued-to-inflight transition.
- `src/server/runtime/task-reconciliation.ts` owns visibility-timeout expiry,
  orphaned inflight reconciliation, and retry exhaustion handling.

`src/server/index.ts` still owns the Bun server lifecycle, authentication gate,
WebSocket shutdown handling, reconciliation interval scheduling,
`cleanupWorkflowIndex()`, shutdown helpers, and event broadcasting. The
extracted helpers receive `ServerContext`, `ServeOptions`, and
`cleanupWorkflowIndex()` explicitly where they previously closed over those
values.

No public exports were added from `src/index.ts`, and task dispatch ordering,
long-poll result semantics, visibility timing, and retry behavior are intended
to remain unchanged.
