/**
 * E2E-only weft server bootstrap (plan §11.4). `playwright.config.ts`'s
 * `webServer` array runs this directly (`bun tests/e2e/e2e-server.ts`)
 * before starting Vite. See `e2e-constants.ts` for why this is a dedicated
 * process rather than a `scripts/dev-server.ts` shared-file edit.
 *
 * Boots a real `serve({ engine, auth })` — same seeded fixtures the
 * interactive dev harness uses (`fixtures/workflows.ts`, append-only, read
 * here rather than mutated) — with a single static API key granted every
 * authorization scope, so every persona flow's list/mutation/admin
 * operation succeeds regardless of which scope it happens to require. The
 * console never sees this key through the `<ApiKeyEntry>` UI: Playwright
 * injects it straight into the runtime config script tag on every document
 * response (`auth-fixtures.ts`), so the app boots directly into the
 * authenticated `Shell` — see that file's module doc for why.
 *
 * Also registers one `RemoteWorker` under `E2E_DEPLOYMENT_NAME` so the
 * Workers → Fleet overview surface has a real deployment group to drain
 * (flow (e)). It advertises `order-processing`'s `chargeCard` activity —
 * already registered on the engine — but nothing ever dispatches a task to
 * it, so it is present purely as fleet inventory, never doing real work.
 *
 * Follows `scripts/dev-server.ts`'s documented seed-after-serve ordering
 * (fleet SSE listeners must be live before fixtures start firing lifecycle
 * events) and its accepted boot-window tradeoff: `serve()` starts accepting
 * connections synchronously, before `await seed(engine)` below resolves.
 * Reproducing a hard readiness guarantee would mean wrapping `serve()` in
 * another app-local `Bun.serve()` proxy — the same composition that
 * rewrite deliberately avoided. In practice this window is sub-millisecond
 * (in-memory `MemoryStorage`) against a Vite cold start that takes
 * multiple seconds, so Playwright's own `webServer` + first-test startup
 * latency already exceeds it; no test in this suite polls a data-bearing
 * endpoint before the UI's own retrying assertions would already tolerate
 * the gap.
 */
import { Engine, RemoteWorker } from '@lostgradient/weft';
import { AUTHORIZATION_SCOPES, serve } from '@lostgradient/weft/server';

import { seed, workflows } from '../../fixtures/workflows.ts';
import {
  E2E_API_KEY,
  E2E_DEPLOYMENT_NAME,
  E2E_SERVER_PORT,
  E2E_TASK_OPERATION_ID,
} from './e2e-constants.ts';

// `AUTHORIZATION_SCOPES` became a public export of
// `@lostgradient/weft/server` in weft 0.18.0, so this file no longer keeps a
// hand-copied list that could drift from the runtime's own vocabulary. (The
// console's `src/lib/scopes.svelte.ts` still keeps a browser-safe copy —
// importing the server barrel into bundled code would pull weft's server
// module graph into the browser — but that copy is now pinned
// byte-identical against this same export by `scopes.svelte.test.ts`.)
const ALL_SCOPES = AUTHORIZATION_SCOPES;

const engine = await Engine.create({ workflows });

const server = serve({
  engine,
  port: E2E_SERVER_PORT,
  auth: {
    apiKeys: [E2E_API_KEY],
    defaultApiKeyScopes: ALL_SCOPES,
  },
});

await seed(engine);

const fleetWorker = new RemoteWorker({
  serverUrl: `ws://localhost:${E2E_SERVER_PORT}/v1/tasks/default/stream`,
  workerId: 'e2e-fleet-worker-1',
  deploymentName: E2E_DEPLOYMENT_NAME,
  buildId: 'e2e-build-1',
  workflows: {
    'order-processing': {
      name: 'order-processing',
      activities: {
        chargeCard: async () => ({ chargeId: 'unused-e2e-fixture-worker' }),
        reserveInventory: async () => {
          throw new Error('seeded inventory outage');
        },
      },
    },
  },
  headers: { Authorization: `Bearer ${E2E_API_KEY}` },
});

await fleetWorker.connect();

await server.dispatchTask({
  operationId: E2E_TASK_OPERATION_ID,
  workflowId: 'e2e-ledger-workflow',
  workflowExecutionToken: 'e2e-ledger-token',
  workflowType: 'order-processing',
  activityName: 'reserveInventory',
  input: { orderId: 'e2e-ledger-order' },
  queue: 'default',
  priority: 9,
  headers: { traceparent: '00-e2e-ledger-trace-e2e-span-01' },
  retryPolicy: {
    maxAttempts: 3,
    initialBackoff: '5m',
    backoffMultiplier: 2,
    maxBackoff: '10m',
  },
});

for (let attempt = 0; attempt < 5; attempt += 1) {
  const result = await server.getTaskResult(E2E_TASK_OPERATION_ID);
  if (result?.status === 'pending' && result.state === 'queued') break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}

console.log(`weft E2E server listening on ${server.url}`);
console.log(`Registered E2E fleet worker under deployment "${E2E_DEPLOYMENT_NAME}"`);
