/**
 * Playwright + axe E2E configuration (plan §11.4). Boots two servers before
 * any spec runs: a dedicated, fully-scoped weft server
 * (`tests/e2e/e2e-server.ts` — see its module doc for why this isn't
 * `scripts/dev-server.ts`) and Vite pointed at it via the documented
 * `WEFT_API_BASE_URL` override (`vite.config.ts`: "Override with
 * `WEFT_API_BASE_URL` to point the dev console at a different server
 * without editing this file").
 *
 * ## Sequential, single-worker, numbered spec files
 *
 * All five persona-flow specs share ONE seeded server for the whole run —
 * spinning up a fresh `serve()` + fixture seed per spec would be slow and
 * isn't how the plan frames this ("Runs against a seeded real server",
 * singular). That means specs are NOT isolated from each other: flow (c)
 * (bulk-retry-with-type-to-confirm) retries every currently-`failed`
 * workflow matching `status:failed`, which would retry away the very
 * `payment-failing` run flow (a) (debug-a-failed-workflow) depends on
 * finding in the list. `fullyParallel: false` + `workers: 1` make execution
 * order deterministic, and the spec filenames are numbered so (a)'s
 * read-only flow always runs before (c)'s destructive one — see each spec's
 * module doc for its own cross-flow notes. A fresh `bun run test:e2e`
 * invocation still boots a brand-new server (and re-seeds from scratch)
 * every time, so back-to-back full-suite runs (the flake-check requirement)
 * never see carried-over mutation from a previous run.
 */
import { defineConfig, devices } from '@playwright/test';

import { E2E_BASE_URL, E2E_CONSOLE_PORT, E2E_SERVER_PORT } from './tests/e2e/e2e-constants.ts';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env['CI'] ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'on-first-retry',
    // Cinder collapses animation/transition durations to 0ms under
    // `prefers-reduced-motion` (plan §12's accessibility budget), which
    // also removes a class of pure animation-timing flake from these
    // flows — no fixed sleeps needed to wait out a transition.
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'bun tests/e2e/e2e-server.ts',
      port: E2E_SERVER_PORT,
      reuseExistingServer: !process.env['CI'],
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // `-- --port` forwards through the `dev` script's plain `vite`
      // command (`package.json`) rather than duplicating its Svelte/proxy
      // config in a second invocation — `E2E_CONSOLE_PORT` keeps this off
      // the interactive `bun run dev`'s default 5173 so both can run at
      // once.
      command: `bun run dev -- --port ${E2E_CONSOLE_PORT}`,
      url: E2E_BASE_URL,
      reuseExistingServer: !process.env['CI'],
      env: {
        WEFT_API_BASE_URL: `http://localhost:${E2E_SERVER_PORT}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
