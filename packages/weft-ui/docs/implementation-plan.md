## Weft UI — Implementation Plan

> **This document supersedes and combines** `Weft UI.md` (architecture + UX/IA/flows) and `Weft UI - Wireframe Requirements.md` (visual spec + Cinder mapping) into a single plan **organized for Fable-driven execution**: locked decisions up front, ground truth verified against the current repositories, a Cinder-first component policy, and a phased task breakdown where every task is PR-sized with explicit acceptance criteria and verification commands.
>
> - Engine: `stevekinney/weft` → npm `@lostgradient/weft` (pre-release; breaking changes welcome, no compatibility layers)
> - Components: `stevekinney/cinder` → npm `@lostgradient/cinder`; `package.json` is live version truth and currently pins **v0.24.0**. Use supported public entrypoints and the [README's current dependency and adoption record](../README.md#historical-cinder-first-evaluations-after-the-0190-bump).
> - Visual direction: Claude Design project `78301189-3414-48f4-bf40-8d4bc28da7b7` (`Weft UI.dc.html`, `Weft Patterns.dc.html`, screenshots for workflow list/timeline/saga, schedules, reviews, diagnostics, discovery, confirmation tiers) — indigo-on-cool-blue-grey, OKLCH + `light-dark()`, 14px base, Lucide icons, "the brand is the restraint"

---

### 0. Ground Truth — What Changed Since the Source Documents

Both source documents were verified against the repositories on 2026-07-09. Several load-bearing claims are now **stale**. Every task in this plan builds on the corrected facts below; do not re-import the old assumptions.

| Old claim (source docs) | Current truth (verified in repo) | Consequence |
|---|---|---|
| "No fleet-wide / cross-workflow stream; ~18 engine events never reach a wire channel; lists and notifications must be polling-backed stopgaps" (issues #574/#575) | **Fleet-wide channels exist**: `GET /api/v1/events/sse` (scope `events:read`, accepts `workflowId`, `kind`, `fromCursor`, `Last-Event-ID` resume) and JSON-RPC WebSocket `weft.events.subscribe` (+ per-workflow `weft.workflows.subscribe`), with events delivered as `weft.events.deliver` notifications. Fleet subscriptions include worker connection lifecycle events. | The realtime layer is **push-first from day one**. `LiveSource` remains the abstraction, but `FleetEventSource` is a v1 implementation, not a future upgrade. Polling survives only as the degraded fallback. |
| "Watch/stream WebSocket upgrades bypass scope authorization" (#573) | Fixed: `/v1/workflows/:id/watch` requires `events:read`, `/v1/workflows/:id/stream` requires `streams:read`; classification in `src/server/runtime/websocket-upgrade.ts`. Cross-origin WS upgrades are rejected 403 when a `cors` policy is set and Origin mismatches. | No security caveat to design around; scope-gate the Live toggles instead. |
| Cinder verified at **v0.3.0**; net-new list included schema-driven forms, payload inspector shape, query-builder rows | **Historical authoring snapshot:** Cinder was at **v0.9.0** when this inventory was written. It recorded `SchemaForm`, `JsonSchemaEditor`, `PayloadInspector`, `JsonViewer`, `DataTable`, `DataGrid`, `VirtualList`, `RunStepTimeline`, `EventStreamViewer`, `FacetedFilterBar`, `ApprovalCard`, `PermissionMatrix`, `InvocationRuleBuilder`, `CommandPalette`, `SecretValueField`, and chart components available at that time. This inventory is decision context, not current API truth. | For current work, inspect the installed package's supported public entrypoints. The payload editor, scope matrix, query builder, timeline, and virtualized views remain Cinder-first compositions, not custom-build defaults. |
| "Import the generated `operation-client.generated.ts` and build a `call<T>()` transport" | `HttpClient` from `@lostgradient/weft/client` is **browser-ready as-is**: `new HttpClient({ baseUrl, headers?, token?, eventTransport?, webSocketFactory? })`, exposing the full ergonomic `WeftClient` surface plus `client.operations['weft.<name>'](input)` / `call(name, input)` typed against the generated catalog, `client.activity.complete/completeExceptionally`, and `tail(id)` with `eventTransport: 'auto' | 'websocket' | 'sse'`. | The console's data transport is `HttpClient`, full stop. No parallel HTTP layer, no hand-rolled `call<T>()`. The type pipeline is "keep `@lostgradient/weft` current." |
| REST paths shown as `/v1/…` | Everything functional is served under **`/api`** (`API_PREFIX`): `/api/v1/workflows`, `/api/jsonrpc`, `/api/mcp`, WS upgrades. Seven routes stay root-relative: `/v1/health`, `/v1/metrics`, `/openapi.json`, `/openrpc.json`, `/asyncapi.json`, `/.well-known/api-catalog`, `/.well-known/mcp.json`. | Dev proxy and `HttpClient` baseUrl handling must respect the split. (`HttpClient` already does.) |
| Dashboard mount described without an auth caveat | `serve({ dashboard })` registers the shell via Bun's static `routes` table, which is matched **before** Weft's `fetch`/auth handler — the shell HTML itself is **never authenticated**, only the API calls it makes. Bun's route table also physically prevents the shell from shadowing `/api/*` or root discovery routes. | Deployment docs must say: put the shell behind a reverse proxy / private network if the HTML itself needs access control. The app treats "who am I" as an API question, not a page-load question. |
| — (not covered) | Service Worker support is concrete: `setupServiceWorker(options)` (`src/service-worker/setup.ts`) wires install/activate/fetch/periodicsync and delegates to `handleRequest(request, engine)` (`src/server/handler.ts`), default `pathPrefix: '/weft/'`, storage via `resolveDefaultStorage()` → `IndexedDBStorage`. `serve({ dashboard })` / `DASHBOARD_PAGE_ROUTES` is Bun-only and does **not** apply in a SW. | SW mode is a first-class deployment target with its own mount story (§3.3): host page serves the console assets; transport is fetch/SSE (WebSocket upgrades cannot traverse a Service Worker). |
| Bulk operations described loosely | Bulk ops require `workflows:admin` and use a **dry-run / confirmation-token preview flow** server-side (`POST /api/v1/workflows/bulk/{cancel,signal,retry-failed}`, `DELETE /api/v1/workflows/bulk`, `PATCH /api/v1/workflows/bulk/tags`, `POST /api/v1/workflows/purge`). | The Tier-3 confirmation UI maps 1:1 onto the server's preview→confirm token protocol; the affected-count in the modal comes from the dry run, not a client-side estimate. |

Facts carried forward from the source documents (two have since moved — Appendix A is the maintained ground truth: the mount contract grew from five routes to eight in weft 0.16.0, and the authorization vocabulary shrank from 23 scopes to 21 when the unused budget scopes were dropped): the `DASHBOARD_PAGE_ROUTES` mount contract, `DashboardRouteTarget = Bun.Serve.Routes<unknown, string>[string]`, the flat authorization vocabulary, the six fault codes with REST masking of `EngineFailure` as `{ error: "Internal server error" }` (JSON-RPC receives the full fault object), offset pagination (limit/offset, default order `createdAt` desc + `id` asc), `group_by=status|type|failureCategory|attribute:<name>` aggregates, failure-category taxonomy `application|timeout|cancellation|resource|system`, per-operation `unknownKeyPolicy` differing between HTTP and JSON-RPC, and the `maxStreamConnectionsPerWorkflow` (default 100) shared WS+SSE budget with 1,000-event replay caps and `1008` close codes.

---

### 1. Locked Decisions

These are settled. Fable tasks execute against them without re-litigating.

1. **Deliverable**: a new repository `weft-ui` (sibling of `weft` and `cinder`), publishing `@lostgradient/weft-ui`. Weft stays headless (the repo's `component-standards` skill forbids reintroducing `src/dashboard/**`). The package exports:
   - `weftUi(options?): DashboardRouteTarget` — the Bun mount for `serve({ dashboard: weftUi() })`.
   - Built static assets (`dist/`) importable/copyable for non-Bun hosts (reverse proxies, Service Worker host pages).
2. **SPA, no SSR, no SvelteKit.** Svelte 5 components + a minimal client-side router under the five owned route prefixes. The console is always behind auth; SSR has no payoff and fights the static-`Response` mount.
3. **Cinder-first, upstream-first.** Every UI need uses the `@lostgradient/cinder` component when one exists (§7.1). When one doesn't and the need is generic, **add it to Cinder upstream** (§7.2) — we own the library. Bespoke app-local components are limited to the short list in §7.3. Never fork or wrap a Cinder component to change its visuals; fix it upstream.
4. **Transport is `HttpClient`** from `@lostgradient/weft/client` — ergonomic methods for the common surface, `client.operations['weft.<name>']` for everything else (workers, queues, diagnostics, registry, metrics, storage). No hand-maintained API types; drift is caught by bumping the `@lostgradient/weft` dependency and type-checking.
5. **Server cache: TanStack Query v5** (`@tanstack/svelte-query`). URL owns filter/pagination/selection/tab state; Svelte runes own ephemeral UI state; no global state library.
6. **Realtime is push-first** over the now-existing fleet SSE channel + per-workflow tail, behind a uniform `LiveSource` interface with a polling fallback implementation (§5).
7. **Theme**: Cinder tokens, both light and dark via `data-theme` + `light-dark()` (Cinder gives us light mode for free — the "dark-only v1" constraint from the old plan is dropped since it costs nothing). Dense operator-console aesthetic per the Claude Design project. No ad-hoc colors: status maps to Cinder `StatusDot`/`Badge` tones.
8. **Payload editing**: `SchemaForm` for schema-driven form mode; CodeMirror 6 (lazy-loaded) for raw-JSON mode; `PayloadInspector`/`JsonViewer` for read-only display. Not Monaco.
9. **Testing**: Bun test + happy-dom + `@testing-library/svelte` for components; plain-`.ts` logic modules unit-tested without a DOM; **integration tests against a real in-process `serve({ engine })`** (weft is a dependency — no mock server); Playwright + axe for E2E/a11y on critical flows. TDD, 100% coverage target with an explicit allowance file (§11).
10. **Scope gating**: show-but-disable-with-reason for actions; section-level lock states for unviewable data; never hide capability. Fault presentation follows the six-code table (§10.4).

---

### 2. Repository Layout and Build

```
weft-ui/
├── package.json              # @lostgradient/weft-ui; peers: svelte, lucide-svelte; deps: @lostgradient/{weft,cinder}, @tanstack/svelte-query
├── src/
│   ├── mount.ts              # weftUi(): DashboardRouteTarget — Bun.file(dist/index.html) Response
│   ├── main.ts               # SPA entry: router, QueryClient, shell mount
│   ├── app/                  # shell: navigation, command palette, notification center, scope context
│   ├── routes/               # one directory per domain: dashboard/, workflows/, schedules/, workers/, reviews/, storage/, system/
│   ├── lib/                  # framework-free .ts modules (unit-testable without DOM):
│   │   ├── client.ts         #   HttpClient construction + runtime config resolution
│   │   ├── live-source/      #   LiveSource interface + WebSocketTailSource, FleetEventSource, PollingSource
│   │   ├── filters.ts        #   ListFilter ↔ URLSearchParams round-trip serializer
│   │   ├── scopes.ts         #   principal store + hasScope()
│   │   ├── faults.ts         #   fault → UI treatment mapping
│   │   └── format/           #   ids (truncate 8…4), durations, cron preview, bytes
│   └── styles/               # entry CSS: @lostgradient/cinder/styles + app-owned rules
├── tests/                    # integration (real serve()) + Playwright e2e
└── scripts/                  # build, size-budget check, coverage gate
```

- **Build**: Svelte compile + Bun bundler (`bun build --splitting --minify --sourcemap external`, content-hashed assets) for the **production** artifact.
- **Dev server with full HMR is a hard requirement**, not an ergonomic nice-to-have: editing a `.svelte` file hot-swaps the component in place (no full-page reload, surrounding component state preserved where Svelte's HMR semantics allow); editing CSS hot-applies; editing a `.svelte.ts`/`.ts` module triggers the narrowest viable update. The proven path for Svelte 5 HMR is **Vite + `@sveltejs/vite-plugin-svelte`** (compiler-integrated HMR with runes support); `bun-plugin-svelte`'s dev-server HMR may be used **only if** it passes the T0.3 HMR acceptance tests. If that means dev = Vite while prod = Bun bundler, that split is acceptable and documented in the README — HMR quality wins over toolchain purity here (decide in Phase 0, record the outcome, don't carry two prod pipelines).
- **Code-splitting** by domain: entry chunk (shell, router, scope context, error boundary) small; each route directory an async chunk; CodeMirror its own always-lazy chunk.
- **Conventions**: kebab-case filenames; `.ts`/`.svelte` only; ESM; implementation files ≤500 lines; logic lives in `src/lib/*.ts` (or `.svelte.ts` for rune-based modules) with `.svelte` files kept thin.
- **Dev loop**: standalone dev server on its own port proxying `/api/*`, `/v1/*`, root discovery routes, and WS upgrades to a local `weft serve` (target via `WEFT_API_BASE_URL`); the proxy must pass SSE (`text/event-stream`, unbuffered) and WebSocket upgrades through intact so realtime behavior in dev matches production. Same-origin in production, so no CORS in the default deployment.
- **HMR safety for stateful modules**: `LiveSource` implementations and the notification store register `import.meta.hot?.dispose` cleanup so a hot update closes their sockets/SSE streams before the replacing module opens new ones — a hot edit must never leave orphaned connections or double-subscribed feeds (this is also what keeps the ≤3-connection budget true during development).

---

### 3. Mount and Deployment Modes

The console is one bundle with a tiny runtime configuration layer; the three modes differ only in how assets are served and which event transport is viable.

#### 3.1 Bun Server Mount (primary)

```ts
import { serve, Engine } from '@lostgradient/weft';
import { weftUi } from '@lostgradient/weft-ui';

const engine = await Engine.create({ workflows });
await serve({ engine, dashboard: weftUi() });
```

**API shape (decided, with the alternative considered):** `serve({ dashboard: weftUi() })` — an option on `serve()`, not a wrapper like `ui(server(engine))`. The wrapper composition was considered and rejected: (1) Bun's route table must be complete when `Bun.serve()` binds — the static `routes` map matched ahead of the `fetch` handler is exactly what makes it _impossible_ for a mounted shell to shadow `/api/*`; a `ui()` that decorates an already-running server would have to mutate routes post-bind (`server.reload()` machinery) or turn `server()` into a deferred builder, adding indirection to preserve a property the option already has for free. (2) Weft's stated design principle is options-first configuration; the console is a payload weft mounts under _its_ route contract, and `ui(server(…))` inverts that ownership — it reads as the UI owning the server. (3) The composable half of the instinct is already satisfied: `weftUi()` is a pure, framework-free value (`DashboardRouteTarget`) usable anywhere a Bun route target fits, not something coupled to `serve()`. One optional cosmetic: since weft is pre-release, the `dashboard` option could be renamed `console` to match the product name — fine either way, but `dashboard` is generic on purpose (the option predates and doesn't presume this package).

- `weftUi()` returns a static `Response` (streamed via `Bun.file`) registered by weft at exactly the five `DASHBOARD_PAGE_ROUTES`. Hashed asset files are served alongside (the mount option accepts an asset base URL for CDN deployments).
- **Client-side sub-routing** under the owned prefixes covers Schedules/Storage/System at v1 (deep-linkable via `/?view=schedules` style or history-API routes under `/`); a contract-extension issue is filed upstream to grow `DASHBOARD_PAGE_ROUTES` with `/schedules`, `/storage`, `/system` (§14.1) — when it lands, the router's route table gains the aliases and nothing else changes.
- **Security note (must appear in the README)**: the shell HTML is served before weft's auth handler; `serve({ auth })` protects the API, not the page. Anyone who can reach the port gets the (empty, data-free) shell. Deployments that must hide the shell put it behind a proxy.

#### 3.2 CLI Startup (upstream Weft work)

For `weft serve` users (server-mode, no code), add an upstream weft CLI affordance: `weft serve --console` resolves `@lostgradient/weft-ui` (optional peer, actionable error if not installed) and passes `weftUi()` as `dashboard`. This is a small, explicit feature — filed as an upstream issue (§14.1), not blocking console v1 (library users mount manually).

#### 3.3 Service Worker Mode

When the engine runs inside a Service Worker (browser/WebExtension, `IndexedDBStorage`), there is no Bun server and no `DASHBOARD_PAGE_ROUTES`:

- The **host page** serves the console assets itself (import the built `dist/` from the package) and registers the SW via `setupServiceWorker({ pathPrefix: '/weft/' , …})`.
- The console boots with runtime config `{ baseUrl: '/weft' }` so `HttpClient` requests hit the SW's `fetch` listener → `handleRequest(request, engine)`.
- **Transport constraint**: WebSocket upgrades cannot be intercepted by a Service Worker. The console detects/receives `eventTransport: 'sse'` in this mode — `HttpClient.tail()` already supports SSE, and the fleet feed is SSE-native. A SW `fetch` handler can return a streaming `Response`, so SSE works end-to-end; verify this in an integration test in Phase 9 and file a weft issue if `handleRequest` buffers instead of streams.
- Runtime config is injected as a JSON `<script type="application/json" id="weft-ui-config">` block (baseUrl, eventTransport, asset base) read once at boot — the same bundle serves all three modes.

#### 3.4 Standalone / Cross-origin

Console on a different origin than the weft server: supported via weft's `cors` option (explicit `allowedOrigins`, `credentials` as needed — weft validates illegal wildcard combos at `serve()` time) plus `publicOrigin`/`trustedHosts` for discovery URLs. Cross-origin WS upgrades are Origin-checked. This mode exists for development and hosted-console scenarios; same-origin is the documented default.

---

### 4. Data Layer

- **One `HttpClient` per app** created in `src/lib/client.ts` from runtime config; provided via Svelte context. Auth: `token`/`headers` from config or an operator-entered API key held in memory (never persisted to localStorage by default).
- **TanStack Query** owns all server state. Query keys encode full fetch parameters: `['workflows','list',filter]`, `['workflows','detail',id]`, `['workflows','events',id,cursor]`, `['workflows','aggregate',groupBy,filter]`, `['schedules','list',filter]`, `['workers','list']`, `['queues','list']`, `['diagnostics']`, `['reviews','list',filter]`, `['registry']`, `['retention']`, `['metrics']`, `['principal']`.
- **Pagination**: offset-based, page size 50 default (25/50/100 offered; never expose the 1000 API max for browsing). `placeholderData: keepPreviousData`. Lists note "results are a snapshot at page load."
- **Mutations** invalidate precisely: workflow mutation → `['workflows','detail',id]` + `['workflows']` partial + aggregate. Optimistic updates only for tags/attributes; start/cancel/signal show pending state and confirm on round-trip.
- **REST vs JSON-RPC**: REST for queries and simple mutations (cacheable, predictable statuses). Because REST masks `EngineFailure` to a generic 500 while JSON-RPC carries the full fault object, route **bulk and admin operations through JSON-RPC over HTTP** (a `preferRpc` set) so operators debugging an incident see real fault details. Respect per-operation `unknownKeyPolicy` differences — never spread unvalidated extras into inputs.
- **Filters ↔ URL**: `src/lib/filters.ts` serializes the typed list filter to/from `URLSearchParams` matching the REST grammar exactly (`status`, `type`, repeated `tag` (AND), `id_prefix`, repeated `failure_category` (OR), `created_at_{gte,gt,lte,lt}` (+ updated_at, execution_deadline), `attribute.<name>[.op]`, `include=failureCategory`, `limit`/`offset`). Round-trip property-tested.

---

### 5. Realtime Architecture (push-first)

Every live surface consumes the uniform interface:

```ts
interface LiveSource<Frame> {
  subscribe(onFrame: (f: Frame) => void): () => void;
  whenConnected(): Promise<void>;
  status: 'connecting' | 'live' | 'reconnecting' | 'polling' | 'closed';  // rune-backed
  close(): void;
}
```

Implementations in `src/lib/live-source/` (plain `.svelte.ts`, no component coupling):

1. **`WorkflowTailSource`** — wraps `client.tail(id)` (`eventTransport: 'auto'`: WS `/api/v1/workflows/:id/watch`, SSE fallback). Single consumer, sequence-cursor resume (`?resumeFrom=` / `Last-Event-ID`), exponential backoff capped at 30s, `whenConnected()` resolves after catch-up (`replayComplete` ping), buffer bounded ~500 frames with a `bufferOverflow` staleness signal. Frames **write into the TanStack cache** (`setQueryData` on detail + events); components render from the cache so a disconnect degrades to last-known-state, never a blank.
2. **`FleetEventSource`** — `GET /api/v1/events/sse` (scope `events:read`), optional `kind`/`workflowId` filters, cursor resume via `Last-Event-ID`. The feed exposes the full 32-kind `EVENTS_READ_EVENT_TYPES` enum (`src/server/runtime/client-visible-events.ts`): workflow lifecycle incl. suspended/resumed/teardown, activity lifecycle incl. async-pending, dead-letters, signals/updates/attributes, schedule fired/missed-fire, review requested/completed, `alert:fired`/`alert:resolved`, `constraint:violated`, worker connected/disconnected, and operational warnings (checkpoint-size, development, cleanup, storage-size). Feeds: dashboard activity feed, list-row liveness (invalidate/patch matching list queries), the notification center (reviews, missed fires, worker-down, dead-letters, alerts, constraint violations, size warnings), and worker fleet views. One SSE connection, shared by subscription fan-out in the source — never per-row connections.
3. **`PollingSource`** — interval refetch wrapper (suspends when `document.hidden`). Fallback when the principal lacks `events:read`, when SSE fails repeatedly (cap 5 attempts, then surface status), and the default for low-churn surfaces (metrics ~15s, workers ~30s if the fleet feed is unavailable).

**Connection budget**: ≤3 concurrent sockets — one workflow tail (closed on navigating away from detail), one fleet SSE, one JSON-RPC WS session (opened lazily, multiplexed). The `maxStreamConnectionsPerWorkflow` cap and `1008` replay-violation close codes are handled as reconnect-with-refetch, not errors shown raw.

**UI treatment** (§10.5): every live surface binds `LiveSource.status` to the connection indicator; "+N events" pause-to-read counter on fast streams; incoming events batched into ≤100ms frames. Lists default Live **off**; detail Events/Logs default Live **on** while the workflow is running. When a surface is in `polling` status, it must say so ("updated every 30s") — never imply push freshness during an incident.

**Service Worker mode**: `WorkflowTailSource` and `FleetEventSource` run over SSE only (§3.3); the abstraction makes this a config default, not component logic.

---

### 6. Auth and Scope Gating

- On boot, resolve the principal (`weft.system.principal`-equivalent catalog op; verify exact name at Phase 1 and pin in a test). The 23 scopes are flat — check each independently (`workflows:admin` does not imply `workflows:read`): `workflows:{read,write,admin}`, `schedules:{read,write}`, `signals:write`, `updates:write`, `queries:read`, `reviews:{read,write}`, `attributes:{read,write}`, `tags:write`, `streams:read`, `events:read`, `budget:{read,write}`, `storage:{read,write,admin}`, `workers:write`, `system:{read,admin}`.
- `src/lib/scopes.ts`: principal store + `hasScope(…required)` (rune-derived). Gating convention: **disable-with-tooltip** ("Requires workflows:admin") for actions; **lock-state section** (`EmptyState` + lock icon + scope name) for unviewable panels; never hide capability.
- `unauthenticatedAccess`: `'warn'`/`'allow'` → treat all scopes as granted, show the mode banner ("Running in unauthenticated mode…" — softer badge for `allow`); `'reject'` → 401 clears the principal and shows the API-key entry surface.
- 401 → re-auth; 403 → inline scope error at the operation, never a page redirect.
- MCP `Mcp-Session-Id`/`Mcp-Session-Token` is an integrator-education surface (System → Discovery), not a console transport concern.

---

### 7. Component Policy—Current Cinder Contract

#### 7.1 Historical authoring snapshot and current usage

The mapping below is the historical v0.8.0/v0.9.0 authoring snapshot. Preserve it as decision context, but verify current APIs against `package.json`, the installed package, and supported public Cinder entrypoints before implementation. Import the base `@lostgradient/cinder/styles` stylesheet once; component JavaScript entrypoints load their own CSS, so do not maintain per-component style sidecars or import `styles/all`. Peers remain `svelte` and `lucide-svelte`.

| UI need | Historical Cinder authoring snapshot (v0.8.0) |
|---|---|
| Shell: sidebar, header, breadcrumbs | `Sidebar`, `SideNavigation(Group/Item)`, `NavigationBar`, `Breadcrumbs`, `Toolbar` |
| Cmd+K search | `CommandPalette` (+ `CommandItem`, `Kbd`, `KeyboardShortcuts`) |
| Banners (auth mode, contested lease, replay) | `Banner` |
| Notifications / toasts | `ToastRegion` + `useToast()`, `DropdownMenu`, `Badge` (unread) |
| Status | `StatusDot`, `Badge`, `Chip`; live status → ConnectionIndicator (§7.2 verify-or-add) |
| Tables | `DataTable` (default; sortable, virtualized) / `DataGrid` (only where cell-level selection earns it), `Pagination`, `LoadMore` |
| List filtering | **`FacetedFilterBar`** (workflow/schedule/review lists) + `Combobox`/`MultiSelect`/`TagInput`/`SearchField`/`DateRangeField`/`Slider` |
| Definition/overview lists | `DescriptionList`, `DataList`, `Stat`/`StatGroup` |
| Read-only payloads | `JsonViewer` (small), **`PayloadInspector`** (Summary/Tree/Raw + byte-size/truncation — the default for inputs/results/errors/attributes) |
| Payload editing | **`SchemaForm`** (form mode from registry `inputSchema`) + CodeMirror 6 chunk (raw mode) + `SegmentedControl` toggle; `JsonSchemaEditor` is for editing schema documents, not values — reference only |
| Workflow timeline | **`RunStepTimeline`** (step states incl. retrying/waiting-approval, durations, attempt counts, nested child lanes, expandable panels); `Timeline`/`EventTimeline` for generic sequences |
| Event/log streams | **`EventStreamViewer`** (Events + Logs tabs — has `connectionState`, follow-latest/paused scrolling, reconnect boundaries with `replayedCount`, sequence-gap markers, and built-in empty/loading/disconnected/truncated states), `VirtualList` where raw windowing is needed |
| Activity feed | `Feed`/`FeedEvent` (live-region) |
| Charts | `BarChart` (aggregates, failure categories), `LineChart`/`AreaChart` (metrics sparklines), `MatrixChart` (scope matrix heat), `Sparkbar`/`Meter` (inline capacity/utilization) |
| Scope matrix | **`PermissionMatrix`** |
| Reviews | **`ApprovalCard`** (redesigned in v0.9.0—single callback, decision-first layout, simplified `PayloadInspector` embedding; evaluate against the partial-section-decision requirement), `SegmentedControl` + `Textarea` decision form, `Avatar(Group)`, Markdown artifacts via `@lostgradient/markdown/rendering` |
| Query builder | **`InvocationRuleBuilder`** pattern (condition field/operator/value rows) — reuse/extend upstream rather than building rows from scratch (§7.2) |
| Wizards / steps | `Steps`, `Modal`/`Drawer`/`Sheet` |
| Confirmations | `ConfirmDialog` (Tiers 1–2), `AlertDialog` + `Input` type-to-confirm + `Progress` (Tier 3 + bulk progress) |
| Inline faults / callouts | `Alert`, `Callout`, `Banner`; stack traces in `CodeBlock` inside a collapsible |
| Empty/loading | `EmptyState`, `Skeleton`, `InlineLoading`, `Spinner` |
| Tabs / toggles | `Tabs` family, `SegmentedControl`/`Segment` |
| IDs | `CopyButton` + `Tooltip`/`HoverCard` (truncate `first8…last4`, monospace) |
| Splits / scroll | `ResizablePanels`, `ScrollArea` |
| Secrets/tokens display | `SecretValueField` (API keys; async-activity tokens are explicitly _not_ secrets — plain `CodeBlock` + `CopyButton` with the "deterministic identifier, not a secret" label) |
| inputSchema type tree | `Tree`/`TreeItem` |
| Row/context menus | `DropdownMenu` family, `ContextMenu` |
| Layout | `Card`, `Surface`, `Container`, `Grid`, `Divider` |

#### 7.2 Upstream Cinder Additions (we Own it — Fix it at the source)

Each is a ticket on `stevekinney/cinder` (filed in Phase 0; `gh issue create` with spec + console screenshot references), built to Cinder's standards (README + a11y.md + schema + variables + tests + examples). The console pins a Cinder version per phase and bumps as these land.

| Addition | Spec sketch | Console dependency |
|---|---|---|
| **C1. Branch/coordination groups in `RunStepTimeline`** | Extend the existing nested-lane model with: branch groups (N parallel sub-lanes with per-branch outcome; winner emphasized, losers muted), a rewound/struck-through step state (speculation), and compensation linkage (a step rendered inset beneath its forward step with a reversal affordance). Generic vocabulary — "branch group", "compensated", "rewound" — no Weft jargon in the component API. | Phase 3 (Timeline). Until it lands, the timeline renders coordination steps as flat groups with text labels — degraded but correct. |
| **C2. `ConnectionIndicator`** | **Confirmed absent in v0.9.0** (grep across `src/components` on `origin/main`). Scope is narrow: a standalone status pill for `connecting/live/reconnecting/polling/stale/closed` with pulsing-dot live state and attempt-count slot — for lists, the engine pill, and the fleet feed. Stream surfaces don't need it: `EventStreamViewer` already has a `connectionState` prop, built-in disconnected/truncated states, and typed `StreamReconnectedBoundary` entries (with `replayedCount`) — align the pill's state vocabulary with it. | Phase 1 (LiveSource UI). Fallback: `StatusDot` + label composition. |
| **C3. `ScheduleBuilder`** (upgraded from a bare `CronField`) | A composite recurrence-definition surface, because raw cron input is a bad interface for most operators. Three lossless modes behind a `SegmentedControl`: **Presets** ("every N minutes/hours", "daily at HH:MM", "weekly on [days] at HH:MM", "monthly on day N") ↔ **Cron** (5-field input with per-field validation and inline field hints) ↔ **Interval** (number + unit). Always-visible: human-readable summary ("Every day at 02:00") and a "next N fires" preview list (preview computation injected via callback — the component stays date-lib-free), plus a timezone display slot. Emits a discriminated `{ mode: 'cron' | 'interval', … }` value. Weft-specific semantics (overlap policy, jitter, backfill) stay in the console's form around it — the Cinder component owns recurrence definition only. | Phase 4 (Schedules). Fallback: `Input` + app-local preview, upgrade on landing. |
| **C4. Generalize `InvocationRuleBuilder` condition rows** | If the current API can't express "conditions only, no action target, constrained operator set (eq/gt/lt/gte/lte), typed value inputs", add that mode upstream rather than cloning the row assembly. | Phase 2 (list filters). Fallback: compose `Combobox`+`Select`+`Input` rows app-locally, migrate when upstream lands. |
| **C5. Donut/segment chart** _(optional)_ | Only if the aggregate view genuinely wants a part-of-whole toggle; `BarChart` is the v1 default and may be permanently sufficient. Decide at Phase 5; don't build speculatively. | None (optional). |

#### 7.3 App-local Net-new (bespoke is justified)

- **Replay side-by-side divergence view** — two aligned `RunStepTimeline` instances with step-alignment and divergence highlighting; Weft-specific semantics.
- **MCP session-protocol sequence diagram** — one static themed SVG (initialize → token → continued requests → 403 on mismatch).
- **Console shell glue** — router, scope context, LiveSource wiring, notification store: application logic, not components.

Anything else that feels "missing" during implementation goes through the §7.2 upstream-first decision, not into `src/components/`.

---

### 8. Svelte 5 Posture

- **Runes throughout**: `$state`/`$derived`/`$effect`; shared reactive logic in `.svelte.ts` modules (LiveSource status, notification store, principal store) — no legacy `writable` stores unless an external API demands the store contract.
- **Snippets over slot-soup**: table cell renderers, timeline detail panels, and confirmation bodies as `{#snippet}` params, matching Cinder's Svelte 5 idioms.
- **`<svelte:boundary>`** per route chunk with a `failed` snippet rendering the fault treatment (§10.4) + retry via boundary `reset` + query refetch.
- **`$props()` with strict types**; component props interfaces exported next to each `.svelte` file.
- **Attachments (`@attach`)** for DOM-adjacent behavior (IntersectionObserver pagination, scroll pinning in stream views) where Cinder's `useIntersection`/`useResizeObserver` hooks don't already cover it.
- **Fine-grained streaming state**: event frames patch keyed `$state` maps / TanStack cache rather than replacing arrays, so 100ms-batched frames don't re-render whole lists.
- **No SvelteKit imports anywhere**; router is a small history-API module in `src/lib/` (URL state is load-bearing — §4).

---

### 9. Surfaces

Information architecture (unchanged from the source docs): flat seven-domain navigation — **Dashboard, Workflows, Schedules, Workers, Reviews, Storage, System** — with high-cardinality IDs never in the nav (reached via filtered lists / Cmd+K). Personas and per-surface priorities carry over: on-call owns Dashboard; SRE owns Workers/Schedules/Storage; developer owns Workflow Detail; non-developer reviewer owns Reviews; integrator owns System/Discovery.

The full per-screen specs, states, and flows from the source documents remain authoritative for content and behavior; this section records what changed and the per-surface API bindings. The **acceptance checklist in Appendix B** is the definition of done for the surface set.

#### 9.1 Dashboard

Three bands: critical alerts (diagnostic chips from `GET /api/v1/tasks/diagnostics`, reviews near timeout, lease health), aggregate cards (`GET /api/v1/workflows/aggregate?group_by=status|failureCategory` — "use aggregates for dashboard counts" per the API docs; worker fleet from `weft.workers.list`; schedule health from schedule list), and a **live** activity feed (`FleetEventSource`, `Feed`). Cards deep-link to pre-filtered lists. States: independent skeletons, onboarding empty state, full-page server-unreachable on health-probe failure.

#### 9.2 Workflows

- **List**: `DataTable` + `FacetedFilterBar` bound to the URL filter serializer; search-attribute query-builder rows (C4); Live toggle via fleet feed (status patches on visible rows, "+N new" for matching arrivals); bulk-selection bar → Tier-3 flow driven by the server's **dry-run/confirmation-token** protocol (preview count comes from the dry run). Start Workflow wizard (`Steps` + `SchemaForm` from `/api/v1/registry` `inputSchema`, advanced options, review step, 409 idempotency-conflict treatment with spent-key explanation).
- **Detail**: header (copyable ID, status incl. `finalizing` / `cancelled (finalizer failed)` sub-states, tags, deadline countdown; contextual actions per status × scope; Signal/Update/Query as three distinct labeled buttons with semantics tooltips). Tabs: **Overview** (`DescriptionList` + `PayloadInspector` for input/result/error; failure-category badge + plain-language explanation), **Timeline** (`RunStepTimeline` from `GET …/timeline`; branch/saga/finalizer rendering per C1; step expansion with per-attempt errors, heartbeat, retry policy; quick filters; step-range pagination past ~500 with jump-to-step), **Events** (`EventStreamViewer`, live tail, cursor-resumed), **Logs** (`ctx.log` in execution order with the replay re-emit note), **Checkpoints** (replay/fork actions — `GET …/checkpoints`, `GET …/replay/:step`, `POST …/fork`), **Signals** / **Updates** (history + send forms; update result long-polled via `GET /api/v1/updates/:updateId` with pending countdown), **Children** (child table; child lanes also visible in the timeline).
- **Aggregate view**: `group_by` selector (status/type/failureCategory/`attribute:<name>`), `BarChart` + group table → pre-filtered list. Guard the documented 100k-distinct-keys 422.
- **Async activity completion**: timeline step badged "Awaiting external completion" → `Drawer` with token display (plain, "not a secret" label) + complete/fail forms → `client.activity.complete/completeExceptionally`. Spent token → "This token has been used."
- **Lineage panel** (Overview tab): the run's full ancestry/descendants in one place — `forkedFrom` link, `start-new` replacement chains (a terminal run replaced under the same id via `onTerminalConflict: 'start-new'` links forward to its successor and back to its predecessor), schedule provenance (which schedule occurrence launched this run), and the child tree. Everything reachable in ≤1 click from any run in the lineage.
- **Event history export**: a Download button on the Events tab exporting the full event log (and timeline JSON) as a file — pure client-side over `GET …/events`, no upstream work. Import/offline-viewer is explicitly deferred (revisit post-v1 if support workflows demand it).
- **Replay/Fork**: distinct mental models at point of use (replay = read-only inspection, blue-bordered, orange banner; fork = new workflow with `forkedFrom` link); side-by-side divergence view (§7.3).

#### 9.3 Schedules

List (human-readable spec, next/last fire, missed count red >0, pause/resume/cancel/edit), Detail (spec with next-5-fires preview, **overlap policy with one-sentence consequence text** — the four-policy table from the source doc is retained verbatim, jitter, backfill, queued runs when overlap=queue, history of fired runs), Create/Edit `Drawer` (CronField (C3) / interval toggle, overlap radio with inline consequences, backfill warning, start-paused). API: `/api/v1/schedules` CRUD + `pause`/`resume`. `schedule:fired`/missed-fire events arrive on the fleet feed for liveness.

#### 9.4 Workers (RemoteWorkers surface)

- **Fleet overview**: `GET /api/v1/workers` → per-worker `id, queue, activities[], concurrency, inFlight, availableCapacity, connectedAt, lastHeartbeatAt, heartbeatAgeMs, health(active|draining|drained), deploymentName?, buildId?, gitSha?, runtimeVersion?` plus a `deployments[]` rollup and the server `routingPolicy`. Group by deployment (low cardinality); heartbeat staleness highlighted (relative color thresholds); worker connect/disconnect **live** via the fleet feed with polling fallback.
- **Worker list/detail**: dense table (In-Flight/Concurrency as `Meter`), drain (with reason) / resume per worker and per deployment (`POST/DELETE /api/v1/workers/:id/drain`, `/api/v1/worker-deployments/:name/drain` — scope `system:admin`).
- **Task queues**: `GET /api/v1/task-queues` → `backlog, oldestQueuedAgeMs, waitingPollers, schedulingPolicy, inFlight, connectedWorkers`; queue detail shows routing/scheduling strategy, workers on queue, diagnostics, dead-letter section (`DELETE /api/v1/tasks/diagnostics/dead-letter/:operationId`, Tier-3).
- **Diagnostics**: all five kinds (stuck-queued, stale-inflight, retry-storm, all-workers-at-capacity, dead-lettered) with the static guidance copy from the source doc retained verbatim.
- Surface the **reconnect grace period** nuance (`workerReconnectGracePeriodMs`, default 2s): a worker that drops and reconnects within the window keeps its in-flight tasks — the UI shows "reconnecting (grace period)" rather than flapping to disconnected.

#### 9.5 Reviews

Two-panel inbox (`ResizablePanels`): pending list (countdown red <20% remaining) + detail/decision surface. Artifact rendering by structure (string → text; Markdown → `@lostgradient/markdown/rendering`; `imageUrl`/`htmlContent` keys → media; else `PayloadInspector` with humanized keys). Evaluate `ApprovalCard` as the decision container first. Partial section decisions when `allowPartial`; overall decision suggested from sections but never locked. Completed archive read-only. `human-review:requested/completed` on the fleet feed drive inbox liveness + notifications. API: `GET /api/v1/reviews?status=…`, `POST /api/v1/reviews/:reviewId/decision`, per-workflow `GET …/review/:reviewId`. Must be fully usable without developer context and fully keyboard-operable.

#### 9.6 Storage

Two-panel KV browser (get / scan (NDJSON, prefix or start/end, paginated) / put / delete / batch / conditional-batch — the last shown only when `capabilities().conditionalBatch`). All routes HTTP-only, `storage:admin` + per-route scope. Reserved-prefix (`WEFT_RESERVED_KEY_PREFIXES`) warning banner + inline input warning. Tier-2 confirms on writes. Capabilities panel: `DescriptionList` with `persistence` badge (ephemeral=warning / local=info / remote=success) + durable-recovery checklist.

#### 9.7 System

- **Registry** (`GET /api/v1/registry`): workflow definitions with expandable readable `inputSchema` tree (`Tree`), signal/update/query handler names, activity definitions with retry policy; 3-step onboarding empty state.
- **Metrics**: dashboard view (`StatGroup` + `LineChart` sparklines from `GET /api/v1/metrics/json`, `system:read`) / raw view (`GET /v1/metrics` Prometheus text in `CodeBlock` + copy/download); ~15s refresh.
- **Discovery**: rendered OpenAPI / OpenRPC / AsyncAPI viewers (per-operation method/params/schemas/**required scope**, raw-JSON toggle) + MCP tab (`/.well-known/mcp.json` render, session-protocol sequence diagram (§7.3), interactive "Test MCP Session" panel showing full headers/body incl. `Mcp-Session-Id`/`Mcp-Session-Token` flow). Note `publicOrigin`/`trustedHosts` 503 behavior with an actionable message.
- **Operation catalog**: searchable table (name, scope, REST path, JSON-RPC method, MCP availability, transports) + `PermissionMatrix` scope-matrix toggle.
- **Health & lease**: lease status first (healthy / no-lease amber / **contested red banner also mirrored on Dashboard** with the split-brain warning copy), engine health, retention overview (`GET /api/v1/retention`), recover-all action (`POST /api/v1/recover`, Tier-2), codegen panel (renders `weft codegen`-equivalent output from `/api/v1/registry` in `CodeBlock`). Conformance is honest: `weft conformance` runs against a worker command from the CLI and has no server-trigger operation — the panel documents and links it, no fake "Run" button (the old plan's streaming-run panel is dropped).
- **Alerts & operational warnings**: live `alert:fired`/`alert:resolved`, `constraint:violated`, and checkpoint-size/development/cleanup/storage-size warnings from the fleet feed land in the notification center with severity tiers; a System sub-view lists ones observed this session. **Adopted (0.16.0)**: `weft.alerts.list` makes the "Active alerts" section authoritative and reload-safe; the session-scoped activity log below it keeps its "since page load" label because resolved/warning rows still only exist as live events (no history/ack operations upstream).
- **Scope panel**: granted/not-granted scopes with one-line descriptions and the UI actions each unlocks.

#### 9.8 Coverage Audit — Temporal UI Parity Check

A deliberate pass over what Temporal's Web UI offers, mapped to Weft. Items already in this plan are marked ✓; items added by this audit are **bold**; N/A items are recorded so nobody "discovers" them later.

| Temporal UI capability | Weft equivalent | Status |
|---|---|---|
| Workflow list + advanced visibility queries | List + `ListFilter`/attributes query builder | ✓ §9.2 |
| Workflow detail: event history, compact/grouped views | Events (`EventStreamViewer`) + Timeline (`RunStepTimeline`) | ✓ §9.2 |
| **Download event history (JSON)** | Client-side export over `GET …/events` + timeline JSON | **Added §9.2** (import/offline viewer deferred) |
| Pending activities + retry state | Timeline step expansion (attempts, heartbeat, retry policy) + async-pending badge | ✓ §9.2 |
| Terminate / cancel / request-cancel | Cancel, suspend/resume, force timeout (with finalizer sub-states) | ✓ §9.2 |
| Reset to event / continue-as-new chains | Replay (read-only) + Fork (`forkedFrom`) + **`start-new` replacement chains** | ✓ + **Lineage panel added §9.2** |
| Parent/child relationships | Children tab + timeline child lanes + **Lineage panel** | ✓ / **added** |
| Batch operations (with job progress) | Bulk ops with server dry-run/confirmation-token + progress modal (synchronous — no async batch-job list needed) | ✓ §9.2/§13 P8 |
| Schedules (spec, overlap, backfill, recent runs) | Schedules domain | ✓ §9.3 |
| Task queues / worker pollers | Queues + workers + diagnostics | ✓ §9.4 |
| Worker versioning / deployments (build ids) | Deployment groups (buildId, gitSha, runtime) + drain/resume | ✓ §9.4 |
| Search attributes (custom) | Attributes read/write + query builder | ✓ §9.2 |
| Namespaces | **N/A** — multi-tenancy removed from Weft core; one engine per durable store. Recorded as a non-goal. | N/A |
| Codec server (payload encryption/decoding) | **N/A** — custom serializers decode by durable tag engine-side; payloads reach the UI as JSON. `ctx.offload` payloads shown by reference. | N/A |
| Live stack-trace query (`__stack_trace`) | No built-in equivalent; `ctx.onQuery` handlers are user-defined. Not planned; would be an upstream engine feature first. | Non-goal v1 |
| Archival browsing | History archival is best-effort post-deletion, not a durability surface; Retention overview covers policy. | ✓ (retention) §9.7 |
| Cluster/system health | Health & lease + metrics + registry | ✓ §9.7 |

#### 9.9 Adopted from `temporal-explorer`

`~/Developer/temporal-explorer` (Svelte 5 + Cinder + `@xyflow/svelte` + `elkjs`) was audited for reusable visualization work. It is an offline, artifact-driven analysis tool — no realtime code exists in it, and its static AST control-flow reconstruction has no Weft analogue — so nothing is imported wholesale. Four pieces are adopted:

1. **Runtime-state derivation pattern** (`apps/explorer/src/lib/graph/runtime-state.ts`) — a small closed UI-state enum + explicit priority order (`failed` > `timedOut` > `canceled` > `pending` > `retried`) + fallback state for unmapped observations, driving styling via a `data-state` attribute token. Adopt the _pattern_ (rewritten for Weft's step/status vocabulary) as the timeline/step state-mapping module in T3.1 — it replaces an if/else pile with a testable pure function.
2. **Linked-selection interaction** (graph ↔ timeline ↔ inspector in `workflow-flow-panel` / `workflow-timeline-panel` / `workflow-selection-inspector`) — selecting a timeline step highlights/filters the corresponding Events and Logs entries (and vice versa), with a shared selection store. Added to the Timeline/Events/Logs spec (T3.1) — this is the single best debugging-ergonomics idea in the tool.
3. **Hot-path / rare-branch cross-run classification** (`packages/mapper/src/aggregate.ts`) — classify steps by observation frequency across N runs of a workflow type (hot path = 100%, rare branch = ≤50%), plus per-activity retry/failure aggregates. **Post-v1 candidate** for a Registry-level "workflow type analytics" view; recorded here so it isn't reinvented.
4. **ELK nested-DAG layout technique** (`apps/explorer/src/lib/graph/layout.ts` — `INCLUDE_CHILDREN` hierarchy, `DEPTH_FIRST` cycle-breaking so loop-back edges stay backward, edge-label sizing, container header padding) + the proven Svelte Flow node-shape approach. **Post-v1 candidate**: an optional "Graph" toggle on the Timeline tab rendering the run's step/coordination tree as a nested DAG — explicitly out of v1 scope (C1 branch cards in `RunStepTimeline` are the v1 answer, and they're the right density for operator debugging), but if/when a graph view is wanted, temporal-explorer is the reference implementation on the exact same stack, and this also answers Cinder's "no DAG component" gap without committing Cinder to owning one prematurely.

One portability caveat verified: temporal-explorer's retry-attempt collapsing (reading the honest attempt count from `ActivityTaskStarted.attempt`) solves a Temporal history quirk; Weft's `GET …/timeline` serves step/attempt data server-side, so that logic is _not_ needed — T3.1 should trust the server timeline rather than re-deriving attempts client-side.

Weft-native features with **no Temporal analogue**, audited for coverage: human reviews ✓ (§9.5) · storage KV browser ✓ (§9.6) · MCP discovery/session ✓ (§9.7) · `ctx.stream` token streams ✓ (stream viewer, §9.2/§5) · **alerts/constraints/operational warnings** (**added §9.7**, upstream op needed for authoritative active-list) · **budgets** (`budget:read`/`budget:write` scopes exist but **zero operations are wired** — upstream decision required: implement budget operations or drop the scopes (§14.1); the console adds a Budgets surface only when operations exist — nothing to build against today) · schedules jitter/overlap/queued-runs ✓ (§9.3) · idempotent starts + spent-key semantics ✓ (§9.2) · durable finalizers ✓ (§10.1) · version tuple display ✓ (source-doc §6.11 rules carried forward).

---

### 10. Cross-Cutting Patterns

1. **Status badge system**: §2-token semantics (green running/healthy; blue/slate pending/info; amber suspended/draining/finalizing/needs-changes; red failed/timed-out/rejected/contested/dead-letter; gray terminal/paused/drained) mapped onto Cinder `StatusDot`/`Badge` tones; color always paired with icon/text. Special states: `Finalizing` (amber, tooltip explains post-cancellation cleanup) and `Cancelled — Cleanup Failed` (red, links to the finalizer error).
2. **Payload editor** (Start/Signal/Update/Query/Fork/Schedule/Storage-put): `SchemaForm` form mode ↔ CodeMirror JSON mode via lossless `SegmentedControl` toggle; extra fields not in schema surface as a raw-JSON tail section; validation inline per field + error summary above submit; >100 KB payload warning suggesting `ctx.offload()`.
3. **Search-attribute query builder**: condition rows (key typeahead from observed attributes + free text, operator limited to eq/gt/lt/gte/lte, type-aware value input with manual type override), AND-only, raw-JSON toggle, serialized into the URL. No phantom OR/LIKE.
4. **Fault presentation** (one `FaultDisplay` treatment, six codes): NotFound → inline within surface; Conflict → inline warning with conflicting resource linked (idempotency spent-key copy per §9.2); Invalid → field-level form errors; Unauthorized → full-page auth-required or inline scope error; NotSupported → inline "not supported in current configuration"; Internal → toast + request id, with the REST-masked-500 explanation and a "try via JSON-RPC" affordance on admin surfaces. JSON-RPC faults show `message` + details.
5. **Live indicator**: ConnectionIndicator states connected/reconnecting(+attempt)/polling("updated every Ns")/disconnected(+Refresh); new rows highlight briefly; "+N events" pause-to-read.
6. **Confirmation tiers**: Tier 1 inline confirm (reversible); Tier 2 modal explaining loss (cancel/purge/storage-write/recover-all); Tier 3 type-to-confirm (`AlertDialog`) driven by the server dry-run count, plus non-dismissible bulk progress with the "cancelling tracking ≠ cancelling the server op" note.
7. **Empty states**: every one names a concrete next step (SDK snippet for workflows/workers, Create CTA for schedules, "all caught up" positive state for reviews, 3-step onboarding for registry).
8. **High-cardinality IDs**: truncate `first8…last4` monospace, hover full value, one-click copy + toast; never as nav/breadcrumb text.
9. **Accessibility**: keyboard path for everything; review surface fully AT-operable; `role=status`/`role=alert` severity mapping for toasts; Cinder's a11y contracts respected (icon-only buttons get `aria-label`); axe checks in CI.
10. **Copy voice**: Cinder content rules — sentence case everywhere, imperative labels, `…` and `·`, no emoji, specific numbers over reassurance.

---

### 11. Testing Strategy

Layered, mirroring what already works in `cinder` and `weft`:

1. **Pure logic (bun test, no DOM)** — `src/lib/**`: filter serializer round-trips (property-style over generated filters), scope gating truth table, fault mapping, LiveSource reducers (`applyFrame`), cursor/resume logic, formatters (id truncation, durations, cron preview). TDD; these carry the correctness load.
2. **Component tests (bun test + happy-dom + `@testing-library/svelte`)** — run with `--conditions browser --conditions svelte` exactly as cinder does. Cover: payload editor mode-switch losslessness; query-builder row add/remove/serialize; confirmation-tier gating (type-to-confirm disabled-until-match); scope-disabled tooltips; timeline step expansion; live-indicator state rendering; empty/loading/fault states per surface.
3. **Integration tests against a real server (bun test)** — weft is a dependency: boot `Engine.create()` + `serve({ engine, port: 0 })` with MemoryStorage and registered fixture workflows in-process, point a real `HttpClient` (and the SPA data layer) at it. Cover: list/filter/paginate against real data; start wizard → running workflow; signal/update round-trips; tail catch-up-then-live with forced reconnect (no dup/skip); fleet SSE delivery of review/schedule/worker events; bulk dry-run → confirm token flow; auth modes (`unauthenticatedAccess` warn/reject, scoped API keys); fault shapes (REST masked 500 vs JSON-RPC fault object). **No mock server, no fixture drift.**
4. **E2E (Playwright, `@axe-core/playwright`)** — the critical persona flows only: debug-a-failed-workflow (list → detail → timeline → replay → fork), approve-a-review-with-partial-sections, bulk-retry-with-type-to-confirm, create-and-backfill-schedule, drain-a-deployment. Each flow also asserts zero serious/critical axe violations. Runs against a seeded real server. Follow the weft repo's `waitFor`-not-fixed-sleep convention; no timeout bumps to make things pass.
5. **Mount/deployment tests** — `weftUi()` returns a valid `DashboardRouteTarget`; a booted `serve({ dashboard })` serves the shell at all five routes and never shadows `/api/*` or root discovery routes; SW-mode integration test proving `handleRequest`-backed fetch + streaming SSE through a Service Worker context (fake-indexeddb + a SW test harness); config-injection test that the same bundle boots in all three modes.
6. **Type-level tests** (`.test-d.ts`) — `weftUi()` satisfies `DashboardRouteTarget` against the published `@lostgradient/weft/server` types; `client.operations` call-site inference for every operation the console uses.
7. **Budgets & gates in CI** — bundle-size budget script (entry <15 KB gz; per-route <60 KB; CodeMirror chunk lazy, <150 KB), coverage gate (100% adjusted with an explicit reviewed allowance file, weft-style), lint/typecheck/format, and the Cinder styles-guard active in dev builds.

Fixtures: a `fixtures/workflows.ts` module defining deterministic demo workflows exercising every visual state — retries, race/all/speculate branches, saga compensation, finalizers, human reviews (partial + timeout), long histories (>500 steps), async activities, child trees, every failure category. Used by integration tests, Playwright seeds, and the dev server, so "does the timeline render a saga" is one command away everywhere.

---

### 12. Performance and Accessibility Budgets

- Bundle (gzip): entry <15 KB; dashboard <30; workflow list <40; workflow detail <60; CodeMirror chunk lazy <150. CI check with hard fail.
- Lists ≤100 rows render without virtualization; event/log streams always through `EventStreamViewer`/`VirtualList`.
- Aggregates group only bounded dimensions; IDs never as chart labels.
- JSON payloads: `PayloadInspector` caps + truncation metadata handle the small/large split natively; parse >1 MB payloads off-main-thread (Web Worker) before display; offloaded payloads shown by reference with fetch-on-demand.
- Event batching ≤100ms frames; background tabs suspend polling and pause non-critical SSE handling.
- Accessibility: WCAG AA via Cinder's baked-in contracts + the §10.9 rules; axe assertions in every Playwright flow; `prefers-reduced-motion` respected (Cinder collapses motion to 0ms).

---

### 13. Execution Plan — Phases, Tracks, and Fan-Out

Rules of engagement for every task: one task = one worktree = one PR into `weft-ui` `main` (or the named upstream repo); TDD; full validation suite before PR; PR monitored to the three-condition close (CI green, review threads resolved, no conflicts). Each phase ends with its **gate** passing.

#### 13.0 Parallel Execution Map (read This before Dispatching agents)

The plan is structured so that after two serialization points — the **Phase 0 gate** (repo exists, builds, mounts) and the **Phase 1 gate** (foundation contracts frozen) — everything fans out. Dispatch each track as its own subagent/worktree; tracks own disjoint paths, so merges are mechanical.

| Track | Phases/Tasks | Owned paths (exclusive) | Blocked by | Repo |
|---|---|---|---|---|
| **F** Foundation | Phase 1 (T1.1–T1.6) | `src/lib/**`, `src/app/**` | Phase 0 gate | weft-ui |
| **A** Workflows core | Phase 2 → Phase 3 (sequential within track) | `src/routes/workflows/**` | Phase 1 gate | weft-ui |
| **B** Schedules | Phase 4 | `src/routes/schedules/**` | Phase 1 gate | weft-ui |
| **C** Workers/queues/diagnostics | Phase 5 | `src/routes/workers/**`, `src/routes/dashboard/**` (alert chips + aggregate cards) | Phase 1 gate | weft-ui |
| **D** Reviews | Phase 6 | `src/routes/reviews/**` | Phase 1 gate | weft-ui |
| **E** Storage + System | Phase 7 | `src/routes/storage/**`, `src/routes/system/**` | Phase 1 gate | weft-ui |
| **G** Bulk/destructive hardening | Phase 8 | list bulk-bar + tier sweep (touches A/C surfaces — run after their gates) | A gate, C gate | weft-ui |
| **H** Deployment modes + hardening | Phase 9 | `tests/**` (SW/CORS harnesses), `scripts/**` (budgets) | A gate (needs one real surface to exercise) | weft-ui |
| **U1** Cinder upstream | C1 `RunStepTimeline` branches, C2 `ConnectionIndicator`, C3 `ScheduleBuilder`, C4 rule-builder conditions mode | per-component dirs in `cinder` | none — start at Phase 0 | cinder |
| **U2** Weft upstream | route extension, `--console` CLI, alert list/ack ops, budget ops-or-drop, SW SSE verification, principal op | `weft` | none — start at Phase 0 | weft |

Fan-out shape: **Phase 0 (1 agent) → Phase 1 (F, with U1/U2 already running) → A+B+C+D+E in parallel (5 agents) → G+H → Phase 10.** Within Phase 1, T1.1–T1.5 are five parallelizable modules with T1.6 (shell) integrating them.

Coordination rules that make the fan-out safe:
- **Foundation freeze**: after the Phase 1 gate, `src/lib/**` interfaces (`LiveSource`, filter serializer, `hasScope`, fault mapping, client provisioning) are frozen for tracks A–E; a track needing a foundation change files it as a small standalone PR first (never buried inside a surface PR) so other tracks rebase once.
- **Shared fixtures are append-only**: `fixtures/workflows.ts` additions never mutate existing fixtures other tracks assert against.
- **Cross-track pages**: the Dashboard composes cards owned by A/B/C/D — each track ships its card behind the shell's card-slot contract (defined in T1.6) so Dashboard assembly never serializes the tracks.
- **Upstream adoption is a bump, not a blocker**: every track consuming a U1 component ships its Cinder-fallback first; adopting the landed upstream component is a follow-up task per track (the plan's degraded-but-correct rule).
- Tracks report a **gate checklist** (their slice of Appendix B) in the final PR of the track.

#### Phase 0 — Repositories, Scaffold, upstream Tickets

- **T0.1** Create `weft-ui` repo: Bun + Svelte 5 + Cinder wiring (base styles; component entrypoints load their own CSS), lint (oxlint)/format (prettier + organize-imports)/typecheck/bun-test CI, kebab-case + file-size conventions, pre-commit hooks mirroring weft's.
- **T0.2** Build pipeline: Svelte compile + `bun build --splitting`, hashed assets, `weftUi()` mount export + type test against `DashboardRouteTarget`, mount smoke test (serve at five routes, no API shadowing). Decide bun-plugin-svelte vs Vite here and record the decision in the README.
- **T0.3** Dev harness: `bun run dev` boots a seeded local weft server (fixtures module) + the console dev server with proxy and **full HMR**; document `WEFT_API_BASE_URL`. HMR acceptance tests (manual checklist in the PR + a scripted smoke where feasible): (1) edit a `.svelte` component → updates in place, no full reload, sibling component state survives; (2) edit component CSS → styles hot-apply; (3) edit a `LiveSource` module while a tail is open → old connection closes, exactly one new connection opens (assert via the weft server's connection count); (4) syntax error → overlay, then recovers on fix without manual reload.
- **T0.4** File upstream tickets: cinder C1–C4 (§7.2, with specs); weft — `DASHBOARD_PAGE_ROUTES` extension (`/schedules`, `/storage`, `/system`), `weft serve --console` CLI mount, SW streaming-SSE verification if needed (§14).
- **Gate**: `serve({ engine, dashboard: weftUi() })` renders a hello-shell at all five routes; `bun run dev` passes the T0.3 HMR acceptance checklist; CI green.

#### Phase 1 — Foundation Layer (the Load-bearing plain-TS modules)

- **T1.1** Runtime config + `HttpClient` provisioning (`src/lib/client.ts`), config-injection contract, API-key entry surface for `reject` mode.
- **T1.2** Principal + scopes (`src/lib/scopes.ts`): resolve principal op (pin exact catalog name in a test), `hasScope`, unauthenticated-mode banner logic.
- **T1.3** Router + URL state: history router under owned prefixes; filter serializer with property-tested round-trips.
- **T1.4** `LiveSource` suite: `WorkflowTailSource`, `FleetEventSource`, `PollingSource` + TanStack cache integration; integration tests for catch-up/live/reconnect/no-dup-no-skip; connection budget enforcement.
- **T1.5** Fault mapping + `<svelte:boundary>` route boundaries + toast wiring.
- **T1.6** App shell: sidebar (7 domains), header, CommandPalette skeleton (ID-prefix search across workflows/schedules/workers/reviews), notification center fed by `FleetEventSource`, engine-status pill, scope badge, auth-mode banner. ConnectionIndicator verify-or-add (C2) resolves here.
- **Gate**: shell navigates all domains against the dev harness; live notification arrives end-to-end (fixture review request → bell + toast); foundation modules at 100% coverage.

#### Phase 2 — Workflows List, Start, and Detail Core

- **T2.1** Workflow list: DataTable + FacetedFilterBar + URL filters + pagination + live row patches; empty/loading/denied states.
- **T2.2** Search-attribute query builder (C4 or fallback composition).
- **T2.3** Start Workflow wizard: Steps + SchemaForm from registry `inputSchema` + raw-JSON mode + advanced options + 409 spent-key treatment.
- **T2.4** Detail header + Overview tab (PayloadInspector, failure-category explanations, contextual actions incl. cancel/suspend/resume/timeout with Tier-1/2 confirms).
- **T2.5** Events + Logs tabs (`EventStreamViewer`, live tail, cursor resume, execution-order logs with re-emit note).
- **T2.6** Signals / Updates / Children tabs (send forms with payload editor; update long-poll pending state).
- **T2.7** Lineage panel (forkedFrom / start-new chains / schedule provenance / child tree) + event-history export (Events tab download).
- **Gate**: Playwright flow "find failed workflow → read error → send signal → watch it resume live" passes with axe clean.

#### Phase 3 — Timeline, Debugging, Async Activities

- **T3.1** Timeline tab on `RunStepTimeline` (data mapping from `GET …/timeline`, step expansion, quick filters, step-range pagination + jump-to-step, finalizer section). State mapping uses the priority-ordered pure-function pattern from §9.9(1); step selection is linked to Events/Logs entries via a shared selection store per §9.9(2).
- **T3.2** Coordination rendering: adopt C1 when landed (flat-group fallback first — ship degraded, upgrade on the Cinder bump).
- **T3.3** Checkpoints tab + Replay (read-only view + banner) + Fork dialog + side-by-side divergence view (§7.3).
- **T3.4** Async activity completion drawer (token display, complete/fail, spent-token state).
- **Gate**: fixture workflows for race/all/speculate/saga/finalizer all render correctly; replay/fork Playwright flow passes.

#### Phase 4 — Schedules

- **T4.1** List + Detail (overlap consequence text, queued runs, missed-fire surfacing, history).
- **T4.2** Create/Edit drawer (CronField C3 or fallback, next-5-fires preview, backfill warning flow).
- **Gate**: create-and-backfill Playwright flow; `schedule:fired` events live-update the detail.

#### Phase 5 — Workers, Queues, Diagnostics

- **T5.1** Fleet overview (deployment groups, heartbeat staleness, live connect/disconnect, reconnect-grace state).
- **T5.2** Worker list/detail + drain/resume (worker + deployment) with reason capture.
- **T5.3** Task queues + queue detail + dead-letter clear (Tier 3).
- **T5.4** Diagnostics view (five kinds + guidance copy) + dashboard alert chips.
- **T5.5** Workflow aggregate view (group-by + BarChart + drill-through; decide C5 here).
- **Gate**: stuck-queued incident-response Playwright flow (diagnostic chip → queue → resume deployment → diagnostic clears).

#### Phase 6 — Reviews

- **T6.1** Inbox + decision surface (ApprovalCard evaluation documented; partial sections; countdown; artifact rendering matrix).
- **T6.2** Completed archive + timeout-expired handling + live inbox updates/notifications.
- **Gate**: partial-decision Playwright flow keyboard-only, axe clean (the AT-critical surface).

#### Phase 7 — Storage and System

- **T7.1** Storage KV browser + capabilities panel + reserved-prefix guards.
- **T7.2** Registry + Metrics.
- **T7.3** Discovery (OpenAPI/OpenRPC/AsyncAPI render, MCP tab + sequence diagram + test-session panel).
- **T7.4** Operation catalog + PermissionMatrix + scope panel.
- **T7.5** Health & lease (contested-lease dashboard mirror, retention, recover-all, codegen panel, conformance doc-link panel).
- **T7.6** Alerts & operational-warnings view (authoritative "Active alerts" from `weft.alerts.list` as of 0.16.0; session-scoped activity log below it for resolved/warning history).
- **Gate**: Appendix B System/Storage boxes all demo-able against the dev harness.

#### Phase 8 — Bulk Operations and Destructive-action Hardening

- **T8.1** Bulk selection bar + "select all matching filter" escalation + server dry-run/confirmation-token integration + progress modal.
- **T8.2** Sweep every destructive action to its correct tier (purge, delete, clear dead-letter, cancel-running overlap, recover-all); `preferRpc` fault-detail routing for admin ops.
- **Gate**: bulk-retry-47 Playwright flow; tier audit checklist in the PR description.

#### Phase 9 — Service Worker Mode, Cross-origin, Hardening

- **T9.1** SW deployment mode: host-page recipe, config injection, SSE-only transport verification through a real SW test harness; docs.
- **T9.2** Cross-origin mode docs + CORS integration test against weft's `cors` option.
- **T9.3** Performance pass: bundle budgets enforced in CI, Web-Worker JSON parsing, background-tab suspension.
- **T9.4** Accessibility pass: full axe sweep, keyboard audit, reduced-motion verification.
- **Gate**: same bundle boots in Bun-mount, standalone, and SW modes in CI.

#### Phase 10 — Release

- **T10.1** README + deployment guide (three modes, auth caveat, scope requirements per surface).
- **T10.2** Publish `@lostgradient/weft-ui` 0.1.0 (changesets or weft-style release flow); upstream weft docs PR pointing `serve({ dashboard })` documentation at the package; close/land the `weft serve --console` issue when appropriate.
- **Gate**: fresh-clone quickstart (`bun add … && serve({ dashboard: weftUi() })`) works as documented.

**Dependency notes**: see the §13.0 map — it is the authoritative fan-out contract. Phase 3 depends on Phase 2's detail scaffold (T2.4) and therefore lives inside track A rather than as a separate parallel track; Phase 8 (track G) waits on tracks A and C; upstream tracks U1/U2 start at Phase 0 and never block console tracks (fallback-first rule).

---

### 14. Upstream Work Queue

#### 14.1 `stevekinney/weft`

> **Adoption status (weft 0.16.0, adopted 2026-08-10).** Items 1, 2, 5, and 6 shipped in
> `@lostgradient/weft@0.16.0` (weft#841, #842, #843, #844) alongside `ServeOptions.dashboardAssets`
> (weft#840) and `setupServiceWorker({ handlerOptions })` (weft#845); the console adopted all six —
> see `tests/deployment/bun-mount.test.ts`, `tests/deployment/service-worker.test.ts`,
> `src/routes/system/alerts-tab.svelte`, and the README's rewritten deployment section. Item 3 was
> resolved earlier by testing (`handleRequest` streams; the gap was options passthrough, closed by
> #845). Item 4 (principal introspection) shipped in 0.18.0 and is adopted, closing the queue: `weft.system.principal` plus a public `AUTHORIZATION_SCOPES` export (weft#887). The only item still open upstream is an alert acknowledge/history operation, which weft documents as deliberately absent — its alert-manager model has no acknowledged state distinct from resolved.

1. **Extend `DASHBOARD_PAGE_ROUTES`** with `/schedules`, `/storage`, `/system` (leaf prefixes; no `/api` shadow risk by construction). Includes tests + `component-standards` skill/doc updates. *Shipped in 0.16.0; adopted.*
2. **`weft serve --console`**: optional-peer resolution of `@lostgradient/weft-ui` with an actionable install error. *Shipped in 0.16.0; documented in the README.*
3. **Verify `handleRequest` streams SSE responses** in a Service Worker context (needed for §3.3); file a bug with repro if it buffers. *Verified — it streams; the real gap (no `HandlerOptions` passthrough) shipped as `setupServiceWorker({ handlerOptions })` in 0.16.0 and is adopted.*
4. Confirm/expose a **principal introspection operation** (scopes for the current credential) if the catalog doesn't already include one (T1.2 pins this). *Shipped in 0.18.0 as `weft.system.principal` (`GET /v1/principal`, `access: 'public'`) alongside a public `AUTHORIZATION_SCOPES` export; adopted — `resolvePrincipal()` now reports the server's real scope set instead of optimistically granting all 21, the T1.2 pin is inverted to assert the operation exists, and `scopes.svelte.integration.test.ts` proves the three-way boot contract against real `serve()` instances.*
5. **Alert operations**: `alert:fired`/`alert:resolved` events reach the fleet feed, but the alert-manager has no list/acknowledge operations — a reload-safe "active alerts" console view needs `weft.alerts.list` (and optionally ack). *`weft.alerts.list` shipped in 0.16.0 (`GET /v1/alerts`, `system:read`); adopted — the Alerts tab's active list is authoritative, the session log remains for resolved/warning history. No acknowledge operation exists yet.*
6. **Budget scopes decision**: `budget:read`/`budget:write` are declared in `AUTHORIZATION_SCOPES` but no operation uses them. *Resolved in 0.16.0: the scopes were dropped; the console's vocabulary is now 21 scopes and the catalog entries are removed.*

#### 14.2 `stevekinney/cinder`

C1 branch/coordination groups in `RunStepTimeline` · C2 `ConnectionIndicator` (confirmed absent) · C3 `ScheduleBuilder` (presets ↔ cron ↔ interval composite, §7.2) · C4 conditions-only mode for `InvocationRuleBuilder` · C5 donut/segment chart (optional, decide Phase 5). Each ships with Cinder's full artifact set (README, a11y.md, schema, variables, tests, examples) and lands via Cinder's changeset flow.

---

### Appendix A — API Quick Reference (verified 2026-07-09; mount/auth/SW/alerts rows re-verified against 0.16.0 on 2026-08-10)

- **Mount**: `ServeOptions.dashboard?: DashboardRouteTarget` + `dashboardAssets?: DashboardAssets` (`{ prefix, directory }`, 0.16.0); `DASHBOARD_PAGE_ROUTES = ['/', '/workflows', '/workflows/*', '/reviews', '/workers', '/schedules', '/storage', '/system']` (0.16.0); shell served pre-auth; API under `/api`; root-stable: `/v1/health`, `/v1/metrics`, `/openapi.json`, `/openrpc.json`, `/asyncapi.json`, `/.well-known/{api-catalog,mcp.json}`.
- **Workflows**: `POST/GET /api/v1/workflows`, `GET /api/v1/workflows/aggregate`, `POST …/start-or-signal`, per-id `GET`/`DELETE`(cancel)/`suspend`/`resume`/`timeout`/`fork`/`result`(long-poll)/`attributes`/`events`/`timeline`/`checkpoints(/:step)`/`replay/:step`/`streams/:key`/`signal/:name`/`query/:name`/`update/:name`; `GET /api/v1/updates/:updateId`; bulk `cancel`/`signal`/`retry-failed`/`DELETE bulk`/`PATCH bulk/tags`/`purge` (admin, dry-run/confirm-token).
- **Reviews**: `GET /api/v1/reviews`, `POST /api/v1/reviews/:reviewId/decision`.
- **Schedules**: CRUD + `pause`/`resume` under `/api/v1/schedules`.
- **Activities**: `POST /api/v1/activities/{complete,fail}` (public ops; token in body, single-use, deterministic).
- **Workers/queues**: `GET /api/v1/workers`, drain/resume worker + deployment, `GET /api/v1/task-queues`, `GET /api/v1/tasks/diagnostics`, `DELETE …/dead-letter/:operationId`.
- **System**: `GET /api/v1/registry`, `GET /api/v1/retention`, `GET /api/v1/metrics/json`, `POST /api/v1/recover`; storage KV under `/api/v1/storage`.
- **Realtime**: WS `/api/v1/workflows/:id/watch` (`events:read`) / `…/stream` (`streams:read`) with `?resumeFrom=`; SSE `GET /api/v1/workflows/:id/events/sse` (`selector=events|tokens`, `fromCursor`, `Last-Event-ID`), fleet `GET /api/v1/events/sse` (`events:read`; `workflowId`/`kind` filters); JSON-RPC WS `weft.workflows.subscribe` / `weft.events.subscribe` → `weft.events.deliver`. Replay caps 1,000 events / 1,000 buffered frames → close `1008`; per-workflow connection cap default 100 (WS `1008` / SSE `429`); `ping` keepalives carry no cursor; `replayComplete: true` marks catch-up done.
- **Client**: `HttpClient({ baseUrl, headers?, token?, eventTransport?, webSocketFactory? })` — full `WeftClient` + `operations`/`call` + `activity` + `tail`; resolution order explicit options → `WEFT_ADDR`/`WEFT_TOKEN` → `~/.weft/config` → `http://localhost:7233`.
- **Auth**: `AuthConfig` (apiKeys/jwt/mtls/publicPaths/resolveApiKeyPrincipal/defaultApiKeyScopes/auditSink); 21 flat scopes (0.16.0 dropped `budget:read`/`budget:write`), publicly exported as `AUTHORIZATION_SCOPES` from `@lostgradient/weft/server` since 0.18.0; `unauthenticatedAccess: 'warn'|'allow'|'reject'`; CORS opt-in, wildcard+credentials rejected at boot; `publicOrigin`/`trustedHosts` required for absolute-URL discovery in production (else 503).
- **Service Worker**: `setupServiceWorker({ pathPrefix: '/weft/', handlerOptions?, … })` → `handleRequest(request, engine, handlerOptions)`; `handlerOptions` (0.16.0) carries `authContext`/`workflowEventFeed`/`fleetEventFeed`/`acquireWorkflowStreamConnection`; storage `resolveDefaultStorage()` → IndexedDB in browsers.
- **Principal**: `weft.system.principal` (`GET /v1/principal`, `access: 'public'`, 0.18.0) → `{ method, subject, scopes }`; `method` is `'unauthenticated'` for an anonymous caller, and an auth-configured server 401s a credential-less request even here.
- **Alerts**: `weft.alerts.list` (`GET /v1/alerts`, `system:read`, 0.16.0) → `{ items: ActiveAlert[] }` (`metric`, `threshold`, `currentValue`, `window`, `firedAt`); no acknowledge/history operations.
- **Faults**: NotFound 404 / Conflict 409 / Invalid 400 / Unauthorized 401·403 / NotSupported 501 / Internal 500; REST masks internal as `{ error: "Internal server error" }`, JSON-RPC returns the full fault object.

### Appendix B — Acceptance Checklist (definition of "complete")

Carried from the wireframe brief, updated to current component truth. Every box maps to a shipped, tested surface/state; the phase gates in §13 reference these.

**Global**: app shell (7 domains, collapsed mobile nav) · Cmd+K overlay · alert strip + notification center · scope badge + disabled-with-tooltip example · engine status pill (healthy/no-lease/contested) · unauthenticated-mode banner.

**Patterns**: status badge set (incl. finalizing + finalizer-failed) · payload editor form + JSON modes · query builder (visual + raw) · confirmation Tiers 1/2/3 + bulk progress · fault display (six treatments) · empty states (workflows/schedules/workers/reviews/storage/registry) · live indicator states (connected/reconnecting/polling/disconnected).

**Screens**: Dashboard (default/loading/empty/unreachable) · Workflow list (default/bulk-selection/empty×2/denied) · Workflow detail — Overview (running + failed), Lineage panel (fork/start-new/schedule/children), Timeline (coordination + saga + finalizer), Events (live, with history export), Logs, Checkpoints, Signals, Updates (pending), Children, not-found · Aggregate view · Start wizard (+409) · Replay confirm + read-only view · Fork dialog + success · Async completion panel · Schedule list (missed>0) / detail (overlap text, queued runs) / create-edit (cron preview, backfill warning) · Workers fleet (deployment groups, stale heartbeat) / list / detail (draining) · Task queues / queue detail (dead-letter clear) / diagnostics (five kinds + guidance) · Review inbox + decision (partial sections) / completed / timeout-expired / archive · Storage KV (get/scan/put-confirm/reserved-prefix) + capabilities · Registry (schema tree) · Metrics (dashboard + raw) · Discovery (OpenAPI/OpenRPC/AsyncAPI/MCP + sequence diagram + test panel) · Operation catalog (+ matrix) · Health & lease (three states) + codegen + retention + conformance doc panel · Alerts & operational warnings (authoritative active list + session activity log) · Scope panel.

**Cross-cutting rules**: color never alone · IDs truncated + copyable, never nav labels · missing scopes disable-with-reason, never hide · every empty state names a next step · dense theme, Dashboard the clarity exception · reviewer screens legible without JSON knowledge · destructive actions on the correct tier · Cinder components only outside the §7.3 net-new list · Cinder tokens + `data-theme`, status via StatusDot/Badge tones.
