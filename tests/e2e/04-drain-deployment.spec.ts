/**
 * Persona flow (e): drain-a-deployment (plan §11.4).
 *
 * workers → deployment group → drain with reason → status drains → resume.
 *
 * `tests/e2e/e2e-server.ts` registers one real `RemoteWorker` under
 * `E2E_DEPLOYMENT_NAME` (`e2e-constants.ts`) purely as fleet inventory —
 * this spec drains it and then resumes it, leaving the fleet in its
 * original `Healthy` state for any later run against the same server
 * process (immaterial across separate `bun run test:e2e` invocations,
 * since each boots a fresh server, but keeps this spec idempotent within
 * one run too).
 */
import { expect, test } from './auth-fixtures.ts';
import { E2E_DEPLOYMENT_NAME } from './e2e-constants.ts';

test('operator drains and resumes a worker deployment', async ({ page, checkA11y }) => {
  await page.goto('/workers');
  const deploymentRow = page.getByRole('listitem').filter({ hasText: E2E_DEPLOYMENT_NAME });
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content, not the boot
  // skeleton `page.goto()`'s `load` event resolves under.
  await expect(deploymentRow).toBeVisible();
  await checkA11y('workers — fleet overview');

  await expect(deploymentRow.getByText('Healthy')).toBeVisible();

  await deploymentRow.getByRole('button', { name: 'Drain' }).click();
  const dialog = page.getByRole('dialog', { name: 'Drain deployment' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(E2E_DEPLOYMENT_NAME)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('e2e rolling deploy verification');
  await checkA11y('workers — drain deployment dialog');

  await dialog.getByRole('button', { name: 'Drain deployment' }).click();
  await expect(dialog).not.toBeVisible();

  // The E2E fleet worker never has in-flight work (`e2e-server.ts` never
  // dispatches it a task), so the engine has nothing to wait out and
  // transitions straight to `drained` rather than a transient `draining`
  // (`worker-presentation.ts`'s `deploymentHealthPresentation`: `draining`
  // only outranks `drained` when the deployment is still mid-drain).
  // Verified live against a real drain call before writing this assertion.
  await expect(deploymentRow.getByText('Drained')).toBeVisible();
  await checkA11y('workers — fleet overview (deployment drained)');

  await deploymentRow.getByRole('button', { name: 'Resume' }).click();
  await expect(deploymentRow.getByText('Healthy')).toBeVisible();
  await checkA11y('workers — fleet overview (deployment resumed)');
});
