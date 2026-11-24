import { describe, expect, it, jest, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { advanceTimersByTime, useFakeTimers } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { Scheduler } from './scheduler-class.ts';

function createScheduler(pollIntervalMs: number): Scheduler {
  useFakeTimers(Date.UTC(2026, 0, 1));
  return new Scheduler({ storage: new MemoryStorage(), onTimerFired: () => {}, pollIntervalMs });
}

describe('Scheduler.setPollInterval', () => {
  it.each([[0], [-5], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rejects an interval that is not a positive safe integer (%p)',
    (interval) => {
      const scheduler = createScheduler(1_000);
      expect(() => scheduler.setPollInterval(interval)).toThrow(RangeError);
    },
  );

  it('leaves a stopped scheduler unarmed and starts it at the new interval', async () => {
    const scheduler = createScheduler(1_000);
    const tick = spyOn(scheduler, 'tick').mockResolvedValue(undefined);
    scheduler.start();
    await scheduler.stop();
    const timersBefore = jest.getTimerCount();

    scheduler.setPollInterval(100);
    expect(jest.getTimerCount()).toBe(timersBefore);

    scheduler.start();
    await advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it('re-arms a running scheduler once, at the new interval', async () => {
    const scheduler = createScheduler(1_000);
    const tick = spyOn(scheduler, 'tick').mockResolvedValue(undefined);
    scheduler.start();
    const timersBefore = jest.getTimerCount();

    scheduler.setPollInterval(250);

    expect(jest.getTimerCount()).toBe(timersBefore);
    await advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });
});
