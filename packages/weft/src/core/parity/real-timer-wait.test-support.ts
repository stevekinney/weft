import { waitForRealTimersForTesting } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { HANG_GUARD_MILLISECONDS, afterAwakeTime } from "../../../test-support/embedded/testing/src/hang-guard.ts";

/**
 * Poll `predicate` on real timers until it holds. The deadline is the awake-time hang guard, so a
 * host that is merely busy never fails the wait; a test of this helper's own deadline passes a
 * shorter `timeoutMs` for a predicate that never succeeds.
 */
export async function waitForParityCondition(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = HANG_GUARD_MILLISECONDS,
    intervalMs = 5,
    label = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  let lastError: unknown;
  let expired = false;
  const cancel = afterAwakeTime(timeoutMs, () => {
    expired = true;
  });
  try {
    while (!expired) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await waitForRealTimersForTesting(intervalMs);
    }
  } finally {
    cancel();
  }
  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}
