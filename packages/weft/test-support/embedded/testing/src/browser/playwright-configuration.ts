import { defineConfig, devices, type PlaywrightTestConfig, type Project } from '@playwright/test';
import { resolve } from 'node:path';

import { HANG_GUARD_MILLISECONDS } from '../hang-guard.ts';
import { browserPorts } from './browser-ports.ts';

/**
 * The per-test deadline of every blocking lane, twice the hang guard, as `scripts/test-deadlines.ts`
 * sets it for the Bun lanes and the root suite's configuration names it.
 */
const TEST_TIMEOUT_MILLISECONDS = 2 * HANG_GUARD_MILLISECONDS;

export type PackageSuiteConfiguration = {
  /** The package's `browser/` directory, beside `harness.ts`, `tests/` and `snapshots/`. */
  root: string;
  /** Projects besides `chromium`, which every suite has and `test:browser` runs alone. */
  projects?: Project[];
};

/**
 * The Playwright configuration of a package's browser suite (COR-2080). It picks a run-local port,
 * so suites of several packages run side by side, starts the package's fixture host
 * (`bun harness.ts serve`), and keeps the root suite's snapshot layout, deadlines and Chromium
 * project, so a baseline moved from `scripts/browser-fixtures/snapshots` matches unchanged.
 */
export function packageSuiteConfiguration(
  configuration: PackageSuiteConfiguration,
): PlaywrightTestConfig {
  // Playwright forces color in its workers and web servers. Remove the conflicting inherited
  // opt-out in this test process before those children are created.
  delete process.env['NO_COLOR'];
  const { FIXTURE_PORT } = browserPorts(['FIXTURE_PORT']);
  const origin = `http://127.0.0.1:${FIXTURE_PORT}`;
  // The suite's own manifest and host, whatever an outer shell exported for another suite.
  process.env['BROWSER_FIXTURE_URL'] = origin;
  process.env['BROWSER_FIXTURE_MANIFEST'] = resolve(
    configuration.root,
    '.playwright',
    'manifest.json',
  );
  return defineConfig({
    testDir: resolve(configuration.root, 'tests'),
    outputDir: resolve(configuration.root, 'test-results'),
    snapshotPathTemplate: '{testDir}/../snapshots/{projectName}/{platform}/{arg}{ext}',
    testMatch: '**/*.{spec,playwright}.ts',
    timeout: TEST_TIMEOUT_MILLISECONDS,
    expect: { timeout: HANG_GUARD_MILLISECONDS },
    use: { baseURL: origin, trace: 'retain-on-failure' },
    webServer: {
      command: `bun harness.ts serve --port ${FIXTURE_PORT}`,
      cwd: configuration.root,
      url: `${origin}/ready`,
      reuseExistingServer: false,
      // Readiness is `/ready` answering, bounded only by the hang guard: a busy host starts the
      // fixture server slowly, never wrongly (COR-2305).
      timeout: HANG_GUARD_MILLISECONDS,
    },
    projects: [
      { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
      ...(configuration.projects ?? []),
    ],
  });
}
