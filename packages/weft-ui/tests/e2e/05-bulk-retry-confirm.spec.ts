/**
 * Persona flow (c): bulk-retry-with-type-to-confirm (plan §11.4).
 *
 * list → select-all-matching-filter → retry-failed → dry-run count shown →
 * type-to-confirm → progress → success.
 *
 * **Runs last.** `weft.workflows.bulk.retryfailed` acts on every workflow
 * currently matching `status:failed`, filter-scoped — not the checked rows
 * (`bulk-selection-bar.svelte`'s module doc) — so this spec retries away
 * the `payment-failing` fixture `01-debug-failed-workflow.spec.ts` depends
 * on finding in the `Failed` filter. `playwright.config.ts` pins the
 * single-worker, filename-ordered execution this relies on.
 *
 * The exact matched count is read off the dialog itself (`Operates on all
 * N matching workflow…`) rather than hardcoded — the fixture set's current
 * failure count is an implementation detail of `fixtures/*.ts` this spec
 * shouldn't need to track.
 */
import { expect, test } from './auth-fixtures.ts';

test('operator bulk-retries every failed workflow with type-to-confirm', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/workflows');

  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Failed' })
    .click();
  await expect(page.getByRole('row', { name: /payment-failing/ })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select all rows' }).click();
  const bulkBar = page.getByText('Bulk actions operate on the full filtered set');
  await expect(bulkBar).toBeVisible();

  await page.getByRole('checkbox', { name: /^Select all \d+ matching the filter$/ }).click();
  await checkA11y('workflow list — bulk selection bar (all matching selected)');

  await page.getByRole('button', { name: 'Retry failed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bulk retry failed' });
  await expect(dialog).toBeVisible();

  const lead = dialog.getByText(/Operates on all/);
  await expect(lead).toBeVisible();
  const leadText = (await lead.textContent()) ?? '';
  const matched = Number(/Operates on all\s+(\d+)\s+matching/.exec(leadText)?.[1]);
  expect(matched).toBeGreaterThan(0);

  const confirmPhrase = `retry ${matched} workflow${matched === 1 ? '' : 's'}`;
  const confirmInput = dialog.getByRole('textbox', { name: `Type "${confirmPhrase}" to confirm` });
  await expect(confirmInput).toBeVisible();
  await checkA11y('workflow list — bulk retry dialog (preview, type-to-confirm)');

  await confirmInput.fill(confirmPhrase);
  await dialog.getByRole('button', { name: new RegExp(`^Retry ${matched} workflow`) }).click();

  await expect(dialog.getByRole('progressbar', { name: /in progress/ })).toBeVisible();
  await expect(
    dialog.getByText("Please keep this open until it finishes. Closing this doesn't cancel"),
  ).toBeVisible();
  await checkA11y('workflow list — bulk retry dialog (committing)');

  await expect(dialog.getByText('Done')).toBeVisible();
  await checkA11y('workflow list — bulk retry dialog (result)');

  // `exact: true` disambiguates from the modal's own "Close dialog" icon
  // button, which `name: 'Close'` otherwise fuzzy-matches as a substring.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
