import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { waitForParityCondition } from './real-timer-wait.test-support.ts';

describe('waitForParityCondition', () => {
  it('uses its default budget, interval and label when given no options', async () => {
    let attempt = 0;

    expect(await waitForParityCondition(() => (attempt += 1) > 2)).toBeUndefined();
    expect(attempt).toBe(3);
  });

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
        { intervalMs: 1 },
      ),
    ).toBeUndefined();
  });

  it('includes the last predicate error in timeout failures', async () => {
    expect(
      await throwingRejectionOf(
        // hang-guard-self-test: the predicate never succeeds, so no load can satisfy the wait
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
        // hang-guard-self-test: the predicate is never true, so no load can satisfy the wait
        waitForParityCondition(() => false, { intervalMs: 1, label: 'idle parity', timeoutMs: 50 }),
      ),
    ).toThrow('Timed out after 50ms waiting for idle parity');
  });
});
