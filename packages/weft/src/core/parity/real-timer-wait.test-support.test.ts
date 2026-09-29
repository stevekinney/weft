import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { waitForParityCondition } from './real-timer-wait.test-support.ts';

describe('waitForParityCondition', () => {
  it('keeps polling after predicate errors until the condition becomes true', async () => {
    let attempt = 0;

    expect(
      await waitForParityCondition(
        async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error('transient');
          }
          return attempt > 2;
        },
        { intervalMs: 1, timeoutMs: 200 },
      ),
    ).toBeUndefined();
  });

  it('includes the last predicate error in timeout failures', async () => {
    expect(
      await throwingRejectionOf(
        waitForParityCondition(
          () => {
            throw new Error('still failing');
          },
          { intervalMs: 1, label: 'parity check', timeoutMs: 50 },
        ),
      ),
    ).toThrow('Timed out after 50ms waiting for parity check: still failing');
  });

  it('times out with the label when the predicate never succeeds', async () => {
    expect(
      await throwingRejectionOf(
        waitForParityCondition(() => false, { intervalMs: 1, label: 'idle parity', timeoutMs: 50 }),
      ),
    ).toThrow('Timed out after 50ms waiting for idle parity');
  });
});
