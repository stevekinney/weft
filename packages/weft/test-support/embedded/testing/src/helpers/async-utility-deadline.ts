import { HANG_GUARD_MILLISECONDS } from '../hang-guard.ts';

/**
 * Give Testing Library's asynchronous utilities (`findBy*`, `findAllBy*`, `waitFor`,
 * `waitForElementToBeRemoved`) the hang guard as their default deadline, in place of the one
 * second they start with.
 *
 * One second is a performance bound, and a host running several test runs at once breaks it at
 * random: the element a test is waiting for arrives, but later than a loaded machine allows. The
 * awaited element either appears or never will, so the wait needs only a hang guard, and a
 * healthy run never spends it. Call this from every preload that installs DOM globals, after
 * `setupHappyDom()`. A test file never passes a shorter `timeout`;
 * `scripts/check-load-sensitive-deadlines.ts` rejects one.
 */
export async function configureAsyncUtilityDeadline(): Promise<void> {
  const { configure } = await import('@testing-library/svelte');
  configure({ asyncUtilTimeout: HANG_GUARD_MILLISECONDS });
}
