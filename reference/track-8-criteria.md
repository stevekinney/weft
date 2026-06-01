# Track 8 Criteria — Verbatim Source of Truth

This file holds the full text of every Track 8 acceptance criterion plus the Final verification gates, copied verbatim from `reference/architecture.md`. Each criterion has a stable slug `id` that the traceability matrix in `reference/track-8-traceability.md` references.

When wave PRs cite a criterion, they cite the `id` here, not a line number in `architecture.md` (line numbers shift with edits).

---

## Track 8 — Transport parity, shared contracts, and authorization

> Track 8 extends the runtime surface without creating a second execution system. Every external transport remains an adapter over the existing `Engine` methods, typed `EventTarget` events, `BroadcastChannel` coordination, and Worker `postMessage` protocols (`WorkerInboundMessage` and `WorkerOutboundMessage`).

### Top-level criteria

- **`8-top-1`**: The runtime API has one transport-neutral operation catalog. It covers runtime operations only, not authoring APIs. Each entry defines the `Engine` method mapping, JSON Schema for params and result, auth requirement, authorization policy hook, REST route metadata, JSON-RPC method name, and shared error mappings.
- **`8-top-2`**: Authoring APIs remain intentionally TypeScript-only. `engine.register()`, workflow/activity/agent declarations, providers, storage adapters, interceptors, and execution-strategy wiring are documented as in-process authoring surfaces rather than transport-parity endpoints.
- **`8-top-3`**: Both `/openapi.json` and `/openrpc.json` are generated from the same operation catalog. JSON-RPC is not inferred from OpenAPI, and OpenAPI is not treated as a lossy source for JSON-RPC.
- **`8-top-4`**: `rpc.discover` returns the same OpenRPC document exposed at `/openrpc.json`. Clients can fetch the machine-readable JSON-RPC contract over JSON-RPC itself without a second documentation pipeline.
- **`8-top-5`**: `/openapi.json` is a full OpenAPI 3.1 contract for the REST-ish HTTP surface. It includes path and query parameters, request bodies, response schemas by status code, shared error objects, and security declarations.
- **`8-top-6`**: REST and JSON-RPC requests dispatch into the same `Engine` methods. No runtime feature lands on one transport without being modeled in the shared operation catalog first.
- **`8-top-7`**: The parity surface covers all data-driven runtime operations. Workflow lifecycle, signals, updates, queries, review flows, attributes, checkpoints, events and timeline access, schedules, fork and bulk operations, and stream retrieval are all transport-addressable.

### 8a. Eventing and stream projection

- **`8a-1`**: Track 8 does not introduce a second orchestration layer or event bus. External transports adapt the current engine/runtime primitives instead of replacing them.
- **`8a-2`**: External subscriptions project from existing typed `EventTarget` events. `Engine` and `WorkflowHandle` events remain the source of truth for watch and stream semantics.
- **`8a-3`**: `BroadcastChannel` remains the internal cross-worker coordination primitive. Transport-specific publish-subscribe machinery does not replace the current internal coordination model.
- **`8a-4`**: Worker `postMessage` remains the internal worker execution protocol. `WorkerInboundMessage` and `WorkerOutboundMessage` stay internal runtime messages; external JSON-RPC does not become a second worker protocol.
- **`8a-5`**: One server-side event projection layer feeds every live transport. WebSocket watch and token messages, SSE responses, JSON-RPC subscription notifications, and cursor-based replay all project from the same event stream model.
- **`8a-6`**: All live views share the same sequence and cursor semantics. Replay, resume, and ordering rules are identical across HTTP, WebSocket, and the Track 8 runtime stdio JSON-RPC transport.

### 8b. JSON-RPC transport surface

