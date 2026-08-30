import { describe, expect, it, jest } from 'bun:test';

/**
 * Regression guard for the test-isolation safety net in `tests/test-preload.ts`.
 *
 * `jest.useFakeTimers()` traps `Bun.sleep`. Because the CI suite runs
 * sequentially in one process, a file that installs fake timers and fails to
 * restore them (a teardown step throwing before `restoreRealTimers()`) leaks the
 * fake clock into the next test, where any `await Bun.sleep(...)` then never
 * settles and the test hangs to its timeout. This is the exact mechanism that
 * intermittently hung `engine.startOrSignal > retries the create when a caller-id
 * winner aborts before its durable commit` (its `awaitReservationCleared` awaits
 * `Bun.sleep(5)`).
 *
 * The preload registers a global `afterEach(restoreRealTimers)` that runs after
 * each test's own teardown, so a leaked clock is always cleaned up before the
 * next test. These two tests run in declared order in the same file, and the
 * global `afterEach` fires between them — so the second test proves the net
 * works: the first deliberately leaks fake timers (no local restore), and the
 * second observes real timers restored and a real `Bun.sleep` that settles.
 *
 * Without the net, the second test would hang at `Bun.sleep(5)` and time out.
 */
describe('fake-timer test isolation (preload safety net)', () => {
  it('a test may leave fake timers installed (the failure mode being guarded)', () => {
    jest.useFakeTimers();
    // Intentionally do NOT restore here — simulate a teardown that threw before
    // reaching restoreRealTimers(). The global afterEach in the preload must
    // clean this up before the next test runs.
    expect(jest.isFakeTimers()).toBe(true);
  });

  it('the next test sees real timers and Bun.sleep settles', async () => {
    // If the global afterEach did not run, fake timers would still be installed
    // here and the awaited Bun.sleep below would never settle (hang to timeout).
    expect(jest.isFakeTimers()).toBe(false);
    await Bun.sleep(5);
    expect(jest.isFakeTimers()).toBe(false);
  });
});
