/**
 * Primary WFT-115 operator flow against the seeded real Weft server: open
 * System → Registry, drill into `order-processing` (seeded with a second,
 * deliberately incompatible installed revision —
 * `fixtures/workflow-revisions.ts`), see the Revisions panel distinguish
 * the active seeded revision from the installed candidate, attempt to
 * Activate the candidate, and see the incompatible outcome with every
 * bounded reason rendered as explicit text.
 */
import { expect, test } from './auth-fixtures.ts';

test('operator inspects installed revisions and sees a refused activation report every bounded reason', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/system?tab=registry');

  const orderProcessingRow = page.getByRole('button', { name: /order-processing/ });
  await expect(orderProcessingRow).toBeVisible();
  await orderProcessingRow.click();

  const revisionsPanel = page.getByRole('region', { name: 'Installed revisions' });
  await expect(revisionsPanel).toBeVisible();
  await expect(revisionsPanel.getByText('Active')).toBeVisible();
  await expect(revisionsPanel.getByText('Installed')).toBeVisible();
  await expect(revisionsPanel.getByRole('button', { name: 'Refresh' })).toBeVisible();

  const activateButton = revisionsPanel.getByRole('button', { name: 'Activate' });
  await expect(activateButton).toBeVisible();
  await activateButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('order-processing-candidate-2', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Activate' }).click();

  await expect(page.getByText('Incompatible')).toBeVisible();
  await expect(page.getByText(/contract-hash-mismatch/)).toBeVisible();
  await expect(page.getByText(/workflow-version-incompatible/)).toBeVisible();
  await expect(page.getByText(/artifact-revision-mismatch/)).toBeVisible();

  await checkA11y('system — registry revisions panel, refused activation');
});

test('the Revisions panel is usable across supported widths and themes', async ({ page }) => {
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

      const orderProcessingRow = page.getByRole('button', { name: /order-processing/ });
      await expect(orderProcessingRow).toBeVisible();
      await orderProcessingRow.click();

      const revisionsPanel = page.getByRole('region', { name: 'Installed revisions' });
      await expect(revisionsPanel).toBeVisible();
      await expect(revisionsPanel.getByText('Active')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
