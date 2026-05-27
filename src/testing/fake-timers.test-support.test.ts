import { afterEach, describe, expect, it, jest } from 'bun:test';

import {
  advanceTimersByTime,
  createDeferred,
  expectPromisePending,
  flushMicrotasks,
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
  waitForCondition,
  waitForRealTimersForTesting,
  waitForever,
  withTimeout,
  yieldToEventLoop,
} from './fake-timers.test-support.ts';

describe('fake timer testing helpers', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('advances setTimeout callbacks without wall-clock waiting', async () => {
    useFakeTimers(new Date('2026-01-01T00:00:00.000Z'));

    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 250);

    await advanceTimersByTime(249);
    expect(fired).toBe(false);

    await advanceTimersByTime(1);
    expect(fired).toBe(true);
  });

  it('advanceTimersByTime enables fake timers when they are not already active', async () => {
    expect(jest.isFakeTimers()).toBe(false);

    await advanceTimersByTime(0);

    expect(jest.isFakeTimers()).toBe(true);
  });

  it('advances Bun sleep promises through the fake clock', async () => {
    useFakeTimers(new Date('2026-01-01T00:00:00.000Z'));

    const bunSleep = Bun.sleep;
    let resolved = false;
    const promise = bunSleep(100).then(() => {
      resolved = true;
    });

    await advanceTimersByTime(99);
    expect(resolved).toBe(false);

    await advanceTimersByTime(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('drains microtasks without advancing timers', async () => {
    useFakeTimers();

    let microtaskRan = false;
    let timerRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    setTimeout(() => {
      timerRan = true;
    }, 0);

    await flushMicrotasks();

    expect(microtaskRan).toBe(true);
    expect(timerRan).toBe(false);
  });

  it('creates controlled deferred promises', async () => {
    const deferred = createDeferred<string>();

    await expectPromisePending(deferred.promise);
    deferred.resolve('done');

    await expect(deferred.promise).resolves.toBe('done');
  });

  it('creates never-settling promises without timers', async () => {
    await expectPromisePending(waitForever());
  });

  it('sleepForTesting advances positive durations', async () => {
    useFakeTimers();

    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 10);

    await sleepForTesting(10);

    expect(fired).toBe(true);
  });

  it('sleepForTesting does not spend wall-clock time when fake timers are inactive', async () => {
    let fired = false;
    const timeout = setTimeout(() => {
      fired = true;
    }, 25);

    await sleepForTesting(25);

    expect(fired).toBe(false);
    clearTimeout(timeout);
  });

  it('yieldToEventLoop runs zero-delay timers and their continuations', async () => {
    useFakeTimers();

    let continuationRan = false;
    setTimeout(() => {
      void Promise.resolve().then(() => {
        continuationRan = true;
      });
    }, 0);

    await yieldToEventLoop();

    expect(continuationRan).toBe(true);
  });

  it('yieldToEventLoop runs real zero-delay timers and their continuations', async () => {
    let continuationRan = false;

    setTimeout(() => {
      void Promise.resolve().then(() => {
        continuationRan = true;
      });
    }, 0);

    await yieldToEventLoop();

    expect(continuationRan).toBe(true);
  });

  it('waitForRealTimersForTesting fails fast when fake timers are enabled', async () => {
    useFakeTimers();

    await expect(waitForRealTimersForTesting(1)).rejects.toThrow(
      'waitForRealTimersForTesting() requires real timers',
    );
  });

  it('waitForCondition times out under fake timers', async () => {
    useFakeTimers();

    await expect(
      waitForCondition(() => false, { timeoutMs: 10, intervalMs: 5, label: 'never true' }),
    ).rejects.toThrow('Timed out after 10ms waiting for never true');
  });

  it('withTimeout rejects when the timeout wins', async () => {
    useFakeTimers();

    const timed = withTimeout(waitForever(), 10, 'stalled operation');

    await advanceTimersByTime(10);

    await expect(timed).rejects.toThrow('Timed out after 10ms waiting for stalled operation');
  });

  it('waitForCondition retries after predicate errors under fake timers', async () => {
    useFakeTimers();

    let attempts = 0;
    setTimeout(() => {
      attempts = 2;
    }, 5);

    await waitForCondition(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('not yet');
      }

      return attempts >= 3;
    });
  });

  it('waitForCondition validates intervalMs', async () => {
    await expect(waitForCondition(() => true, { intervalMs: 0 })).rejects.toThrow(
      'intervalMs must be a finite, positive number',
    );
  });

  it('waitForCondition includes the last real-timer predicate error in timeout failures', async () => {
    await expect(
      waitForCondition(
        () => {
          throw new Error('still waiting');
        },
        { timeoutMs: 5, intervalMs: 1, label: 'real timers' },
      ),
    ).rejects.toThrow('Timed out after 5ms waiting for real timers: still waiting');
  });

  it('waitForCondition checks the predicate at the real-timer timeout boundary', async () => {
    const startedAt = performance.now();

    await waitForCondition(() => performance.now() - startedAt >= 5, {
      intervalMs: 50,
      label: 'real timer boundary',
      timeoutMs: 5,
    });
  });

  it('waitForCondition returns a plain real-timer timeout when the predicate never throws', async () => {
    await expect(
      waitForCondition(() => false, { timeoutMs: 5, intervalMs: 1, label: 'plain timeout' }),
    ).rejects.toThrow('Timed out after 5ms waiting for plain timeout');
  });

  it('rejects negative timer durations', async () => {
    await expect(advanceTimersByTime(-1)).rejects.toThrow(
      'milliseconds must be a finite, non-negative number',
    );
  });
});
