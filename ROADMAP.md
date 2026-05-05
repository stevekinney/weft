# Roadmap

A running list of issues, gaps, and follow-ups discovered while reading through the docs. Each item should carry enough context that we can pick it up cold later without re-doing the investigation.

## 1. Type System & Definition Vocabulary 🚨

This section unifies the public type surface, ergonomics, and definition helpers. Everything here is pre-1.0 hard rename — no aliases, no codemod, no changelog warnings.

- [x] **Eliminate the `(ctx as Context)` cast pattern: widen `WorkflowContext` to be the full handler surface.** 🚨

  **Where:** `src/core/types/workflow-context.ts` (the widened workflow authoring interface), `src/core/context/index.ts` (the `Context` class). Pervasive in JSDoc and `documentation/guides/workflows.md` and elsewhere.

  Today `WorkflowContext` exposes only identity and composition operators; it _excludes_ `run`, `sleep`, `waitForSignal`, `startChild`, `all`, `race`, `offload`, `archive`, `agent`, `setAttribute`, `stream`, `suspendUntil`, `humanReview`. So `ctx.run(...)` fails to typecheck in handler signatures, and the project's own JSDoc prescribes `(ctx as Context).run(...)` — directly contradicting the codebase's "treat `as` with suspicion" rule.

  Widen `WorkflowContext` to the full handler surface (mirror every public method on `Context`). Verify `Context implements WorkflowContext` still holds. Remove every `(ctx as Context)` cast from JSDoc, source, and docs. Replace the JSDoc header rationale with a one-liner. Add a lint rule flagging `as Context` casts inside handlers.

- [x] **Replace `input: unknown` + `as` casts with idiomatic inline parameter annotations across every payload-accepting API.**

  **The decision:** inline parameter annotations (Option B) are the everyday default; `Engine<TRegistry>` (Option C) is the opt-in upgrade for cross-call typing. Both coexist.

  **Surfaces:** `engine.register` (`src/core/engine.ts:2473-2483`), `engine.start` (`engine.ts:2693`), `engine.signal` / `engine.update` / `engine.query`, `ctx.waitForSignal` (already generic on receive — gap is on send), `engine.registerActivity` (`engine.ts:2681`), `WorkflowRegistration` update/query handlers.

  Verify TypeScript contextual typing flows when the user writes `async (ctx, input: { name: string }) => ...`; tighten overload signatures if it doesn't. Audit and rewrite every `as { ... }` cast in README, `documentation/getting-started/*`, `documentation/guides/*`, `documentation/agents/*`, JSDoc in `engine.ts` / `context.ts` / `types.ts`. Add a lint rule flagging `as <ObjectType>` directly inside `register` / `start` / `signal` / `update` / `query` callbacks.

- [x] **Unify `activity()` to handle both bare-function and metadata forms; add a peer `workflow()` helper; tighten the activity calling convention to single-input.**

  **Where:** `src/core/types.ts:1943` (existing `activity()`), `types.ts:654` (`ActivityFunction<TInput, TOutput>`), `src/core/engine.ts:9180` (runtime args-spread), `engine.ts:2473-2483` (`register` overloads). New: `workflow()` helper.

  Three intertwined fixes:
  1. **Single-input activity convention.** `ctx.run(sendConfirmation, { email, receiptId })` — not `ctx.run(sendConfirmation, email, receiptId)`. `ActivityFunction<TInput, TOutput>` becomes a strict two-parameter contract; runtime no longer spreads. Aligns with `OperationDefinition`, MCP, codegen, and every RPC framework convention.
  2. **`activity()` overloads** — bare-function form (`activity(async (input) => ...)` infers name from `fn.name`) and metadata form (`activity({ name, retry, timeout, queue, execute })`). Both return the same callable + `ActivityDefinition`.
  3. **Peer `workflow()` helper** — same overload pattern. Bare generator (name inferred) or metadata (`{ name, version, handler, migrate, searchAttributes, retention }`). `engine.register(workflow)` becomes the canonical registration form (no name string).

  Update `documentation/guides/activities.md`, `documentation/guides/workflows.md`, README's checkout example. Lint rule: flag `ctx.run(fn, a, b, ...)` with more than two arguments. If `fn.name === ''` (anonymous arrow with no variable hoisting), throw at definition time.

  This is now a follow-up to the catalog foundation. Land it before registry, codegen, or MCP work consumes activity metadata.

