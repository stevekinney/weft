# Architecture Decisions

Weft makes a lot of deliberate choices that differ from the durable execution status quo. If you're contributing and find yourself asking "why is it done this way?", this is the document for you. Each entry summarizes the decision, explains the core rationale, and points you to the deeper write-up.

## Checkpoint, Don't Replay

Weft does not replay workflow history on recovery. Instead, workflows are `AsyncGenerator` functions where each `yield*` creates a checkpoint—a serialized snapshot of the generator's local variables. On crash, the engine deserializes the last checkpoint and resumes from that point. Recovery is O(1) regardless of how long the workflow has been running. No determinism constraints, no `continueAsNew` limit, no history growth.

This is the foundational divergence from Temporal and it shapes everything else. See [Checkpoint versus Replay](../architecture/checkpoint-versus-replay.md) for the full comparison.

## Web Worker Execution Model

Workflows can run in Web Workers (the web standard `Worker`, not `node:worker_threads`) when `workflowExecutionMode: 'worker'` is configured, giving untrusted workflow code an engine-isolate boundary, fault containment, true parallelism, and portability between Bun and the browser. If a workflow crashes or exceeds its Worker turn budget, it takes down that Worker—not the HTTP server. `BroadcastChannel` handles cross-worker coordination. The `smol: true` option keeps memory tight when running many concurrent workflows.

This replaces Temporal's Webpack-based workflow sandbox with a Worker transport boundary. `console.log` works, any npm package works, `debugger` works, and there's no build step for workflows. The Worker boundary protects engine liveness and engine heap access; it does not lock down Worker globals, network, filesystem, imports, or runtime memory outside Weft-owned protocol envelopes. See [Web Workers](../architecture/web-workers.md).

## EventTarget-Based Event System

`Engine` and `WorkflowHandle` extend `EventTarget`—the same interface as DOM elements, `WebSocket`, and `AbortSignal`. Events are typed `Event` subclasses (not `CustomEvent` with `.detail`), so you get named properties and full TypeScript inference without casts. Listeners clean up via `AbortSignal`, and handles support `for-await-of` via `Symbol.asyncIterator` plus RxJS interop via `Symbol.observable`.

No custom event emitter, no `.on()`/`.off()`/`.emit()`. See [Events guide](../guides/events.md).

## Explicit Resource Management

Every Weft resource—`Engine`, `WorkflowHandle`, `WorkerPool`, storage connections, `Scheduler`—implements `Disposable` or `AsyncDisposable`. You use `using` and `await using` for deterministic cleanup. `AsyncDisposableStack` manages multi-resource server setups with reverse-order teardown. No more forgotten `.close()` calls leaking file handles.

This relies on the TC39 Stage 4 Explicit Resource Management proposal, supported by Bun and TypeScript 5.2+. See [Resource Management guide](../guides/resource-management.md).

## Memory Management

Long-running engines need disciplined memory management. The handle registry uses `WeakRef<WorkflowHandle>` so the engine doesn't prevent garbage collection of handles the user has dropped. `FinalizationRegistry` cleans up stale `Map` entries pointing to collected `WeakRef` targets. The activity registry uses `WeakMap` to tie metadata to function references.

These three primitives—`WeakRef`, `WeakMap`, and `FinalizationRegistry`—eliminate entire categories of memory leaks in long-running processes. See [Web Standards architecture](../architecture/web-standards.md).

## Observable Protocol

`WorkflowHandle` implements `Symbol.observable`, making it directly consumable by RxJS, Most.js, and Zen Observable via `Observable.from()`. Combined with `Symbol.asyncIterator` for `for-await-of` and classic `addEventListener`, you get three consumption patterns from the same event stream. Choose whichever fits your use case: reactive pipelines, imperative loops, or direct listener callbacks.

See [Events guide](../guides/events.md).

## The Database Decision

SQLite via `bun:sqlite` is the default storage backend (class: `BunSQLiteStorage`). It ships inside the Bun runtime, compiles into single binaries with zero configuration, and gives you full SQL for dashboard queries and ad-hoc debugging. LMDB (`lmdb-js`) is the high-performance option for deployments exceeding 30K workflows per second—its memory-mapped, zero-copy reads are unbeatable for hot-path operations. LevelDB was ruled out: it's single-process only and slower on writes than both alternatives.

The storage interface is KV-oriented (not SQL-oriented) so all backends share the same contract. See [Database Decisions](../architecture/database-decisions.md) and [Storage guide](../guides/storage.md).

## Single Binary Distribution

`bun build --compile` produces standalone executables that include the Bun runtime, the engine, and the HTTP server. Cross-compilation targets cover macOS (ARM64, x64), Linux (ARM64, x64), and Windows (x64). End users download one file and run it—no Docker, no dependency installation.

See [Single Binary architecture](../architecture/single-binary.md).

## Service Worker: The Browser Runtime

A Service Worker acts as the browser equivalent of the Bun server process. It intercepts `fetch` events, runs the same engine code with IndexedDB storage, and persists workflow state across tab closes. The same `handleRequest` function powers both the Bun server and the Service Worker—one handler, two deployment targets. This enables offline-first durable workflows and hybrid local/remote operation.

Browser background execution has limits, so truly long-running workflows still need a server. See [Browser Runtime](../architecture/browser-runtime.md).

## HTTP + WebSocket—No gRPC, No Protobuf

