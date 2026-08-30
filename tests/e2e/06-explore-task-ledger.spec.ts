/** Primary WFC-18 operator flow against a real, seeded durable Weft task ledger. */
import { expect, test } from './auth-fixtures.ts';
import { E2E_TASK_OPERATION_ID } from './e2e-constants.ts';

test('operator inspects a seeded authoritative task ledger', async ({ page, checkA11y }) => {
  await page.goto(`/workers?tab=diagnostics&task=${E2E_TASK_OPERATION_ID}`);

  await expect(page.getByRole('heading', { name: 'Authoritative task ledger' })).toBeVisible();
  await expect(page.getByText(E2E_TASK_OPERATION_ID)).toBeVisible();
  await expect(page.getByText('queued')).toBeVisible();
  await expect(page.getByText('Available · attempt 1 of 3')).toBeVisible();
  await expect(page.getByText('traceparent')).toBeVisible();
  await expect(page.getByText('No heartbeat recorded')).toBeVisible();

  await checkA11y('workers—authoritative delayed task ledger');
});

test('task ledger remains usable at supported widths in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-console-theme', selectedTheme);
      }, theme);
      await page.goto(`/workers?tab=diagnostics&task=${E2E_TASK_OPERATION_ID}`);

      await expect(page.getByRole('heading', { name: 'Authoritative task ledger' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