- [x] **Add `signal()`, `update()`, `query()` typed handles for the message-shaped surfaces.**

  **Where:** `src/core/types.ts` (new exports), `src/core/context.ts:1975` (`onUpdate` and the corresponding `onQuery`), `engine.ts` (`engine.signal` / `update` / `query` currently take `payload: unknown`).

  Each helper returns a small typed value carrying name + phantom input/output types:

  ```ts
  const approval = signal<{ approved: boolean }>('approval');
  const approveOrder = update<{ orderId: string }, { status: 'approved' | 'rejected' }>(
    'approveOrder',
  );
  const orderStatus = query<{ orderId: string }, { state: string; updatedAt: number }>(
    'orderStatus',
  );
  ```

  Overload `engine.signal` / `engine.update` / `engine.query`, `ctx.waitForSignal`, `ctx.onUpdate`, `ctx.onQuery` to accept either a string (legacy / dynamic) or a typed handle. Schema attachment via optional Zod is deferred to the Standard Schema item below. Lint rule flags `engine.signal(id, '<string-literal>', ...)` calls.

- [x] **Complete the definition vocabulary: `searchAttribute()`, `interceptor()`, `constraint()`, `schedule()`, and rename `defineAgent` → `agent`.**

  Family pattern — every primary primitive defined via a function named after the primitive.
  - **`searchAttribute(name, type)`** — accepts three forms, all converging on JSON Schema internally:
    - Tier 1: bare primitive name (`'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'`) — sugar for `{ type: <name> }`.
    - Tier 2: JSON Schema fragment (`{ type: 'string', format: 'date-time' }`, `{ type: 'array', items: { type: 'string' } }`).
    - Tier 3: Standard Schema (Zod / Valibot / ArkType) — converted via `toJSONSchema(schema)`.
      Overload `ctx.setAttribute` and `engine.list({ attributes })` to accept either string keys (dynamic) or handles (typed). Replaces the legacy `'datetime'` / `'keyword_list'` tags.
  - **`interceptor(spec)`** — identity-with-inference. Optional `name` for observability.
  - **`constraint(spec)`** — identity helper; types narrow.
  - **`schedule(spec)`** — `{ workflow, cron, input, overlapPolicy }` producing a `ScheduleDefinition` ready for `engine.scheduleCreate`.
  - **Rename `defineAgent` → `agent`** at `src/ai/declaration.ts:222`. Hard rename across source, JSDoc, README, every `documentation/agents/*.md`. `agent()` accepts only the options form (no bare-function form — agents always need at least a model and prompt).

  Add `documentation/reference/api-definitions.md` showing every helper in one table. `import` ergonomics: lean toward flat exports from `weft` (matching Vue/Vite/Nitro). `ctx.onSignal` registration helper is deferred.

- [ ] **Thread Standard Schema through every definition helper.**

  **Where:** every helper above (`workflow`, `activity`, `agent`, `signal`, `update`, `query`, `searchAttribute`, `constraint`, `schedule`).

  One declaration drives three artifacts: TypeScript type (compile-time), validator (runtime at boundaries), JSON Schema (registry, codegen, polyglot SDKs). Use the project's existing `toJSONSchema()` adapter (Zod via `zod-to-json-schema`, Valibot via `valibot-to-json-schema`, etc.). Schemas are optional for purely-internal definitions; required for anything crossing a process boundary (HTTP, MCP, codegen). Document the heuristic.

- [ ] **Replace `SearchAttributeDefinition` with JSON Schema.**

  **Where:** `src/core/types.ts:404-406` (the hand-rolled tag enum `'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list'`), the indexer, `engine.list` filter validation, every doc that mentions search-attribute types.

  Replace the tag enum with the JSON Schema fragments produced by `searchAttribute()`. `'datetime'` becomes `{ type: 'string', format: 'date-time' }`; `'keyword_list'` becomes `{ type: 'array', items: { type: 'string' } }`. Filter coercion logic in `engine.list` reads the schema fragment instead of the tag. Test that the existing search-attribute behavior (string indexing, date-range filters, array containment) is preserved across the cleanup.

