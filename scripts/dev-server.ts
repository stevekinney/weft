/**
 * Dev harness server (plan §2, T0.3, PROJECT-BRIEF "Dev harness"). Boots a
 * seeded local weft server on port 7233 that `bun run dev`'s Vite proxy
 * (`vite.config.ts`) targets. Run directly with `bun run dev:server`.
 *
 * Ground truth note: `serve()` is exported from `@lostgradient/weft/server`,
 * not the package root (verified against `weft/src/server/index.ts` and
 * `weft/src/index.ts`).
 *
 * **This is a plain `serve()` call — the earlier hand-rolled workaround is
 * gone.** `@lostgradient/weft@0.11.0` had `serve({ engine })` throw "Engine
 * internals not initialized" for any root-imported `Engine`
 * (https://github.com/stevekinney/weft/issues/710), so this file used to
 * drive `@lostgradient/weft/server/handler`'s `handleRequest()` directly
 * behind a thin `Bun.serve()`, with a synthetic fleet event feed
 * reimplementing weft's own production wiring. `0.12.0` shipped the actual
 * fix (#716: every entry point that transitively touches `Engine`'s
 * module-scope singleton state now resolves the same unbundled module
 * `Engine.create()` does, instead of a separately-bundled duplicate) —
 * confirmed empirically here, not assumed: this file now calls `serve()`
 * with no cast, no manual `/api`-prefix stripping (`serve()` does that
 * itself — `src/server/runtime/authentication-bridge.ts`'s
 * `stripApiPrefix()`), and no reimplemented event feed (`serve()` wires
 * both the fleet feed and the per-workflow feed via its own
 * `wireEventBroadcasting()` / `createWorkflowEventFeed()` internally). That
 * also means WebSocket upgrades and JSON-RPC over HTTP (`/api/jsonrpc`) —
 * both `serve()`-pipeline-only, unavailable through bare `handleRequest` —
 * now work in this dev harness for the first time.
 *
 * **Auth — real, not full-trust, and narrower than the old harness.**
 * `unauthenticatedAccess: 'warn'` only controls whether `serve()` refuses to
 * *start* with no `auth` configured (fail-closed vs warn-and-proceed) — it
 * has no per-request effect once the process is up
 * (`assertAuthenticationPosture`, `weft/src/server/serve-internals.ts`).
 * Every credential-less request still resolves to `anonymousPrincipal()`
 * (zero scopes, `weft/src/server/handler/auth-context-principal.ts`), so
 * only `access: { kind: 'public' }` operations — most workflow reads and
 * single-item actions — actually succeed here. `access: 'scoped'`/
 * `'authenticated'` operations (schedules list/get, reviews list, storage,
 * system/registry, …) 401 with no credential, confirmed live (`curl
 * localhost:7233/api/v1/schedules` → `401 {"error":"authentication
 * required"}`). This is narrower than the OLD `handleRequest`-based harness,
 * which hand-injected a full-scope `principalFromStdioLocal()` principal on
 * every request regardless of credentials — `serve()` has no equivalent
 * hook; the only way to grant elevated scopes to anonymous callers would be
 * `serve({ auth: { apiKeys: […] } })` plus a matching token the console
 * itself sends — which is exactly what this harness now does, as of the
 * weft 0.18.0 adoption. The deferral reasoned that it "touches the frozen
 * `index.html`/`client.ts` runtime-config contract"; it turns out not to,
 * because `vite.config.ts`'s dev proxy attaches the header on the way
 * through and no build artifact ever carries a token. See
 * `scripts/dev-credentials.ts` for why an authenticated harness became
 * necessary once `resolvePrincipal()` started reporting the server's real
 * answer instead of optimistically granting every scope. Scoped surfaces
 * (schedules, storage, system, workers) work here now; they used to 401.
 * This is a dev-only harness serving a `MemoryStorage`-backed engine on
 * localhost; there is no real access boundary to preserve for what IS
 * reachable.
 *
 * **Seed-after-serve, not serve-after-seed.** `serve()` binds the port and
 * wires event broadcasting synchronously (no `await` inside it), so calling
 * `seed(engine)` immediately after — rather than before — `serve()` means
 * every fixture workflow's lifecycle events fire AFTER a live listener
 * exists, landing them in the fleet feed's replay buffer exactly like a
 * production workflow started after boot would. Seeding first would trade
 * that away: `wireEventBroadcasting()`'s fleet feed only captures events
 * from the moment its listener attaches (`createFleetEventFeed`,
 * `weft/src/server/fleet-event-feed.ts`), so pre-boot events would be
 * permanently invisible to `/api/v1/events/sse` replay — and the shell's
 * notification bell deliberately renders that replay backlog on first
 * connect (`src/app/engine-status.svelte.ts`), so an empty backlog would be
 * a visible dev/demo regression, not just an implementation detail.
 *
 * The cost of that ordering: `serve()` exposes no pre-request hook, so
 * there is a real (small, single-digit-millisecond) window between the port
 * accepting connections and `seed()` finishing where `GET /v1/health` can
 * already answer while the fixtures are still being written. This is
 * ordinary `serve()` boot behavior — indistinguishable from a production
 * deployment's own empty-then-populated startup — not a bug specific to
 * this harness. It is a real behavior change from the previous revision of
 * this file, which hand-built a `readyPromise` gate in front of its own
 * `Bun.serve()` fetch handler so no response (including health) could beat
 * `seed()`. Reproducing that exact guarantee on top of `serve()` would mean
 * wrapping it in another app-local `Bun.serve()` proxy — the composition
 * this rewrite exists to delete. Documented here rather than silently
 * dropped: if a caller needs a hard readiness guarantee, poll
 * `GET /api/v1/workflows` for a non-empty result instead of trusting
 * `/v1/health` alone.
 */
import { Engine } from '@lostgradient/weft';
import { AUTHORIZATION_SCOPES, serve } from '@lostgradient/weft/server';

import { DEV_API_KEY } from './dev-credentials.ts';

import { seed, workflows } from '../fixtures/workflows.ts';

const PORT = 7233;

const engine = await Engine.create({ workflows });

const server = serve({
  engine,
  port: PORT,
  auth: { apiKeys: [DEV_API_KEY], defaultApiKeyScopes: AUTHORIZATION_SCOPES },
});

await seed(engine);

console.log(`weft dev server listening on ${server.url}`);
console.log(
  'Seeded fixture workflows: order-processing, payment-failing, long-sleeper, review-gate, ' +
    'signal-stepped, checkout-coordination, trip-booking-saga, sandbox-session, ' +
    'ship-package-async, fulfillment-parent (+ validate-shipment, monitor-delivery), ' +
    'audit-trail-sweep, customer-outreach-campaign (x4), ' +
    'timeout/cancellation/resource/system-failure-demo, content-review (x3), ' +
    'inventory-sync-sweep, nightly-reconciliation (start-new continuation chain)',
);
console.log(
  'Seeded schedules: inventory-sync-every-5-minutes (active), nightly-inventory-audit (paused)',
);
console.log(
  'Fleet SSE (/api/v1/events/sse), per-workflow SSE/WebSocket tails ' +
    '(/api/v1/workflows/:id/events/sse, /api/v1/workflows/:id/watch), and JSON-RPC ' +
    '(/api/jsonrpc) are all live against real engine state.',
);
