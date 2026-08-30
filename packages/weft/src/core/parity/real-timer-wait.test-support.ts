import { waitForRealTimersForTesting } from '../../testing/fake-timers.test-support.ts';

export async function waitForParityCondition(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 2_000,
    intervalMs = 5,
    label = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await waitForRealTimersForTesting(intervalMs);
  }
  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}