- [x] **Redesign the durable state API from first principles: a scoped `ctx.state` ladder.** 🚨

  **Severity: high.** The previous API promised cross-workflow sharing but its tests demonstrated single-workflow private state because the storage key included the current workflow id. Two workflow runs each passing `ctx.workflowId` wrote to different keys and shared nothing. Users got burned silently.

  **The redesign — one namespace, explicit scope ladder:**
  - **`ctx.state.session<T>(key, options?)`** — checkpoint-local state private to the current workflow execution.
  - **`ctx.state.execution<T>(key, options?)`** — shared by a parent workflow, durable child workflows, and concurrent branches. Storage key: `state:execution:${ownerWorkflowId}:${key}`.
  - **`ctx.state.workflow<T>(key, options?)`** — shared by every execution of the current workflow type within a tenant. Storage key: `state:workflow:${tenantId}:${workflowType}:${key}`.
  - **`ctx.state.tenant<T>(key, options?)`** — shared by every workflow in a tenant. Storage key: `state:tenant:${tenantId}:${key}`.

  Tenant ID resolves from the engine's tenant resolver (or `ctx.tenant`); throws clearly if no tenant context. Non-session scopes are also available for admin use through `engine.state.execution(ownerWorkflowId, key, options?)`, `engine.state.workflow(tenantId, workflowType, key, options?)`, and `engine.state.tenant(tenantId, key, options?)`. The old class is removed and replaced by `AtomicState` — more accurate, atomicity via CAS is the actual guarantee.

  **Other changes:**
  1. **`initial: T` at construction**, not on every call site. `.get()` returns `initial` if no value written; `undefined` if no `initial` and no value written.
  2. **Three observation surfaces, one event source.** Instances `extends EventTarget` (events: `change`, `conflict`, `exhausted`), implement `[Symbol.observable]()` (RxJS / Zen interop — use `Symbol.observable ?? Symbol.for('https://github.com/benlesh/symbol-observable')`), and `[Symbol.asyncIterator]()` (`for await`). All three project the same underlying event stream. Local-only; cross-process delivery is a follow-up.
  3. **Convenience methods over `.update()`** (no Proxy — hides asynchrony, breaks compound expressions). Always: `.get()`, `.update(fn)`, `.set(value)`, `.delete()`. For numeric `T`: `.increment(by?)`, `.decrement(by?)`. For object `T`: `.merge(partial)`. For array `T`: `.append(item)`, `.removeFirst()`, `.removeLast()`. CAS-on-delete is the safe form.
  4. **Tests** must prove tenant-wide sharing _and_ tenant isolation _and_ type-scoped sharing _and_ run-scoped sharing. Existing tests pass `'wf-1'` everywhere — single-namespace correctness only.

  Rewrite the state documentation around `ctx.state`, remove the old session-state method, and audit `offload`, `archive`, anything else taking a `workflowId` parameter outside a workflow context for the same disease. Pre-release, hard cut.

  **Out of scope:** Proxy form, cross-process change notifications, automatic lifecycle binding, schema validation on writes (covered by Standard Schema item), Immer-style transactional draft.

## 2. Cross-Process Type Generation

- [x] **Add typed `ctx.run` and `engine.start` via a module-augmentation activity registry.**

  **Where:** `src/core/context/index.ts` (`ctx.run`), `src/core/engine/index.ts` (`start` / `registerActivity` typings), `src/core/types/workflow-registries.ts` (`WorkflowRegistry` and `ActivityTypes`).

  Mirror `WorkflowRegistry`. User declares once:

  ```ts
  declare module 'weft' {
    interface ActivityTypes {
      greet: (name: string) => Promise<string>;
      sendEmail: (to: string, subject: string) => Promise<{ id: string }>;
    }
  }
  ```

  `ctx.run` gets a string-name overload that consults the registry. Closure form (`ctx.run(greet, 'Steve')`) keeps working. Completion note: the activity augmentation target is `ActivityTypes` to avoid colliding with the public runtime `ActivityRegistry` class; string-name `ctx.run` now dispatches through registered activity names. Companion to the codegen item below — codegen produces the augmentation; typed `ctx.run` consumes it.

- [ ] **Expose JSON Schema registries from the server.**

  **Where:** new endpoint `GET /v1/registry` (or a JSON-RPC method); reuses the same `zod-to-json-schema` path the OpenRPC generator uses (`src/server/openrpc.ts:142-144`).

  Returns `{ workflows: { name: { input, output, ... } }, activities: { name: { input, output, queue, ... } } }`. Gated behind an authenticated scope (schemas leak internal data shapes). Worker-supplied activity schemas: extend the `RemoteWorker` registration message (`src/worker/index.ts:137`) to carry schemas; the server unions them into the registry document. Snapshot, not stream — codegen is a build step.

  Depends on the remaining user-definition catalog work so workflows and activities expose `inputSchema` / `outputSchema` consistently.

