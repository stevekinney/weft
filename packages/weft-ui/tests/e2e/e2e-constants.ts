/**
 * Shared constants for the Playwright/axe E2E harness (plan §11.4). Kept in
 * one file so `e2e-server.ts` (the bootstrap `playwright.config.ts`'s
 * `webServer` spawns) and the Playwright config itself never drift on the
 * port or credential a test run depends on.
 *
 * **Why a dedicated server, not `scripts/dev-server.ts`.** The interactive
 * dev harness deliberately boots with no `auth` configured
 * (`unauthenticatedAccess: 'warn'`) so a human operator sees the real
 * anonymous-degrade UX. `weft.reviews.list`, `weft.schedules.list`,
 * `weft.workers.list`, and every `weft.workflows.bulk.*` operation declare
 * `access: { kind: 'scoped' | 'authenticated' }` (verified against
 * `weft/src/server/operations/{list-reviews,list-schedules,list-workers,
 * bulk-filter-helpers}.ts`), and `serve()`'s authenticator only runs at all
 * when `auth` is configured (`weft/src/server/runtime/request-gate.ts`) — so
 * an unauthenticated request against those operations always 401s
 * regardless of `unauthenticatedAccess`. Three of this suite's five persona
 * flows (approve-a-review, bulk-retry, drain-a-deployment) need those
 * surfaces, so E2E needs its own server with `auth` configured and a
 * full-scope key — a separate process from the shared dev harness, not a
 * shared-file edit to it.
 */

/** Fixed port for the E2E-only weft server (`e2e-server.ts`). Distinct from the interactive dev harness's 7233. */
export const E2E_SERVER_PORT = 7399;

/** Fixed port Vite serves the console on for E2E runs. Distinct from the interactive `bun run dev`'s 5173. */
export const E2E_CONSOLE_PORT = 5183;

export const E2E_BASE_URL = `http://localhost:${E2E_CONSOLE_PORT}`;

/**
 * Static API key admitted by the E2E server's `auth.apiKeys`, granted every
 * scope via `auth.defaultApiKeyScopes` (`e2e-server.ts`). Injected into the
 * console's runtime config on every document response by
 * `tests/e2e/auth-fixtures.ts` — never typed through the `<ApiKeyEntry>` UI,
 * never persisted (matches `src/lib/config.ts`'s `token`: "held in memory
 * only").
 */
export const E2E_API_KEY = 'weft-ui-e2e-fixture-key';

/** `deploymentName` the E2E `RemoteWorker` registers under (flow (e), drain-a-deployment). */
export const E2E_DEPLOYMENT_NAME = 'checkout-worker-fleet';

/** Durable operation seeded through the real remote-worker protocol for the WFC-18 ledger flow. */
export const E2E_TASK_OPERATION_ID = 'e2e-ledger-delayed-charge';
