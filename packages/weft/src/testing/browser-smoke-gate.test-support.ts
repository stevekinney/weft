/**
 * The shared opt-in gate for every suite that drives a real Chromium process.
 *
 * Three suites — `storage/indexeddb-browser`, `storage/web-extension-browser`,
 * and `service-worker/service-worker-browser` — launch Playwright against a
 * real browser. Their cost is not a constant: a Chromium launch, an unpacked
 * extension load, and a bundle build all compete for whatever CPU the machine
 * has left, so the same suite that finishes in well under a second on an idle
 * machine blows past Bun's 5,000 ms default hook timeout when several agents
 * are working. A suite whose result depends on machine load is not a gate on
 * anything, and it made `bun run validate` non-deterministic.
 *
 * Opt-in, not opt-out: the default pass must be deterministic, and only an
 * explicit request can be read as "this machine has a browser installed and the
 * headroom to run it." Opt-out would leave the default pass load-sensitive,
 * which is the defect itself. Run them with:
 *
 * ```sh
 * bun run --filter=@lostgradient/weft test:browser
 * ```
 *
 * Browser provisioning is `bunx playwright install chromium` (once).
 *
 * Applied as `describe.skipIf(!browserSmokeEnabled)`, which suppresses the
 * suite's `beforeAll`/`afterAll` hooks as well as its tests — the hook is where
 * the browser actually launches, so gating the tests alone would not help.
 *
 * The flag is read through the registered runtime boundary rather than off
 * `Bun.env`, the same way `storage/bun-sql-benchmark.test.ts` reads its own
 * opt-in benchmark switch. A test-only flag does not belong in a production
 * configuration schema, and `readEnvironmentVariable` is the boundary's
 * sanctioned single-name read.
 */

import { readEnvironmentVariable } from '../runtime/environment-configuration.ts';

/** True only when `WEFT_BROWSER_SMOKE=1` asks for the real-browser suites. */
export const browserSmokeEnabled = readEnvironmentVariable('WEFT_BROWSER_SMOKE') === '1';