- [ ] **Add `weft codegen` CLI.**

  **Where:** new `src/cli/codegen.ts` and `src/cli/codegen-emit.ts`. Add `'codegen'` to the `CliCommand` union (`src/cli.ts:25-91`); dispatch in `src/cli-main.ts`.

  ```bash
  bunx weft codegen --server https://weft.internal:7233 --token "$WEFT_TOKEN" --out src/weft.generated.d.ts
  ```

  Fetches the registry, validates against an expected Zod shape, emits a single `.d.ts` with module augmentation for `WorkflowRegistry` and `ActivityTypes`. Banner header (`// Generated by weft codegen — DO NOT EDIT. Source: <url> at <timestamp>`); deterministic byte-identical output for stable diffs; alphabetically-sorted keys; idempotent writes. JSON Schema → TypeScript via `json-schema-to-typescript`. Optional `tsc --noEmit` validation post-write — schema producing invalid TS is a server-side bug, fail fast.

  Auth via `--token`, env var `WEFT_TOKEN`, or `~/.weft/credentials`. `--config <path>` for JSON or TS config files (mirrors `prisma generate`, `drizzle-kit`, `openapi-typescript`). `--watch` polls for change; `--from <path>` reads from local file (offline / vendored). `--target` flag designed for future `python` / `go` emitters; v1 ships TypeScript only. Multi-server via running the command multiple times (v1 simplicity).

  Gated by the JSON Schema registry endpoint above.

## 3. Catalog Follow-Ups

The transport-neutral operation catalog, dispatch audit, stream/subscription kinds, OpenAPI hydration, AsyncAPI, `/.well-known/api-catalog`, OpenRPC errors, discovery info, and the `mcpExposable` ratchet have landed. The remaining catalog work is about user-defined workflows and activities rather than the built-in server operations.

- [x] **Finish workflow and activity catalog citizenship for user definitions.**

  **Where:** `src/core/types/workflow-function.ts` (`WorkflowRegistration`), `src/core/activity-registry.ts` (`ActivityRegistrationOptions`), `src/server/operation-catalog/workflow-adapter.ts`, and any future activity adapter.

  Registered workflows and activities should carry `inputSchema`, `outputSchema`, transport-availability flags where relevant, access policies where relevant, user-facing descriptions, and an introspection surface. `catalogWorkflow()` currently proves the start-operation adapter shape, but `WorkflowRegistration` itself does not carry schema metadata and activities still live behind `ActivityRegistry` metadata rather than catalog-shaped definitions.

  Schemas are opt-in in v1, then ratchet to "required for MCP-exposed workflows" once the MCP server lands. Use Standard Schema for the validator interface (cross-validator interop). This is the foundation for codegen, MCP tool input schemas, per-workflow AsyncAPI payloads, and the `/v1/registry` endpoint.

## 4. MCP Server Support

Per the AI Surface Shrinkage decision, Weft does not ship an MCP _client_ (`armorer` owns MCP-as-tool-source). Weft's _workflow_ surface is a separate concern: there's value in exposing Weft workflows as MCP tools/resources to external MCP clients (Claude Desktop, Cursor, Anthropic SDK).

