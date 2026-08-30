/**
 * Persona flow (b): approve-a-review-with-partial-sections (plan §11.4).
 *
 * inbox → partial section decisions → submit → decided archive.
 *
 * Targets `fixtures/reviews.ts`'s `content-review` specimens — both of the
 * currently-pending ones carry `artifact.sections` (headline/body/
 * callToAction) regardless of their own `allowPartial` value (section
 * rendering is driven purely by artifact shape —
 * `review-domain.ts`'s `extractReviewSections`), so this locates any
 * pending review whose type badge reads "content" rather than a specific
 * document title, which the row itself never renders.
 */
import { expect, test } from './auth-fixtures.ts';

const REVIEWER = 'e2e-operator';
const FEEDBACK = 'Tighten the call to action; the rest reads well.';

test('operator decides a sectioned review with a mixed partial outcome', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/reviews');
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content, not the boot
  // skeleton `page.goto()`'s `load` event resolves under.
  await expect(page.getByRole('radiogroup', { name: 'Review state' })).toBeVisible();
  await checkA11y('reviews inbox');

  const pendingContentReview = page.getByRole('button', { name: /content/ }).first();
  await expect(pendingContentReview).toBeVisible();
  await pendingContentReview.click();

  await expect(page.getByText('Section decisions')).toBeVisible();

  await page
    .getByRole('radiogroup', { name: 'Headline decision' })
    .getByRole('radio', { name: 'Approve' })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Body decision' })
    .getByRole('radio', { name: 'Approve' })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Call to action decision' })
    .getByRole('radio', { name: 'Reject' })
    .click();

  // A mixed section outcome auto-suggests "Changes" (needs-changes) —
  // `review-domain.ts`'s `suggestOverallDecision` — which is exactly the
  // partial-decision scenario this flow exercises, so the overall picker
  // is left on its suggestion rather than touched.
  await expect(
    page.getByRole('radiogroup', { name: 'Overall decision' }).getByRole('radio', {
      name: 'Changes',
      checked: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Suggested from sections')).toBeVisible();

  await page.getByRole('textbox', { name: 'Reviewer' }).fill(REVIEWER);
  await page.getByRole('textbox', { name: /^Feedback/ }).fill(FEEDBACK);
  await checkA11y('reviews inbox — decision form (partial sections)');

  await page.getByRole('button', { name: 'Submit decision' }).click();

  await page
    .getByRole('radiogroup', { name: 'View' })
    .getByRole('radio', { name: 'Archive' })
    .click();

  const archivedRow = page.getByRole('row', { name: new RegExp(REVIEWER) });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow.getByText('Needs changes')).toBeVisible();
  await checkA11y('reviews archive');
});
