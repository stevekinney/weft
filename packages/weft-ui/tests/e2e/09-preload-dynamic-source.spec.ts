/**
 * Primary WFT-116 operator flow against the seeded real Weft server: open
 * System → Registry, inspect a dynamic workflow source's loading lifecycle
 * in the Dynamic workflow sources panel, preload an idle revision and watch
 * it become ready with a real load duration, then preload a revision whose
 * loader cannot reach its artifact and see the refusal reported with the
 * bounded failure category Weft classified it under.
 *
 * `invoice-reconciliation` is selectable from `weft.catalog.sources.list`
 * while still absent from the registered-definitions table:
 * `weft.system.registry` is built from the engine's eager registrations,
 * which a `registerSource()` name never enters.
 *
 * ## Ordering
 *
 * A successful preload installs durably, so unlike
 * `07-activate-workflow-revision.spec.ts`'s refused activation this flow is
 * not a no-op against the shared seeded server. The tests below therefore
 * assert on end states that hold whether or not a previous run already
 * preloaded (`Ready` either way), never on a pristine `Idle` row.
 */
import { expect, test } from './auth-fixtures.ts';

import {
  DYNAMIC_SOURCE_FAILING_REVISION,
  DYNAMIC_SOURCE_LOADABLE_REVISION,
  DYNAMIC_SOURCE_WORKFLOW_NAME,
} from '../../fixtures/dynamic-sources.ts';
import { E2E_API_KEY } from './e2e-constants.ts';

const PANEL_NAME = 'Dynamic workflow sources';

async function inspectSource(
  page: import('@playwright/test').Page,
  revision: string,
): Promise<void> {
  const panel = page.getByRole('region', { name: PANEL_NAME, exact: true });
  await panel
    .getByRole('row')
    .filter({ hasText: JSON.stringify(revision) })
    .getByRole('button', { name: 'Select' })
    .click();
}

function diagnosticsRegion(page: import('@playwright/test').Page) {
  return page.getByRole('group', { name: 'Source load diagnostics' });
}

test('operator preloads an idle dynamic source revision and watches it reach ready', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/system?tab=registry');

  const panel = page.getByRole('region', { name: PANEL_NAME, exact: true });
  await expect(panel).toBeVisible();

  await expect(
    panel.getByRole('row').filter({ hasText: JSON.stringify(DYNAMIC_SOURCE_LOADABLE_REVISION) }),
  ).toBeVisible();

  // Dynamic sources are selectable above, but still absent from the eager
  // registry table because `weft.system.registry` lists eager registrations.
  const workflowDefinitions = page.getByRole('table', { name: 'Workflow definitions' });
  await expect(
    workflowDefinitions.getByRole('button', { name: new RegExp(DYNAMIC_SOURCE_WORKFLOW_NAME) }),
  ).toHaveCount(0);

  await inspectSource(page, DYNAMIC_SOURCE_LOADABLE_REVISION);
  const diagnostics = diagnosticsRegion(page);

  // Source kind, requested revision, and waiter count are all read straight
  // off `weft.catalog.diagnostics` — never re-derived in the console.
  await expect(diagnostics.getByText('Source kind')).toBeVisible();
  await expect(diagnostics.getByText('module', { exact: true })).toBeVisible();
  await expect(diagnostics.getByText(DYNAMIC_SOURCE_LOADABLE_REVISION)).toBeVisible();
  await expect(diagnostics.getByText('0 callers waiting')).toBeVisible();

  await panel.getByRole('button', { name: 'Preload' }).click();

  await expect(panel.getByText(/is installed in the workflow catalog/)).toBeVisible();
  // The invalidated diagnostics query refetches, so the state moves without a
  // manual refresh, and the duration is now a real measured value rather than
  // the "Not loaded yet" placeholder an idle source shows. Reaching Ready here
  // also proves Weft actually loaded the module rather than satisfying the
  // preload from an existing catalog entry — the banner names that second
  // possibility precisely because it cannot be assumed.
  await expect(diagnostics.getByText('Load state: Ready')).toBeVisible();
  await expect(diagnostics.getByText('Not loaded yet')).toHaveCount(0);

  await checkA11y('system — dynamic workflow sources, preloaded to ready');
});

test('a refused preload reports the bounded failure category Weft recorded', async ({ page }) => {
  await page.goto('/system?tab=registry');

  const panel = page.getByRole('region', { name: PANEL_NAME, exact: true });
  await expect(panel).toBeVisible();

  await inspectSource(page, DYNAMIC_SOURCE_FAILING_REVISION);
  const diagnostics = diagnosticsRegion(page);
  await panel.getByRole('button', { name: 'Preload' }).click();

  await expect(panel.getByText('Refused: load-failed')).toBeVisible();
  // Weft never forwards the loader's own message onto the wire, so the
  // fixture's fake filesystem path must not appear anywhere on the page.
  await expect(page.getByText(/srv\/artifacts/)).toHaveCount(0);

  // The re-fetched diagnostics carry the classified cause the fault omitted.
  await expect(diagnostics.getByText('Load state: Failed')).toBeVisible();
  await expect(diagnostics.getByText(/Last failure category:/)).toBeVisible();
});

test('expired diagnostics credentials return to API-key entry and accept a replacement', async ({
  page,
}) => {
  let diagnosticsRequests = 0;
  await page.route('**/jsonrpc', async (route) => {
    const requestBody = route.request().postData() ?? '';
    if (!requestBody.includes('weft.catalog.diagnostics')) {
      await route.continue();
      return;
    }
    diagnosticsRequests += 1;
    if (diagnosticsRequests === 1) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/system?tab=registry');
  const panel = page.getByRole('region', { name: PANEL_NAME, exact: true });
  await expect(panel).toBeVisible();
  await inspectSource(page, DYNAMIC_SOURCE_LOADABLE_REVISION);

  await expect(page.getByRole('heading', { name: 'Authentication required' })).toBeVisible();
  await expect(page.getByLabel('API key')).toBeVisible();

  await page.getByLabel('API key').fill(E2E_API_KEY);
  await page.getByRole('button', { name: 'Continue' }).click();

  // The replacement mounts a new shell and the retried diagnostics request
  // can be made against the new shell with the newly entered key.
  await expect(page.getByRole('region', { name: PANEL_NAME, exact: true })).toBeVisible();
  await inspectSource(page, DYNAMIC_SOURCE_LOADABLE_REVISION);
  await expect(diagnosticsRegion(page).getByText('Source kind')).toBeVisible();
  expect(diagnosticsRequests).toBe(2);
});

test('the Dynamic workflow sources panel is usable across supported widths and themes', async ({
  page,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      await page.goto('/system?tab=registry');

      const panel = page.getByRole('region', { name: PANEL_NAME, exact: true });
      await expect(panel).toBeVisible();
      await inspectSource(page, DYNAMIC_SOURCE_LOADABLE_REVISION);
      await expect(diagnosticsRegion(page).getByText('Source kind')).toBeVisible();

      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth, `${theme} theme at ${viewport.width}px`).toBeLessThanOrEqual(
        viewport.width,
      );
    }
  }
});