- [ ] **Implement an MCP server exposing Weft as a first-class MCP service — remote HTTP and local stdio (`npx weft-mcp`).**

  **Two deployment shapes, both first-class:**
  1. **Remote MCP (HTTP)** — long-lived Weft server, MCP added to the existing transport surface. Uses **Streamable HTTP** (2025-03-26+ spec) — single endpoint accepting POST (client→server) and GET (server→client SSE), with session resumption via `Mcp-Session-Id` header. Multi-tenant, OAuth-authenticated.
  2. **Local stdio (`npx weft-mcp`)** — standalone npm package (`weft-mcp` or `@weft/mcp`). Two modes:
     - **Embedded** (`--db ./weft.db`): in-process engine against local SQLite. No auth; local user filesystem is the trust boundary.
     - **Proxy** (`--server https://... --token $WEFT_TOKEN`): forwards every MCP request to a remote Weft server. Local credential holder for hosted deployments.

  ```json
  {
    "mcpServers": { "weft": { "command": "npx", "args": ["-y", "weft-mcp", "--db", "./weft.db"] } }
  }
  ```

  **Concrete (per 2025-06-18 spec):**
  - **Lifecycle:** handle `initialize` with `protocolVersion`, `capabilities`, `serverInfo`; respond with negotiated capabilities; receive `notifications/initialized` to mark ready. Reject other methods until ready.
  - **Capabilities:** `tools` with `listChanged: true`, `resources` with `subscribe: true` and `listChanged: true`, `prompts` (optional v1), `logging`.
  - **Tools:** every registered workflow becomes an MCP tool; `inputSchema` is the workflow's `inputSchema`. Plus engine-control tools: `start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, `get_workflow_state`. Per-workflow tools named `start_<workflow_name>` (lowercase, underscores).
  - **Resources:** read-only views — workflow state by ID, checkpoint history, event log, search-attribute query results. URIs like `weft://workflow/<id>/state`, `weft://workflow/<id>/checkpoints/<step>`, `weft://workflows?status=running`. Subscribable; uses the existing event-feed backend.
  - **Methods to handle:** `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `resources/templates/list`, `prompts/list`, `prompts/get`, `logging/setLevel`, `ping`, `completion/complete`. Outbound notifications: `tools/list_changed`, `resources/list_changed`, `resources/updated`, `progress`, `message`.
  - **Auth:** Remote uses OAuth 2.1 with PKCE per MCP spec. Reuse `src/server/authentication.ts` and `src/server/authorization-scope.ts`. (The client-side OAuth helper at `src/ai/mcp/oauth2-token-manager.ts` is deleted by the shrinkage; the server reimplements the authorization-server half against existing infrastructure.) Local stdio: no auth on the wire.

  **Implementation must follow:**
  - Tool input schemas are JSON Schema (convert via `zod-to-json-schema`).
  - Tool names: lowercase + underscores (`start_checkout_workflow`, not `startCheckoutWorkflow`).
  - Tool descriptions are user-facing — sourced from workflow registration metadata (add `description?: string` to `WorkflowRegistration`).
  - `tools/call` errors return `isError: true` with a `content` block, **not** a JSON-RPC error.
  - Long-running calls: cancellation via `notifications/cancelled` (maps to `engine.cancel(id)`); progress via `notifications/progress`.
  - Pagination from day one. Every MCP-exposed workflow must have an `inputSchema` — reject otherwise.
  - Tenant scoping: remote resolves via session auth token's OAuth scope claim; local embedded is single-tenant; local proxy forwards configured token's tenant.
  - Activities are **never** exposed as standalone MCP tools — workflows are the durable unit. Document the rationale.
  - Conformance test: stand up the MCP reference test client (or use Claude Desktop in CI) against both transports.

  Binary distribution: separate `weft-mcp` package built via `bun build --compile`. The AI Surface Shrinkage and built-in operation-catalog foundation are already in place; finish user-definition catalog metadata before exposing registered workflows as MCP tools.

- [ ] **MCP server catalog endpoint.**

  Once the server exists, add an `x-weft-mcp` extension on the OpenRPC document plus a `/.well-known/mcp.json` route. Native MCP `tools/list` is the canonical answer for live introspection; the static catalog is for build-time consumers. Lean minimal — extension on OpenRPC + live `tools/list` is enough; separate static catalog is nice-to-have. Gated by the MCP server item.

## 5. Polyglot Activity Workers (Path A)

**Architectural decision:** workflows are TypeScript-only by design (generators don't serialize across processes); activities are polyglot via the `RemoteWorker` wire protocol.

- [ ] **Formally specify the `RemoteWorker` wire protocol so SDKs in other languages can implement it.**

  > **Partial progress:** spec doc shipped at `documentation/reference/remote-worker-protocol.md` (note: filed under `reference/` rather than `specifications/` to match existing docs conventions). Conformance test suite, drift-prevention test, and `protocolVersion` field still pending.

  **Where:** `documentation/reference/remote-worker-protocol.md`. Driven from existing `src/worker/index.ts` (registration, dispatch, heartbeat) and `src/server/json-rpc-websocket.ts` (server side).

  Document:
  1. **Message envelope and types.** Worker → Server: `register`, `heartbeat`, `task_complete`, `task_failed`, `task_progress`. Server → Worker: `task`, `cancel`, `disconnect`. Full payload shape, required vs. optional fields, semantics of empty vs. omitted fields.
  2. **Lifecycle state machine.** Connect → register → idle → claim → execute → report → idle. Disconnect-mid-task behavior. Heartbeat lapse. `disconnectTimeoutMs` semantics. Reconnection: does the server reissue in-flight tasks?
  3. **Framing.** WebSocket text frames carrying JSON. `Uint8Array` payloads base64-encoded (or MessagePack content-negotiation if available — verify which). No transparent binary support assumed.
  4. **Auth and authz.** Worker auth on connect (`bearerAuth` / `apiKeyAuth` from `src/server/openapi.ts`). Required scopes. Tenant-scoped vs. tenant-agnostic workers.
  5. **Activity contract.** Input/output validation. Error shape (`OperationFault` taxonomy from `fault-to-json-rpc.ts`). Heartbeat semantics for long-running tasks. `AbortSignal` cancellation propagation.
  6. **JSON Schema for every message type.** Drift-prevention test mirroring `track8-discovery-parity.test.ts`.
  7. **Conformance test suite** any candidate SDK can run against — lifecycle, error cases, edge cases (reconnect with in-flight task, heartbeat lapse, cancellation race). Ship as separate package or `weft conformance` CLI subcommand.
  8. **Versioning.** `protocolVersion` in `register` message; server accepts a range and rejects out-of-range workers with a clear error.

  Stable on-the-wire field names (TS-side renames don't affect wire format). Forward-compatible — additions only, never renames or repurposings. Pick `snake_case` _or_ `camelCase` consistently (audit current).

- [x] **Document "workflows are TypeScript-only by design" via an ADR + README + architecture pages.**

  **Where:**
  - `documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md` — full ADR recording Status, Context (checkpoint-not-replay model), the constraint (generators not serializable across processes), the implication (engine drives the generator end-to-end in one process), why this makes workflows TS-only (Python `async def` and JS `async function*` have different state machines; cross-language serialization of in-flight execution state cannot be done because no language runtime exposes execution state as a serializable artifact), the three theoretical paths considered (Path B replay-determinism rejected — abandons the defining design choice; Path C separate state-store rejected — collapses back to Path B; Path A chosen — workflows in engine, polyglot activities), Decision, Consequences, Forces, What Stays Open.
  - `documentation/architecture/checkpoint-versus-replay.md` — call out the consequence; readers should see the model and the constraint together.
  - **README** — Design Constraints callout: _"Workflows run in TypeScript on the engine; activities can run in any language via the RemoteWorker protocol. This split is intentional — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only by design."_
  - **Weft vs. Temporal table:** add a row — Workflow language: Temporal _"Any (Go, Java, TS, Python, .NET, Ruby, PHP)"_ / Weft _"TypeScript only (activities can be any language)"_.
  - **Positioning paragraph** for the docs index: _"Weft is for teams whose primary backend language is TypeScript. If you need workflows in multiple languages, Temporal is the right answer."_

  Without a documented ADR, a future contributor proposes a Python workflow runtime, no one remembers why we said no, and the codebase fragments. The ADR is the durable answer.

## 6. Agent Bureau Compatibility 🚨

**Architectural commitment:** Agent Bureau (`/Users/stevekinney/Developer/agent-bureau`) consumes Weft, never the reverse. **Dependency arrow: Agent Bureau → Weft. Hard structural constraint.** Weft cannot import from `armorer`, `conversationalist`, or `interoperability` — `devDependencies` only, for type-compat tests. The two items below scope the Weft-side design that lets Agent Bureau extend Weft's narrow contracts as structural supersets.

- [ ] **Design Weft's tool-and-conversation surface as a minimal durable-execution contract Agent Bureau can compose on top of.** 🚨

  **Where:** new or revised `src/ai/types.ts` (the surviving file after AI Surface Shrinkage), `src/ai/agent.ts` (agent loop), `src/ai/declaration.ts` (becoming `agent()`).

  **Decision: Option C** — Weft owns a minimal durable-execution contract; Agent Bureau extends it with richer semantics via structural superset. (Option B — hoist `interoperability` to a neutral package — remains viable longer-term but is Agent Bureau's call.)

  **Weft's minimal surface:**
  - `JSONValue` — recursive JSON-safe type matching `interoperability`'s shape.
  - `ToolCall { id: string; name: string; arguments: JSONValue }` — minimal for tool calls dispatched at checkpoint boundaries.
  - `ToolResult { id: string; value: JSONValue } | { id: string; error: ToolErrorShape }`.
  - `ToolErrorShape { message: string; code?: string }` — Agent Bureau's `ToolError` extends with `category`, `retry`.
  - `ToolDefinition { name: string; description?: string; inputSchema: JSONValue; execute: (input, ctx?) => Promise<JSONValue> }`.
  - `ConversationHistory` — minimal JSON-safe shape that's a structural _subset_ of `conversationalist.ConversationHistory` so Agent Bureau code can wrap Weft's persisted history in `new Conversation(history)` without translation.

  **The key constraint:** every field must match `interoperability`'s field name and shape exactly, or be absent. No renames, no incompatible shapes. Agent Bureau's types become structural supersets — `interoperability.ToolCall` automatically satisfies `weft.ToolCall`. Audit Weft's surviving types against `interoperability`'s field names during implementation; rename Weft's where they diverge (Pre-release, hard cut on Weft's side).

  **Type-compat test under `test/agent-bureau-compat/`:** import `interoperability` types as `devDependency`-only. Assert at the type level that `interoperability.ToolCall extends weft.ToolCall`, `interoperability.ToolResult extends weft.ToolResult`, `interoperability.ConversationHistory extends weft.ConversationHistory`. Pass `interoperability`-shaped values through Weft's APIs and assert they work without translation.

  Document the structural-superset contract in agent docs. New `documentation/integrations/agent-bureau.md`: _"Weft is the durability layer; Agent Bureau is the agent framework that consumes it."_ Show the canonical setup; link from README.

  **Out of scope:** importing Agent Bureau in Weft source; forking Agent Bureau types into Weft; re-implementing `armorer` middleware or `conversationalist` undo/redo. Provider transport restructuring and MCP integration alignment are subsumed by the AI Surface Shrinkage and MCP Server items respectively — not listed separately here.

- [ ] **Make Weft's `Storage` interface a structural superset of Agent Bureau's `KeyValueStore`.** 🚨

  **Where:** `src/storage/interface.ts`, `src/storage/scoped-storage.ts`, every adapter under `src/storage/`.

  Goal: Agent Bureau drops its own `KeyValueStore` abstraction and consumes Weft's `Storage` directly.

  **Diff today:**

  | Concept           | Weft `Storage`                                            | Agent Bureau `KeyValueStore`        |
  | ----------------- | --------------------------------------------------------- | ----------------------------------- |
  | Value type        | `Uint8Array`                                              | `string`                            |
  | Read              | `get(key): Promise<Uint8Array \| null>`                   | `get(key): Promise<string \| null>` |
  | Write             | `put(key, value)`                                         | `set(key, value)`                   |
  | List              | `scan(prefix, opts): AsyncIterable<[string, Uint8Array]>` | `list(prefix): Promise<string[]>`   |
  | Atomic batch      | `batch(ops)`                                              | (none)                              |
  | Conditional batch | `conditionalBatch?` (CAS)                                 | (none)                              |
  | Namespace         | `ScopedStorage` wrapper                                   | `withNamespace()` helper            |
  | Close             | Via `Disposable`                                          | `close?()`                          |

  **Already covered:** adapter reachability exists for Memory, SQLite, IndexedDB, WebExtension, HTTP, and runtime-driven storage resolution. `Storage.keys()` is also available as an async-iterable fast path across the built-in adapters.

  **What remains:**
  1. **Value type story:** keep `Uint8Array` canonical; add a `withTextValues()` wrapper (analogous to `ScopedStorage`) that handles `Uint8Array` ⇄ `string` encoding via `TextEncoder` / `TextDecoder`. The contract stays narrow; ergonomic concern solved by a wrapper.
  2. **Agent Bureau list compatibility:** provide a small compatibility wrapper or helper that maps Weft's async-iterable `keys(prefix)` surface to Agent Bureau's `list(prefix): Promise<string[]>` shape.
  3. **Type-compat test:** import `KeyValueStore` from `agent-bureau/storage` as `devDependency`-only; assert any Weft `Storage` (suitably wrapped) satisfies `KeyValueStore`.
  4. Document the migration path in `documentation/integrations/agent-bureau.md`.

  Lands with or before the tool-types compat item. Both are pre-1.0; this locks in Weft's storage interface as the canonical shape for the agent ecosystem.

## 7. Documentation

- [ ] **Update the Service Worker guide to lead with `setupServiceWorker()`.**

  **Where:** `documentation/guides/service-worker.md`, with cross-links from `documentation/architecture/browser-runtime.md`, `documentation/guides/server.md`, and README.

  The guide exists and covers the lower-level Service Worker primitives, but `setupServiceWorker()` has since landed. Make the one-call helper the primary quickstart, then keep `createFetchHandler()`, `createLifecycleHandlers()`, `createPeriodicSyncHandler()`, and manual `engine.scheduler.tick()` wiring as the lower-level escape hatch.

  Keep the existing browser-runtime coverage: Service Worker persistence over IndexedDB, Periodic Background Sync support and fallbacks, lifecycle limitations, HTTPS requirements, path-prefix wiring, debugging, and common pitfalls.

- [ ] **Hello World implies activities are closures; reality is they're named, registered units.**

  Same files as above. Today's example writes `async function greet(name)` inline and passes it to `ctx.run(greet, user.name)`. That works only because everything's in one process. `ctx.run` captures `fn.name` and yields an operation keyed by that name (`src/core/context.ts:974-982`); the engine resolves it via `#activityRegistry.resolve(operation.activityName)` (`engine.ts:6686`). On the remote path, only the name + serialized args travel over the WebSocket — the closure-captured `fn` never runs.

  Fix: in Hello World, either call `engine.registerActivity('greet', ...)` and reference by name, or keep the closure form with a one-line note pointing at Remote Workers. In `documentation/guides/activities.md`, lead with "activities are registered by name; `ctx.run` dispatches by name." Show the paired engine + worker shape end-to-end in the Remote Workers section.

