/**
 * Single source of truth bridge: the canonical hello-world workflow and activity
 * live in the consumer example `examples/hello-world/src/index.ts` (which imports
 * from the published `weft` package). In-repo tests (`src/examples.test.ts`) and
 * the CLI smoke harness (`scripts/cli-smoke-main.ts`) re-export them from here
 * rather than keeping a second copy, so the fixture can never drift from the
 * example a consumer actually sees.
 *
 * This is not a backwards-compat barrel — it exists only to bridge the import-path
 * gap (the example uses `from 'weft'`; in-repo callers need a relative path). The
 * `.test-support.ts` suffix keeps it out of the build (`dist/`).
 */
export { formatGreetingActivity, helloWorldWorkflow } from '../examples/hello-world/src/index.ts';
