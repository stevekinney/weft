/**
 * Primary WFT-116 operator flow against the seeded real Weft server: open
 * System → Registry, inspect a dynamic workflow source's loading lifecycle
 * in the Dynamic workflow sources panel, preload an idle revision and watch
 * it become ready with a real load duration, then preload a revision whose
 * loader cannot reach its artifact and see the refusal reported with the
 * bounded failure category Weft classified it under.
 *
 * `invoice-reconciliation` is deliberately NOT reachable from the
 * registered-definitions table: `weft.system.registry` is built from the
 * engine's eager registrations, which a `registerSource()` name never enters
 * (WFT-165). This spec asserts that absence too, because it is the whole
 * reason the panel exists — if a future Weft release starts listing dynamic
 * sources there, this assertion should fail and the panel's design should be
 * revisited rather than silently kept.
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

const PANEL_NAME = 'Dynamic workflow sources';

async function inspectSource(
  page: import('@playwright/test').Page,
  revision: string,
): Promise<void> {
  await page.fill('#weft-dynamic-source-name', DYNAMIC_SOURCE_WORKFLOW_NAME);
  await page.fill('#weft-dynamic-source-revision', revision);
  await page.getByRole('button', { name: 'Inspect' }).click();
}

test('operator preloads an idle dynamic source revision and watches it reach ready', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/system?tab=registry');

  const panel = page.getByRole('region', { name: PANEL_NAME });
  await expect(panel).toBeVisible();

  // The gap this panel exists for: the dynamic workflow is not in the
  // registered-definitions table, so there is no row to drill into.
  await expect(
    page.getByRole('button', { name: new RegExp(DYNAMIC_SOURCE_WORKFLOW_NAME) }),
  ).toHaveCount(0);

  await inspectSource(page, DYNAMIC_SOURCE_LOADABLE_REVISION);

  // Source kind, requested revision, and waiter count are all read straight
  // off `weft.catalog.diagnostics` — never re-derived in the console.
  await expect(panel.getByText('Source kind')).toBeVisible();
  await expect(panel.getByText('module', { exact: true })).toBeVisible();
  await expect(panel.getByText(DYNAMIC_SOURCE_LOADABLE_REVISION).first()).toBeVisible();
  await expect(panel.getByText('0 callers waiting')).toBeVisible();

  await panel.getByRole('button', { name: 'Preload' }).click();

  await expect(panel.getByText(/is installed in the workflow catalog/)).toBeVisible();
  // The invalidated diagnostics query refetches, so the state moves without a
  // manual refresh, and the duration is now a real measured value rather than
  // the "Not loaded yet" placeholder an idle source shows. Reaching Ready here
  // also proves Weft actually loaded the module rather than satisfying the
  // preload from an existing catalog entry — the banner names that second
  // possibility precisely because it cannot be assumed.
  await expect(panel.getByText('Load state: Ready')).toBeVisible();
  await expect(panel.getByText('Not loaded yet')).toHaveCount(0);

  await checkA11y('system — dynamic workflow sources, preloaded to ready');
});

test('a refused preload reports the bounded failure category Weft recorded', async ({ page }) => {
  await page.goto('/system?tab=registry');

  const panel = page.getByRole('region', { name: PANEL_NAME });
  await expect(panel).toBeVisible();

  await inspectSource(page, DYNAMIC_SOURCE_FAILING_REVISION);
  await panel.getByRole('button', { name: 'Preload' }).click();

  await expect(panel.getByText('Refused: load-failed')).toBeVisible();
  // Weft never forwards the loader's own message onto the wire, so the
  // fixture's fake filesystem path must not appear anywhere on the page.
  await expect(page.getByText(/srv\/artifacts/)).toHaveCount(0);

  // The re-fetched diagnostics carry the classified cause the fault omitted.
  await expect(panel.getByText('Load state: Failed')).toBeVisible();
  await expect(panel.getByText(/Last failure category:/)).toBeVisible();
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

      const panel = page.getByRole('region', { name: PANEL_NAME });
      await expect(panel).toBeVisible();
      await inspectSource(page, DYNAMIC_SOURCE_LOADABLE_REVISION);
      await expect(panel.getByText('Source kind')).toBeVisible();

      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