- [ ] **Write `documentation/guides/multi-tenancy.md` and link it from the README.**

  **The gap:** the README has 12 lines on multi-tenancy (lines 237-250) showing `tenantFromInputField` and `tenantQuotas`, with no deeper guide. Tenant references are scattered across `documentation/guides/remote-workers.md` and `interceptors.md`.

  **What the guide must cover:** conceptual model (logical isolation boundary); tenant resolution (`tenantFromInputField`, custom `tenantResolver`, default-tenant behavior, resolution failures); per-tenant quotas (`maxRunningWorkflows`, `workflowCreationRateLimit`, storage quotas — what's enforced where, what error surfaces, how to monitor); tenant scoping in agents (cross-link `documentation/agents/agent-declaration.md`'s `toolsForTenant`); tenant context in workflows (`ctx.tenant`, propagation to activities, interceptor visibility); storage isolation (`ScopedStorage`); deployment patterns (single-engine multi-tenant, per-tenant engines, hybrid); observability and auditing (tenant-tagged events / traces / metrics); security boundaries (what tenants cannot vs. can see across each other); common pitfalls (resolver returning wrong tenant, quotas hitting before user expects, cross-tenant signal injection, debugging "wrong tenant" incidents).

  Cross-link to `agent-declaration.md`, `api-context.md`, `api-engine.md`, `configuration.md`, `remote-workers.md`, `interceptors.md`. Add a `[Multi-Tenancy](documentation/guides/multi-tenancy.md)` link to the README's Documentation/Guides bullet list and a one-line pointer at the end of the README's Multi-Tenancy section. Ship the guide and the README link in the same PR.

