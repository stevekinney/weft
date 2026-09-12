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
  await expect(revisionsPanel.getByText('Active', { exact: true })).toBeVisible();
  // `{ exact: true }` — a substring match would also hit the "Installed at"
  // meta term sitting right next to the "Installed" badge in the same row.
  await expect(revisionsPanel.getByText('Installed', { exact: true })).toBeVisible();
  await expect(revisionsPanel.getByRole('button', { name: 'Refresh' })).toBeVisible();

  // WFT-116: every row mounts per-revision load diagnostics. `order-processing`
  // has no dynamic source, and — importantly — the copy claims only that,
  // never how the revision was registered: `order-processing-candidate-2` is
  // installed via `weft.workflows.revisions.install` with no in-process
  // handler behind it, so "registered eagerly" would be false for it.
  await expect(
    revisionsPanel.getByText(/No dynamic source is registered for this workflow/).first(),
  ).toBeVisible();

  const activateButton = revisionsPanel.getByRole('button', { name: 'Activate' });
  await expect(activateButton).toBeVisible();
  await activateButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('order-processing-candidate-2', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Activate' }).click();

  // Scoped to the outcome banner's own `role="alert"` region rather than
  // the whole page — the dialog's own description text also contains the
  // word "incompatible" (lowercase, case-insensitive substring match) and
  // could otherwise still be mid-unmount when this assertion runs.
  const outcomeBanner = page.getByRole('alert').filter({ hasText: 'Incompatible' });
  await expect(outcomeBanner).toBeVisible();
  await expect(outcomeBanner.getByText('Incompatible', { exact: true })).toBeVisible();
  await expect(outcomeBanner.getByText(/contract-hash-mismatch/)).toBeVisible();
  await expect(outcomeBanner.getByText(/workflow-version-incompatible/)).toBeVisible();
  await expect(outcomeBanner.getByText(/artifact-revision-mismatch/)).toBeVisible();

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
      // `{ exact: true }` — a substring match would also hit the "Activate"
      // button's own text node.
      await expect(revisionsPanel.getByText('Active', { exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
