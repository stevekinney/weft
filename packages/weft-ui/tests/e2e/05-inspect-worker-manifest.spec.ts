/** Primary WFC-17 operator flow against the seeded real Weft server. */
import { expect, test } from './auth-fixtures.ts';

test('operator inspects a server-accepted canonical worker manifest', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/workers?tab=list');

  const workerLink = page.getByRole('link', { name: 'e2e-flee…er-1' });
  await expect(workerLink).toBeVisible();
  await workerLink.click();

  const manifest = page.getByRole('region', { name: 'Canonical manifest' });
  await expect(manifest).toBeVisible();
  await expect(manifest.getByText('Ready · server accepted')).toBeVisible();
  await expect(manifest.getByText('e2e-build-1')).toBeVisible();
  await expect(manifest.getByText('checkout-worker-fleet')).toBeVisible();
  await expect(manifest.getByText('order-processing')).toBeVisible();
  await expect(manifest.getByText('Wire protocol')).toBeVisible();
  await expect(manifest.getByText('Accepted manifest')).toBeVisible();

  await checkA11y('workers — canonical worker manifest detail');
});

test('canonical manifest remains usable across supported widths and themes', async ({ page }) => {
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
      await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');

      const manifest = page.getByRole('region', { name: 'Canonical manifest' });
      await expect(manifest).toBeVisible();
      await expect(manifest.getByText('Ready · server accepted')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
