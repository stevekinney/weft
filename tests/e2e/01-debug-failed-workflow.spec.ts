/**
 * Persona flow (a): debug-a-failed-workflow (plan §11.4).
 *
 * list → filter failed → detail → read failure-category explanation →
 * timeline step expansion → events export menu.
 *
 * Read-only apart from clicking the (idempotent, purely client-side)
 * timeline step-selection toggle and triggering a download — this spec
 * must run before `05-bulk-retry-confirm.spec.ts`, which retries every
 * `status:failed` workflow and would remove the `payment-failing` fixture
 * this spec locates by name (see `playwright.config.ts`'s module doc).
 */
import { expect, test } from './auth-fixtures.ts';

test('operator finds, reads, and exports a failed workflow', async ({ page, checkA11y }) => {
  await page.goto('/workflows');
  // Gate the first axe check behind the real screen, not the lazy-route
  // boot skeleton `page.goto()`'s `load` event resolves under — an
  // ungated check here audits whatever DOM happens to be present the
  // instant `load` fires, which in this SPA is `route-outlet.svelte`'s
  // placeholder, not the list.
  await expect(page.getByRole('table', { name: 'Workflows' })).toBeVisible();
  await checkA11y('workflow list');

  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Failed' })
    .click();

  const failedRow = page.getByRole('row', { name: /payment-failing/ });
  await expect(failedRow).toBeVisible();
  await failedRow.getByRole('link').click();

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(
    page.getByText(
      'The workflow or an activity threw an error that did not match a timeout, cancellation, resource, or system failure.',
    ),
  ).toBeVisible();
  await checkA11y('workflow detail — overview (failure explanation)');

  await page.getByRole('tab', { name: 'Timeline' }).click();
  // Scoped to the first step's stable `<li>` (a Cinder `RunStepTimeline`
  // row, keyed by class/position, not text). Cinder's own
  // `selection-control` button (WFC-7: adopted from `RunStepTimeline`'s
  // public selection API) is a `pointer-events: none` overlay that exists
  // for keyboard/AT interaction only — its `aria-label` stays
  // `Select <step>` and only its `aria-pressed` flips on click. Real
  // pointer clicks land on the row's visible content and are delegated to
  // the same `onStepSelect` handler by a click listener Cinder attaches to
  // the `<li>` itself (see `run-step-timeline.svelte`'s
  // `createStepSelectionAttachment`/`isInteractiveDescendant`), so click
  // the visible label rather than the (intentionally unclickable-by-mouse)
  // button.
  const firstStep = page.locator('li.cinder-run-step-timeline__item').first();
  const stepToggle = firstStep.getByRole('button', { name: /^Select/ });
  await expect(stepToggle).toBeVisible();
  await expect(stepToggle).toHaveAttribute('aria-pressed', 'false');
  await firstStep.locator('.cinder-run-step-timeline__label').first().click();
  await expect(stepToggle).toHaveAttribute('aria-pressed', 'true');
  // The linked-selection chip is rendered by `timeline-tab.svelte` as a
  // page-level sibling of `RunStepTimeline`, not inside the step `<li>`.
  await expect(page.getByText('Selected — Events filtered to this step')).toBeVisible();
  await checkA11y('workflow detail — timeline (step selected)');

  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(page.getByText('step: ')).toBeVisible();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await checkA11y('workflow detail — events (download menu open)');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Event history · JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-events-.*\.json$/);
});
