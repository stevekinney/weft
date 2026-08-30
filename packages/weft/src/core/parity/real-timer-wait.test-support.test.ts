import { describe, expect, it } from 'bun:test';

import { waitForParityCondition } from './real-timer-wait.test-support.ts';

describe('waitForParityCondition', () => {
  it('keeps polling after predicate errors until the condition becomes true', async () => {
    let attempt = 0;

    await expect(
      waitForParityCondition(
        async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error('transient');
          }
          return attempt > 2;
        },
        { intervalMs: 1, timeoutMs: 200 },
      ),
    ).resolves.toBeUndefined();
  });

  it('includes the last predicate error in timeout failures', async () => {
    await expect(
      waitForParityCondition(
        () => {
          throw new Error('still failing');
        },
        { intervalMs: 1, label: 'parity check', timeoutMs: 50 },
      ),
    ).rejects.toThrow('Timed out after 50ms waiting for parity check: still failing');
  });

  it('times out with the label when the predicate never succeeds', async () => {
    await expect(
      waitForParityCondition(() => false, { intervalMs: 1, label: 'idle parity', timeoutMs: 50 }),
    ).rejects.toThrow('Timed out after 50ms waiting for idle parity');
  });
});
