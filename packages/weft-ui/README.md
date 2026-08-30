# Weft Console

Operator console for the [Weft](https://github.com/stevekinney/weft) durable-workflow engine —
Svelte 5 + [Cinder](https://github.com/stevekinney/cinder). See
[`docs/implementation-plan.md`](docs/implementation-plan.md) for the full plan and
[`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) for the agent-facing ground rules.

## Quickstart

```bash
bun install

# Terminal 1: a seeded local weft server on :7233 (fixture workflows from fixtures/workflows.ts)
bun run dev:server

# Terminal 2: the Vite dev server on :5173, proxying /api, /v1, and discovery routes to :7233
bun run dev
```

Open <http://localhost:5173>.

`scripts/dev-server.ts` boots a real, unwrapped `serve()` from `@lostgradient/weft/server` — no
hand-rolled `Bun.serve()`, no `handleRequest()` workaround, no manual `/api`-prefix stripping, no
reimplemented event feed. WebSocket upgrades, the per-workflow SSE/WS tail, and JSON-RPC over HTTP
(`/jsonrpc`) all work against `bun run dev:server` as a result. (An earlier `@lostgradient/weft@0.11.0`
bug made that impossible — `serve({ engine })` threw for any root-imported `Engine`
(https://github.com/stevekinney/weft/issues/710); fixed upstream in the historical `0.12.0` release
(#716). This package now pins `0.18.0`; see `scripts/dev-server.ts`'s module doc if you need the full
history.) The
production mount path this package exists for — `serve({ dashboard: weftConsole() })` — is
runtime-verified the same way: a real `serve({ engine, dashboard: weftConsole() })` instance returns
the built shell (`index.html` with its `weft-console-config` block) at `200`.

**A real dev harness needs a real credential, not `unauthenticatedAccess`** — and now has one.
`unauthenticatedAccess` only controls whether `serve()` refuses to _start_ with no `auth`
configured; it has no per-request effect once running, so a credential-less request always resolves
to a zero-scope anonymous principal and every `access: 'scoped'`/`'authenticated'` operation
(schedules, reviews, storage, system/registry, …) correctly 401s.

That was survivable while `src/lib/scopes.svelte.ts` optimistically granted every scope and degraded
on observed `403`s. As of the weft 0.18.0 adoption it no longer does: `resolvePrincipal()` calls
`weft.system.principal` and reports the server's real answer, so an unauthenticated dev server would
render every scope-gated control disabled-with-reason — truthful, but useless for building those
surfaces. So `bun run dev:server` now configures `auth` with a fixed, localhost-only dev key
(`scripts/dev-credentials.ts`) and the Vite dev proxy attaches it to every proxied request and
WebSocket upgrade. The frozen `index.html`/`client.ts` runtime-config contract is untouched and
`vite build` never reaches that code, so no token can reach a build artifact. Net effect: scoped
surfaces work in the dev harness now, where they previously 401'd.

## Scripts

| Script                 | What it does                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`          | Vite dev server with full HMR.                                                                                                            |
| `bun run dev:server`   | Boots a seeded local `weft` server (`scripts/dev-server.ts`) on port 7233.                                                                |
| `bun run build`        | Production build (Vite) → `dist/`, then `bun run check:bundle` (hard-fails on a budget miss).                                             |
| `bun run check:bundle` | Gzip-measures every route/lazy chunk against `scripts/check-bundle-size.ts`'s budgets — run standalone for a quick recheck after a build. |
| `bun run typecheck`    | `svelte-check` over the whole project.                                                                                                    |
| `bun run lint`         | `oxlint`.                                                                                                                                 |
| `bun run lint:fix`     | `oxlint --fix`.                                                                                                                           |
| `bun run format`       | `prettier --write` (Svelte + import-organizing plugins).                                                                                  |
| `bun run format:check` | `prettier --check` — what CI/pre-commit should run instead of `format`.                                                                   |
| `bun run test`         | `bun test` with the Svelte 5 compile plugin + happy-dom preload.                                                                          |

## Deployment modes

The same built bundle (`dist/`) boots in three modes — distinguished only by how the shell is
served and which realtime transport is viable, never by rebuilding — via one runtime
configuration layer (plan §3). `tests/deployment/` integration-tests all three modes against
real weft code: the Bun mount (`tests/deployment/bun-mount.test.ts`, a real
`serve({ dashboard, dashboardAssets })` — all eight `DASHBOARD_PAGE_ROUTES` return the shell at
`200`, `/assets/*` serves the built chunks, and `/api`/root-stable routes are untouched), the
Service Worker mode (`setupServiceWorker`/`handleRequest`), and cross-origin (a real
`serve({ cors })`).

### 1. Bun server mount (primary)

```ts
import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';
import { weftConsole, weftConsoleAssets } from '@lostgradient/weft-console';
import { workflows } from './workflows';

const engine = await Engine.create({ workflows });
await serve({ engine, dashboard: weftConsole(), dashboardAssets: weftConsoleAssets() });
```

`weftConsole({ distDir? })` (`src/mount.ts`) returns a static `Response` streaming the built
`index.html` — `serve()` registers it at exactly the eight `DASHBOARD_PAGE_ROUTES`
(`/`, `/workflows`, `/workflows/*`, `/reviews`, `/workers`, `/schedules`, `/storage`, `/system`
as of `@lostgradient/weft@0.16.0`, which made the console's leaf routes real deep-linkable page
routes) and, by construction of Bun's static route table, it can never shadow `/api/*` or the
root-stable discovery routes (`/v1/health`, `/openapi.json`, …). The injected config block
defaults to `{ baseUrl: '' }` (same origin — the console and API share a port under this mode).

`weftConsoleAssets({ distDir? })` returns the `ServeOptions.dashboardAssets` descriptor
(`{ prefix: '/assets', directory: <distDir>/assets }`) for the shell's content-hashed JS/CSS
chunks — weft 0.16.0's `dashboardAssets` option serves them as verified static file routes, so
the two options together are a complete deployment: no reverse proxy or separate static file
server is required. (Before weft 0.16.0, `dashboard` alone mounted only the page routes and
every `/assets/*` request 404'd; that gap is fixed upstream and
`tests/deployment/bun-mount.test.ts` guards the full contract against a real `serve()`
instance.)

Pass `distDir` (to both functions) only if you build once and copy `dist/` to a different
location than this package's own `dist/` (e.g. a CDN origin bucket) before serving it from
there. The assets directory must exist before `serve()` is called — weft validates it at boot.

**Zero-code CLI mount (weft 0.16.0, weft#842).** `weft serve --console` mounts this package
without writing any server code: the CLI resolves `@lostgradient/weft-console` from the project
it runs in, calls the exported `weftConsole()`, and serves the package's built `dist/assets`
as the asset routes — the CLI equivalent of the `serve({ dashboard, dashboardAssets })` call
above. Install the console next to weft and start the server:

```sh
bun add @lostgradient/weft-console
bunx weft serve --console --workflows ./workflows.ts
```

**Security note.** The shell HTML is served from Bun's static `routes` table, which is matched
_before_ weft's `fetch`/auth handler runs — so `serve({ auth })` protects the API, never the
page. Anyone who can reach the port gets the (empty, data-free) shell; only the API calls it then
makes are authenticated. If a deployment needs to hide the shell itself, put it behind a reverse
proxy or on a private network — weft has no page-level access control to configure.

### 2. Standalone / cross-origin

The console runs on a different origin than the `weft` server — a hosted console pointed at
several backends, or local development where the dev server and API aren't same-origin. Enabled
by weft's `cors` option on `serve()`:

```ts
import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';

const engine = await Engine.create({ workflows });
await serve({
  engine,
  cors: {
    allowedOrigins: ['https://console.example.com'],
    credentials: true,
  },
  publicOrigin: 'https://api.example.com',
});
```

The console's own config block then points at the API origin explicitly:
`{ "baseUrl": "https://api.example.com" }`. `cors` answers preflight (`OPTIONS`) requests, decorates
allowed-origin responses with `Access-Control-Allow-*` headers, and rejects cross-origin WebSocket
upgrades from disallowed origins — all verified live in `tests/deployment/cross-origin.test.ts`
against a real `serve({ cors })` instance (preflight and actual GET for an allowed origin;
withheld headers, not a thrown request, for a disallowed one — `fetch()` itself never enforces
CORS, only a real browser does). **Omitting `cors` is the safe default**: no `Access-Control-*`
headers are ever emitted and only same-origin requests succeed; weft never falls back to
`Access-Control-Allow-Origin: *`.

`serve()` validates the `cors` option **synchronously, before the port binds** — a wildcard
origin (`allowedOrigins: ['*']`) combined with `credentials: true`, or with an explicit
`Authorization` allowed-header, throws at `serve()`-call time rather than being silently accepted
and only failing at request time. Both rejections are covered in
`tests/deployment/cross-origin.test.ts`. Set `publicOrigin` (or `trustedHosts`) alongside `cors`
so the discovery routes (`/.well-known/api-catalog`, `/.well-known/mcp.json`) emit correct
absolute URLs instead of trusting an attacker-controlled `Host` header.

### 3. Service Worker host page

The engine runs inside a browser (or WebExtension) Service Worker — no Bun server at all, storage
is `IndexedDBStorage`. A host page serves the built `dist/` itself and registers the worker:

```ts
// service-worker.ts, registered by the host page
import { workflow } from '@lostgradient/weft';
import { setupServiceWorker } from '@lostgradient/weft/service-worker';

const checkout = workflow({ name: 'checkout' }).execute(async function* () {
  /* … */
});

await setupServiceWorker({
  pathPrefix: '/weft/',
  register: (engine) => {
    engine.register(checkout);
  },
});
```

The host page's `index.html` (copied from this package's `dist/`) carries a config block of
`{ "baseUrl": "/weft", "eventTransport": "sse" }` — WebSocket upgrades cannot be intercepted by a
Service Worker, so the console must be told to use SSE up front rather than discover it via
`'auto'`'s WebSocket-first probe. `tests/deployment/config-injection.test.ts` proves this exact
block round-trips through `readRuntimeConfig()`/`createClient()` into a correctly-configured
`HttpClient`, and `tests/deployment/service-worker.test.ts` proves a REST read (`GET
/weft/v1/workflows/:id`) resolves end to end through the real `setupServiceWorker()` fetch
listener against `IndexedDBStorage`.

**Authenticated SSE through `setupServiceWorker()` (weft 0.16.0, weft#845).**
`setupServiceWorker({ handlerOptions })` accepts the `ServiceWorkerHandlerOptions` subset of
`HandlerOptions` (`authContext`, `workflowEventFeed`, `fleetEventFeed`,
`acquireWorkflowStreamConnection`), so a host that wants live feeds or a non-anonymous principal
wires them straight into the convenience wrapper — no hand-rolled fetch listener required:

```ts
import { createFleetEventFeed } from '@lostgradient/weft/server/handler';

const storage = /* the same storage instance the engine uses */;

await setupServiceWorker({
  storage,
  handlerOptions: {
    fleetEventFeed: createFleetEventFeed(storage),
    // authContext: … — required for any `scoped`/`authenticated` route
    // (fleet SSE declares `events:read`).
  },
  register: (engine) => {
    /* … */
  },
});
```

Omitting `handlerOptions` keeps the pre-0.16 default: every request through the Service Worker
entry point resolves to a zero-scope anonymous principal, so `public` REST reads work but any
`scoped`/`authenticated` operation 401s. Both sides — the anonymous default and an
authenticated, genuinely incremental fleet SSE stream (a live-appended event arriving over an
already-open `Response` body) — are proven through the real `setupServiceWorker()` fetch
listener in `tests/deployment/service-worker.test.ts`.

### Runtime configuration contract

All three modes read one injected block, parsed once at boot by `readRuntimeConfig()`
(`src/lib/config.ts`) and turned into the app's single `HttpClient` by `createClient()`
(`src/lib/client.ts`):

```html
<script type="application/json" id="weft-console-config">
  { "baseUrl": "/weft", "eventTransport": "sse" }
</script>
```

| Field            | Type                             | Meaning                                                                                                                                                                                                                          |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | `string` (required)              | `''` → same origin (Bun mount, same-origin standalone); an absolute URL → a fixed API origin (cross-origin standalone); a root-relative path (`/weft`) → resolved against the page's own origin (Service Worker's `pathPrefix`). |
| `eventTransport` | `'auto' \| 'websocket' \| 'sse'` | Optional, defaults to `'auto'`. Service Worker mode must set `'sse'` explicitly — WebSocket upgrades never reach a Service Worker `fetch` listener.                                                                              |
| `token`          | `string`                         | Optional bearer token, held only in the constructed `HttpClient` (never written to `localStorage` or a cookie by this package).                                                                                                  |
| `headers`        | `Record<string, string>`         | Optional extra headers sent on every request (e.g. a fixed `X-API-Key` for a deployment that doesn't use bearer tokens). An explicit `headers.Authorization` wins over `token`.                                                  |
| `assetBase`      | `string`                         | Declared and validated, reserved for a future CDN asset-base rewrite (plan §3.1's "asset base URL for CDN deployments"). Not yet consumed anywhere in this bundle — setting it today has no effect.                              |

A present-but-malformed config block (invalid JSON, or valid JSON that fails shape validation)
throws loudly rather than silently falling back — it's generated by the mount, so a broken one is
a deployment bug worth surfacing, not masking. A missing/empty block falls back to
`{ baseUrl: '', eventTransport: 'auto' }` (same-origin, auto-transport) so a bare `index.html`
load outside any of the three documented modes still boots.

### Scope requirements per surface

Sourced from the current operation catalog (`@lostgradient/weft/src/server/operations/*.ts`), not
from the scope vocabulary alone — several declared scopes are not yet enforced by any operation
(see the caveat below). What's actually checked today:

| Surface                                                                                                                                                                                                              | Access policy today                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bulk workflow operations (cancel / delete / retry-failed / signal / tag-mutate)                                                                                                                                      | `scoped` — `workflows:admin`                                                                                                                         |
| Async-activity completion (`weft.activities.complete` / `.fail`)                                                                                                                                                     | `scoped` — `workflows:write` (read/heartbeat side: `workflows:read`)                                                                                 |
| Human-review listing (`weft.reviews.list`)                                                                                                                                                                           | `scoped` — `reviews:read`                                                                                                                            |
| Raw storage KV browser (get / put / delete / scan / batch / conditional-batch)                                                                                                                                       | `scoped` — `storage:admin`                                                                                                                           |
| Workers, task queues, task diagnostics (list), registry, system lease, metrics                                                                                                                                       | `scoped` — `system:read`                                                                                                                             |
| Worker drain / resume / clear-dead-letter, task-diagnostics admin actions                                                                                                                                            | `scoped` — `system:admin`                                                                                                                            |
| Per-workflow live tail (`/watch`, `/stream`)                                                                                                                                                                         | `scoped` — `streams:read`                                                                                                                            |
| Fleet events feed (`/v1/events/sse`, `weft.events.subscribe`)                                                                                                                                                        | `scoped` — `events:read`                                                                                                                             |
| Schedule read (`weft.schedules.get` / `.list`)                                                                                                                                                                       | `authenticated` — any authenticated principal, no specific scope                                                                                     |
| Everything else — workflow reads/starts/signals/updates/queries, single-workflow control (cancel/suspend/resume/terminate), attributes, tags, schedule create/update/pause/resume/cancel, review-decision submission | `public` — allowed for any principal the server-level authenticator admits (including an anonymous one, if `auth`/`unauthenticatedAccess` allows it) |

**A `public` access policy is not the same as "no authentication required".** When `serve({ auth })`
is configured, every request still needs _some_ valid credential — a request with none 401s before
it ever reaches the operation catalog (`authenticateRequest`, `src/server/runtime/request-gate.ts`).
`public` only means the operation itself performs no _additional_ scope check once a principal is
authenticated — so a credential issued with, say, only `workflows:read` can still call
`purge-workflows` or `recover-all` today, because those operations never look at the principal's
granted scopes. `schedules:write`, `signals:write`, `updates:write`, `queries:read`,
`attributes:read`/`write`, `tags:write`, and `budget:read`/`write` are all declared in weft's scope
vocabulary but checked by **no** operation as of this writing. This is a known, already-tracked
posture gap in weft itself, not a console defect, and not something this repository works around
locally. The console still gates its own UI on the principal's granted scopes
(`src/lib/scopes.svelte.ts`'s `hasScope()`, disable-with-reason per PROJECT-BRIEF) — that's correct
and forward-compatible with tighter server enforcement landing later, but it is a client-side
convenience, not a security boundary: don't rely on the console's disabled-button state as proof
that the server would also reject the call.

## Toolchain decisions (Phase 0, plan §2/§13 T0.2–T0.3)

- **Vite for both dev and production build** — one pipeline, not a dev/prod split. Compiler-integrated
  HMR via `@sveltejs/vite-plugin-svelte` is the proven path for Svelte 5 (runes-aware, no full-page
  reloads, CSS hot-applies). Production `bun run build` runs `vite build`: content-hashed assets,
  external sourcemaps, and one chunk per route via the dynamic imports in `src/app/routes.ts`
  (`src/routes/dashboard/cards.ts` gives each dashboard card its own chunk boundary too).
- **`@tanstack/svelte-query` v5, store API (not the v6 runes API)** — v5's Svelte-5 support is via
  its store contract (`createQuery(...)` returns a Svelte store; read it with `$query` inside a
  component). The runes-native rewrite is a v6 feature (`svelte: '^5.25.0'` peer, a from-scratch
  API) and was not pulled in because the console is pinned to v5 by the scaffolding task. Verified
  with a real mounted smoke test (`tests/tanstack-query-smoke*.svelte` + `.test.ts`), not just a
  type check — and that test caught a real footgun:
  - **Pass a plain options object, `createQuery({...})` — NOT `createQuery(() => ({...}))`.**
    `createQuery`'s parameter type is `StoreOrVal<T> = T | Readable<T>`: a plain value or a real
    Svelte store (something with `.subscribe`), never a callback. Passing a getter function makes
    the _function itself_ the "options" value — `queryKey`/`queryFn` read as `undefined` inside
    `createBaseQuery`, so the query silently sits at `status: 'pending'` forever with no error and
    the console-logs `"As of v4, queryKey needs to be an Array"` warning. `$query.data`/`$query.status`
    read via the `$`-store-subscription prefix is correct and works once options are a plain
    object or a real store.
  - **For options that must react to changing component state** (a filter, a page offset, an id
    from the route — the common case for every list/detail route this console builds), a plain
    object is captured once and never updates. The resolved bridge, used consistently across every
    domain track: `toStore(() => ({ queryKey, queryFn, ... }))` from `svelte/store`, wrapping a
    getter that reads whatever `$derived`/`$state` values the query depends on — e.g.
    `src/routes/schedules/schedule-list.svelte`'s `createQuery(toStore(() => ({ queryKey:
queryKeys.schedules.list(filter), queryFn: () => fetchScheduleList(client, filter) })))`. A bare
    `$derived` object or a plain getter function passed directly to `createQuery` both fail the same
    way the footgun above describes; `toStore()` is what actually satisfies `createQuery`'s
    `StoreOrVal<T>` parameter type reactively.
- **Bun test + a hand-rolled Svelte-compile plugin, not Vitest** — `tests/setup.ts` +
  `scripts/svelte-test-plugin.ts` port the proven `cinder/packages/components` pattern: a Bun
  plugin compiles `.svelte` (client generate) and `.svelte.ts` rune modules
  (`svelte/compiler`'s `compileModule`) before Bun's module loader sees them, happy-dom supplies
  DOM globals via a `Window` instance copied onto `globalThis`, and `@testing-library/svelte`'s
  `cleanup()` runs after every test via one global `afterEach`. Component tests run with
  `bun test --conditions browser --conditions svelte` — those flags are load-bearing: Cinder ships
  `.svelte`/`.ts` **source** (not just `dist/`) behind its `browser`/`svelte` package.json export
  conditions, and without the flags Bun resolves to already-compiled `dist/` output instead.
  **Always run `bun run test`, never bare `bun test`.** This isn't Cinder-specific: `svelte`
  itself exports `mount()` only behind the `browser` condition (`default`/`node` resolves to
  `svelte/src/index-server.js`, an SSR-only build with no `mount`), so bare `bun test` fails
  `tests/component-harness.test.ts` with `lifecycle_function_unavailable: mount(...) is not
available on the server` for every component test — not a real regression, just proof the flags
  are load-bearing. There is no bunfig.toml or
  env-var equivalent for `--conditions` (checked: a top-level `conditions` key and `BUN_CONDITIONS`
  are both silently no-ops for `bun test`/`bun run`); the CLI flags are a hard requirement, per the
  comment at the top of `scripts/svelte-test-plugin.ts`.
- **Current package baseline: Cinder v0.24.0 and `@lostgradient/weft` v0.18.0.** These are the exact
  versions pinned in `package.json`; the lockfile resolves the same versions. The historical
  adoption baseline was Cinder v0.19.0 and Weft v0.15.0, following the scaffolding task's historical
  v0.16.1/v0.12.0 pair and the implementation plan's v0.9.0/v0.11.0 authoring snapshot.
  `lucide-svelte` is pinned inside Cinder's declared peer
  range (`>=0.400.0 <1`) rather than the latest `1.x` line, which falls outside that peer contract.
  Cinder 0.17.0 finished extracting markdown/editor into standalone packages and deleted the
  `@lostgradient/cinder/markdown/*` shim — the console's one consumer (`artifact-view.svelte`)
  now imports `@lostgradient/markdown/rendering` directly, and `@lostgradient/markdown` is a
  direct dependency.

## Historical Cinder-first evaluations after the 0.19.0 bump

This historical adoption record covers the 0.18.0 and 0.19.0 additions that were re-evaluated
against the installed component source at the time, not assumed from issue titles:

- **`RunStepTimeline`'s `timed-out` status (cinder#848, fixed by cinder#853)** — adopted outright.
  `timeline-step-state.ts` previously collapsed Weft's `timed-out` timeline status into Cinder's
  `failed` `RunStepStatus` because no dedicated value existed; Cinder 0.17.0 added one (danger
  tone, terminal), so the mapping now passes it through unchanged.
- **`InvocationRuleBuilder`'s `mode="flat-conditions"` (cinder#847, fixed by cinder#854)** —
  fixed the rule-grouping blocker that stopped the original C4 evaluation (`mode="conditions"`
  forced every condition set under a named, moveable/removable "rule" — a shape this console's
  flat AND-only search-attribute grammar can't represent), but did not unblock adoption. Every
  mode's field selector remains a plain `<select>` bound to a fixed `fieldOptions` list
  (`invocation-rule-builder.svelte:635-651`) with no free-text entry, and the console's query
  builder needs to filter on search-attribute keys it has never observed a value for yet — exactly
  what Cinder's own `Combobox` (already used in `query-builder.svelte`) provides via free-text
  `bind:inputValue`. Filed as cinder#865. `src/routes/workflows/list/query-builder.ts`/`.svelte`
  keep the app-local `Combobox`+`Select`+`Input` composition until it lands.
- **`JsonEditor` (cinder#852)** — evaluated against `src/lib/payload-editor/` (the shared
  CodeMirror 6 editor behind Start/Signal/Update/Schedule/Storage's five payload call sites) and
  **adopted after cinder#866 → cinder#874**. Cinder 0.18.0's opt-in `highlight` mode keeps the
  native textarea as the editing and value contract, adds lazy token highlighting and a parse
  position annotation, and announces parse feedback through the existing `role="status"` /
  `role="alert"` wiring. Its source uses Cinder tokens in both themes and preserves accessible
  label/description relationships. The highlighted enhancement chunk measures **0.87 KB gzip**
  versus the old CodeMirror chunk's **104.08 KB gzip**. All five sites now use the minimal
  `value`/`onValueChange` contract with their existing labels, rows, and external errors.
- **Curated Shiki (cinder#876)** — the console now imports
  `@lostgradient/cinder/highlighters/shiki/curated` with only `json` and `typescript` language
  loaders and `github-light`/`github-dark` theme loaders. The old local alias shim is deleted.
  The fresh total JS chunk count is **353** (the previous enforced baseline was 56); the existing
  count gate remains enabled with a fresh measured baseline because Cinder's separate default
  `CodeBlock` adapter graph still emits the full registry even when highlighted call sites pass the
  curated adapter explicitly.

## Repository layout

See plan §2 for the authoritative layout description. The short version:

- `src/mount.ts` — the Bun mount export.
- `src/main.ts` / `src/app/` — SPA entry + shell (sidebar, topbar, command palette, notification
  center, toasts, scope banner — built in Phase 1, T1.6; frozen alongside `src/lib/**` after the
  Phase 1 Foundation gate).
- `src/routes/<domain>/` — one directory per domain (`dashboard`, `workflows`, `schedules`,
  `workers`, `reviews`, `storage`, `system`). Each domain track owns its own directory
  exclusively; all seven are fully implemented (list/detail surfaces, mutations, live updates,
  fault/empty/loading states, colocated tests) — see plan Appendix B for the per-surface
  acceptance checklist. `src/routes/dashboard/cards.ts` is the one shared card-slot registry.
- `src/lib/` — framework-free (or `.svelte.ts` rune-based) modules: `client.ts`, `config.ts`,
  `scopes.svelte.ts`, `router.svelte.ts`, `filters.ts`, `faults.ts`, `format/`, `live-source/`.
  Frozen after the Phase 1 Foundation gate.
- `src/styles/` — `index.css` (shared entry, Cinder base styles + theme contract) plus one
  per-track stylesheet each domain owns exclusively (route-local rules — never added to
  `index.css`). Component entrypoints load their own styles; only documented transitive
  dependencies such as chart tooltips' Popover CSS belong here.
- `fixtures/` — deterministic demo data for the dev server and integration tests, split by
  concern (`workflows.ts` is the base module + orchestrating `seed()`; `coordination.ts`,
  `saga.ts`, `finalizer.ts`, `async-activity.ts`, `children.ts`, `history.ts`, `tagged.ts`,
  `failures.ts`, `reviews.ts`, `schedules.ts` each seed one domain-specific specimen). Append-only
  — see the Development section below for a tour. Playwright E2E (plan §11.4) is not yet built in
  this repository; there are no Playwright seeds today despite what an earlier draft of this file
  claimed.
- `scripts/dev-server.ts` — boots the seeded local `weft` server `bun run dev` proxies to.
- `scripts/check-bundle-size.ts` — the CI-facing bundle-size gate (plan §12), chained onto
  `bun run build`.
- `tests/` — the test harness (`setup.ts`) plus integration/proving tests that don't belong to a
  single domain track.

## Development

- **Two-terminal dev harness.** `bun run dev:server` (port 7233) and `bun run dev` (port 5173) —
  see Quickstart above. Kill both when you're done; `bun run dev:server` holds an in-memory engine
  with no persistence between restarts.
- **Test conditions flags are load-bearing.** Always run `bun run test`, never bare `bun test` —
  it runs `bun test --conditions browser --conditions svelte`, and without those two flags Bun
  resolves both Cinder and Svelte itself to their non-browser (`dist`/SSR-only) export conditions,
  which fails every component test with `lifecycle_function_unavailable`. See the "Toolchain
  decisions" section above for the full diagnosis.
- **Fixture tour** (`fixtures/*.ts`, all started by `seed()` in `fixtures/workflows.ts` against
  `bun run dev:server`'s engine): `order-processing` (completes), `payment-failing` (always
  fails), `long-sleeper` / `review-gate` / `signal-stepped` (deliberately left running),
  `checkout-coordination` (`coordination.ts` — `ctx.race`/`ctx.all`/`ctx.speculate` in one run,
  for the Timeline's branch-group rendering), `trip-booking-saga` (`saga.ts` — a failing final
  step so `ctx.saga` compensates in reverse order), `sandbox-session` (`finalizer.ts` — cancelled
  mid-run so the finalizer sub-states render), `ship-package-async` (`async-activity.ts` — a
  never-externally-completed `ctx.completeAsync()` token, for the async-completion drawer),
  `fulfillment-parent` + `validate-shipment`/`monitor-delivery` (`children.ts` — one awaited
  child, one detached long-running child), `audit-trail-sweep` (`history.ts` — 200+ durable steps,
  for timeline/checkpoint pagination), `customer-outreach-campaign` ×4 (`tagged.ts` — varied
  run-level tags and search attributes), the `timeout`/`cancellation`/`resource`/`system` failure
  demos (`failures.ts` — one run per failure-category taxonomy value), `content-review` ×3
  (`reviews.ts` — a pending sectioned/partial review, a completed decision, a timed-out review),
  and two schedules over `inventory-sync-sweep` (`schedules.ts` — one active every-5-minutes cron,
  one paused). Extend a
  module or add a new one for a new demo state; never mutate an existing specimen another track's
  tests or the dev harness itself already assert against.
