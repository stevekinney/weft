/**
 * Persona flow (d): create-and-backfill-schedule (plan §11.4).
 *
 * schedules → create slide-over → ScheduleBuilder cron → overlap policy →
 * backfill warning → save → detail shows next fires.
 *
 * Purely additive (creates one new schedule); safe anywhere in the run
 * order relative to the other flows.
 */
import { expect, test } from './auth-fixtures.ts';

test('operator creates a cron schedule with backfill and lands on its detail', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/schedules');
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content, not the boot
  // skeleton `page.goto()`'s `load` event resolves under.
  await expect(page.getByRole('button', { name: 'Create schedule' })).toBeVisible();
  await checkA11y('schedules list');

  await page.getByRole('button', { name: 'Create schedule' }).click();
  const drawer = page.getByRole('dialog', { name: 'Create schedule' });
  await expect(drawer).toBeVisible();

  // The "Workflow type" field starts as a free-text `Input` and swaps to a
  // registry-backed `Select` once `weft.system.registry` resolves
  // (`schedule-form-fields.svelte`'s `workflowTypeOptions !== undefined`
  // branch) — wait for the real combobox rather than racing that swap.
  const workflowTypeField = drawer.getByRole('combobox', { name: 'Workflow type' });
  await expect(workflowTypeField).toBeVisible();
  await workflowTypeField.selectOption('order-processing');

  await drawer.getByRole('tab', { name: 'Cron' }).click();
  // Cinder 0.22 restructured ScheduleBuilder's cron tab: the five raw
  // textboxes became per-field structured editors — a "<Field> pattern"
  // Select plus numeric value inputs, with raw expressions demoted to a
  // per-field "Advanced raw expression" disclosure. Author `0 3 * * *`
  // through the structured UI: Minute and Hour get "Specific value"
  // patterns; Day of month / Month / Day of week keep their seeded
  // "Every value (*)" defaults, so they need no interaction at all.
  await drawer.getByLabel('Minute pattern').selectOption('specific');
  await drawer.getByRole('spinbutton', { name: 'Minute value', exact: true }).fill('0');
  await drawer.getByLabel('Hour pattern').selectOption('specific');
  await drawer.getByRole('spinbutton', { name: 'Hour value', exact: true }).fill('3');

  // `RadioGroup` renders a native `<fieldset>` (implicit `role="group"`,
  // legend as the accessible name) — distinct from `SegmentedControl`'s
  // `role="radiogroup"` used for the overall/section review decisions in
  // `02-approve-review-partial.spec.ts`.
  await drawer
    .getByRole('group', { name: 'If a run is still going when the next fire is due' })
    .getByRole('radio', { name: /Skip/i })
    .click();

  const backfillToggle = drawer.getByRole('switch', { name: 'Backfill missed occurrences' });
  await backfillToggle.click();
  await expect(
    drawer.getByText(
      'If the schedule falls behind (for example, the engine was down), missed occurrences fire immediately in a bounded catch-up window instead of being skipped.',
    ),
  ).toBeVisible();
  await checkA11y('schedules — create slide-over (backfill warning shown)');

  await drawer.getByRole('button', { name: 'Create schedule' }).click();
  await expect(drawer).not.toBeVisible();

  await expect(page).toHaveURL(/\/schedules\?id=/);
  await expect(page.getByText('Next 5 fires')).toBeVisible();
  await expect(page.getByText('Not scheduled')).toHaveCount(0);
  await expect(page.locator('.weft-schedule-detail__fires-list li').first()).toBeVisible();
  await checkA11y('schedule detail — next fires populated');
});
