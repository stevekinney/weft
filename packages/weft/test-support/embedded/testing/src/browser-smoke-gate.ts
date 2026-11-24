/**
 * The shared opt-in gate for every suite that drives a real Chromium process.
 *
 * Four suites — `indexeddb-browser` (in `@lostgradient/storage-indexeddb`),
 * `web-extension-browser` (in `@lostgradient/storage-web-extension`),
 * `service-worker/service-worker-browser`, and `client/http-client-browser` (in
 * `@lostgradient/weft`) — launch Playwright against a real browser. Their cost is not a constant: a Chromium launch, an unpacked
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
 * bun run --filter=@lostgradient/storage-indexeddb test:browser
 * bun run --filter=@lostgradient/storage-web-extension test:browser
 * ```
 *
 * Browser provisioning is `bunx playwright install chromium` (once).
 *
 * Applied as `describe.skipIf(!browserSmokeEnabled)`, which suppresses the
 * suite's `beforeAll`/`afterAll` hooks as well as its tests — the hook is where
 * the browser actually launches, so gating the tests alone would not help.
 *
 * The flag is read through this package's registered environment boundary
 * (`environment-configuration.ts`) rather than off `Bun.env`. A test-only flag
 * does not belong in a production configuration schema, so it lives here, in the
 * testing package, and not in Weft's runtime configuration.
 */

import { environmentConfiguration } from './environment-configuration.ts';

/** True only when `WEFT_BROWSER_SMOKE=1` asks for the real-browser suites. */
export const browserSmokeEnabled = environmentConfiguration().weftBrowserSmoke === '1';