The API uses Bun's route-based `Bun.serve()` for JSON-over-HTTP plus native WebSocket pub/sub for real-time streaming. As of Track 8 (PRs #144–#157), the server also exposes a unified operation catalog over JSON-RPC transports: JSON-RPC over HTTP, JSON-RPC over WebSocket, and JSON-RPC over stdio (see `src/server/operation-catalog.ts`, `json-rpc-http.ts`, `json-rpc-websocket-runtime.ts`, `stdio-session.ts`). Bun's built-in WebSocket pub/sub (`ws.subscribe()`/`ws.publish()`) eliminates the need for Redis or any external message broker. gRPC was rejected because it adds a code generation step, a protobuf dependency, and doesn't work in browsers. Every HTTP client and every WebSocket client already exists.

See [Server guide](../guides/server.md).

## Remote Workers

In server mode, remote workers connect over WebSocket and execute activities on separate machines. The server pushes tasks directly to workers (no polling, no race conditions) and tracks capacity per connection. A visibility timeout ensures tasks are reassigned if a worker dies. Heartbeats extend the deadline for long-running activities. An HTTP long-poll fallback supports environments where WebSocket isn't available.

See [Remote Workers guide](../guides/remote-workers.md).

## Additional Platform Patterns

Weft leans on modern JavaScript primitives throughout: `Promise.withResolvers()` for cleaner deferred promises, `Transferable` objects for zero-copy `postMessage`, `AbortSignal.any()` for compound cancellation, `AbortSignal.timeout()` for deadline enforcement, and `#private` fields for true encapsulation. These are not incidental choices—each one has measurable impact on either performance or correctness.

See [Web Standards architecture](../architecture/web-standards.md) and [Performance](../architecture/performance.md).

## Workflow Versioning

When new workflow code deploys while workflows are in-flight, the checkpoint model makes versioning simple. The version is pinned at start time and stored in the workflow state. On resume, if versions differ, an optional `migrate()` function transforms the checkpoint data. No replay compatibility concerns, no `patched()` calls, no version gates scattered through workflow code. Migration is a pure data transformation.

See [Workflow Versioning guide](../guides/workflow-versioning.md).

## Workflow-Level Timeouts

An execution timeout caps the total wall-clock time for an entire workflow. The deadline is stored in storage and indexed for efficient scanning. When the timeout fires, the workflow's `AbortController` cascades to all in-flight activities via the existing `AbortSignal.any()` pattern. `ctx.signal` exposes the combined timeout-plus-cancellation signal, so activities respect workflow timeouts with no code changes.

See [Timeouts guide](../guides/timeouts.md).

## Search Attributes

Workflows can set custom indexed metadata via `ctx.setAttribute()`. The implementation uses KV-based secondary indexes (`idx:{attr}:{value}:{workflowId}`) that work identically on SQLite, LMDB, and IndexedDB. Attribute values are encoded into sortable strings so range scans produce correct results. Index updates happen atomically with checkpoint writes in a single `batch()` call.

See [Search Attributes guide](../guides/search-attributes.md).

## Synchronous Updates

Signals are fire-and-forget; updates are request-response. The caller blocks until the workflow processes the message and returns a result. Two patterns are supported: `ctx.onUpdate()` for callback-style handlers that run at checkpoint boundaries, and `ctx.waitForUpdate()` for explicit suspension until a named update arrives. Responses are written atomically with the checkpoint and delivered via `BroadcastChannel` without polling.

See [Synchronous Updates guide](../guides/synchronous-updates.md).

## Session State

Per-workflow session state (added in PR #149) provides a virtual-object-style mutable store scoped to a single workflow execution. Workflows access it through `ctx.state.session<T>(key, options?)`, which returns a handle over a value serialized atomically with the checkpoint. Session state is capped at 256 keys, 256-byte key names, and 32 KB total serialized size. Mutations are validated against these invariants at each checkpoint boundary.

This covers the use case of workflows that accumulate small amounts of evolving metadata (counters, flags, lookup tables) without requiring a separate `ctx.setAttribute()` round-trip or bespoke local variable discipline.

See `src/core/session-state.ts` for the implementation.

## Interceptors and Middleware

Interceptors are composable hooks that wrap context operations (`ctx.run()`, `ctx.sleep()`, `ctx.review()`, etc.) for cross-cutting concerns. They compose via `next()` delegation (like Koa middleware) and are registered on the engine, not on individual workflows. The `headers` Map propagates metadata—trace context, short-lived claims, and opaque credential references—across thread and network boundaries. Observability, validation, encryption, and auth propagation are all built on this foundation.

See [Interceptors guide](../guides/interceptors.md).

## Observability

OpenTelemetry integration is opt-in, implemented as a pre-built interceptor. Import `createObservabilityInterceptors` from `@lostgradient/weft` and you get auto-created spans for all context operations, W3C Trace Context propagation through the `headers` mechanism, and standard OpenTelemetry metrics. If you don't import it, no OpenTelemetry code is loaded. The `@opentelemetry/api` package is a no-op unless an SDK is configured, so there's zero overhead when tracing is disabled.

See [Observability guide](../guides/observability.md).

## Resolved open questions

A handful of design questions came up early and have been settled:

- **Checkpoint serialization** uses `structuredClone` semantics. `ctx.memo()` handles derived values that don't serialize cleanly.
- **Generator depth** is capped at 10 levels by default (configurable). Child workflows are independently checkpointed via separate storage entries.
- **Determinism is not required.** `Date.now()`, `Math.random()`, and network calls are permitted between checkpoint boundaries. An opt-in `deterministic` mode exists for testing.
- **SQLite write throughput** is addressed by the LMDB adapter for high-throughput deployments. Turso covers distributed scenarios. The documented scaling path is SQLite first, LMDB when you need it.
- **Naming:** Weft. Shipped.

## See also

Long-form numbered ADRs live under [`architecture-decisions/`](./architecture-decisions/):

- [ADR 0001 — Workflows Are TypeScript-Only by Design](./architecture-decisions/0001-workflows-typescript-only.md)