- [x] **Write `documentation/guides/service-worker.md`.**

  > File pre-existed; rewrite added the `setupServiceWorker()` quickstart, decision tree, browser support matrix, debugging, and pitfalls coverage the roadmap called for.

  **Where:** new file. Cross-link from `documentation/architecture/browser-runtime.md` (currently the only walkthrough), `documentation/guides/server.md` (mentions in passing at line 206), README.

  **What the guide must cover:** conceptual model (Service Worker as durable persistence backbone over IndexedDB; background timer wakeup via Periodic Background Sync; intercepts `fetch` for the engine's HTTP surface); quickstart using `setupServiceWorker()` (after section 7's helper lands); registration (`navigator.serviceWorker.register('/sw.js')`, registering workflows inside the worker, communicating from page code via the engine's HTTP surface); Periodic Background Sync (Chrome / Edge / Opera; not Firefox / Safari at time of writing — verify; fallback when unavailable is `setTimeout` polling that only works while a tab is open); limitations and gotchas (~30s idle termination, IndexedDB quota, first-install lifecycle race, HTTPS requirement except localhost, scope considerations); path prefix and the engine's HTTP surface (`pathPrefix` default `/weft/`); browser support matrix; debugging (Application tab, Update on reload, clearing storage); pairing with PWAs; common pitfalls (Periodic Background Sync not registered/supported being the most common, hot-reload causing reload loops, cross-tab state coordination via `BroadcastChannel`).

  **Out of scope:** general Service Worker tutorials (link to MDN); PWA build tooling (Workbox, vite-plugin-pwa) — different concern, mention in passing; Web Workers (non-Service-Worker) — separate doc.