- **`8b-1`**: JSON-RPC 2.0 is supported over three runtime transports. `POST /jsonrpc`, WebSocket upgrade on `/jsonrpc`, and newline-delimited JSON over a dedicated stdio runtime entrypoint. This stdio runtime surface is distinct from the existing MCP stdio transport exported from `@lostgradient/weft/mcp`; they may share framing or codec helpers if useful, but they are different protocol surfaces with different method namespaces and semantics.
- **`8b-2`**: Runtime JSON-RPC methods use stable namespaced names. Examples: `weft.workflows.start`, `weft.workflows.get`, `weft.workflows.signal`. These names belong to the runtime API surface and are not MCP method names.
- **`8b-3`**: JSON-RPC uses named params only. The OpenRPC contract documents `paramStructure: "by-name"` so generated clients and manual callers converge on one request shape.
- **`8b-4`**: Batch requests are supported. The shared dispatcher validates and executes JSON-RPC batches without inventing transport-specific behavior.
- **`8b-5`**: Notifications are opt-in per call. Per JSON-RPC 2.0, the caller opts in to fire-and-forget by omitting the `id` field; an id-present request always produces a wire response. Every cataloged operation runs the same pipeline (schema validation, authorization, invoke) regardless of id presence, so authorization failures and validation errors are recorded server-side either way. Mutating operations therefore default to request-response — every standard JSON-RPC client library includes `id` automatically; notifications are an explicit caller opt-in by omitting it.

  > **Drafting history**: this criterion was originally drafted as "opt-in per method" before the spec-compliance review surfaced that returning a wire error for id-less calls would itself violate JSON-RPC 2.0. The criterion text was amended in Wave 3 round 5 to match the actual spec-compliant semantic.

- **`8b-6`**: Subscription notifications reuse the shared event projection layer. Watch and stream APIs are documented as projections of current engine events rather than bespoke server-side state machines.

### 8c. Error handling

- **`8c-1`**: Reserved JSON-RPC protocol errors follow the specification exactly. `-32700`, `-32600`, `-32601`, `-32602`, and `-32603` keep their standard meanings.
- **`8c-2`**: Weft domain failures use a separate stable application error range outside the reserved protocol band. Business and workflow errors do not overload the reserved JSON-RPC codes.
- **`8c-3`**: JSON-RPC `error.data` carries structured machine-readable detail. At minimum it includes the canonical Weft application code and the related HTTP status when the same failure is exposed over REST.
- **`8c-4`**: REST and JSON-RPC share one engine-error mapping layer. The same engine failure produces equivalent transport-level semantics across both surfaces.

### 8d. Authentication and authorization

- **`8d-1`**: The design documents current state accurately. HTTP authentication already exists, and `serve()` authenticates the incoming `Request` before a WebSocket upgrade is accepted.
- **`8d-2`**: Track 8 adds transport-neutral authorization for runtime operations. REST, JSON-RPC over HTTP, JSON-RPC over WebSocket, SSE, and future transports all call the same per-operation authorization hook after authentication and before dispatch.
- **`8d-3`**: WebSocket sessions bind authenticated identity at upgrade time. Every JSON-RPC call on that socket reuses the established principal instead of re-authenticating per frame.
- **`8d-4`**: stdio is a separate opt-in local entrypoint, disabled by default. It is not implicitly enabled by `serve()` and is not treated as a public unauthenticated surface.
- **`8d-5`**: stdio authorization uses the same operation-level policy hook once a session exists. Local process boundaries are the default guard, with optional startup-token hardening for stricter deployments.

---

## Final verification

- **`final-1`**: `bun test` passes across the whole repo.
- **`final-2`**: `bun run typecheck` exits 0.
- **`final-3`**: `bun run lint` (oxlint) exits 0.
- **`final-4`**: `bun run build` succeeds.
- **`final-5`**: `bun build --compile src/cli-main.ts --outfile weft` produces a working binary.
- **`final-6`**: Every new primitive from this document has a dedicated test file under `src/` (either as a colocated `src/**/*.test.ts` file or under `src/**/__tests__/`) and every acceptance criterion above is covered by at least one `test(...)` call whose failure message names the criterion.

> The architecture criterion `weft validate examples/**/*.ts` exits 0 on the bundled examples is already shipped and is not in Track 8 scope.

---

## Coverage rule (Step 0 amendment)

Per the Step 0 PR amendment to `reference/architecture.md` under Track 8 — Final verification:

> Coverage rule: each behavioral or cross-cutting structural criterion has a real, non-skipped Bun test whose `it(...)` (or `test(...)` — the Bun aliases are equivalent) title contains, as a substring, the exact post-colon sentence of the matching bullet in `reference/track-8-criteria.md`. The bullet's leading slug id and the colon are not part of the quoted span; backticks may be stripped. The title is what `bun test` prints on failure, so this satisfies `final-6`'s "failure message names the criterion" phrasing. Design-invariant criteria are reviewed via the traceability matrix and the rationale paragraph in `runtime-and-deployment.md`, not via runtime tests, because no runtime assertion can prove "we did not build a second orchestration layer."

This carves design-invariant criteria (`8a-1`, `8a-3`, `8a-4`) and documentation criteria (`8-top-2`, `8d-1`) out of the runtime-test rule. They close via the traceability matrix's design-invariant or documentation evidence modes, not via a synthetic test.
