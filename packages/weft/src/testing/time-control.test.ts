import { afterEach, describe, expect, it } from 'bun:test';

import { TimeControl } from './time-control';

describe('TimeControl', () => {
  let clock: TimeControl;

  afterEach(() => {
    clock?.reset();
  });

  it('uses a reasonable default start time', () => {
    const before = Date.now();
    clock = new TimeControl();
    const after = Date.now();
    expect(clock.now).toBeGreaterThanOrEqual(before);
    expect(clock.now).toBeLessThanOrEqual(after);
  });

  it('accepts a custom start time', () => {
    clock = new TimeControl(1000);
    expect(clock.now).toBe(1000);
  });

  it('advances time by a numeric duration', async () => {
    clock = new TimeControl(0);
    await clock.advance(5000);
    expect(clock.now).toBe(5000);
  });

  it('advances time by a string duration', async () => {
    clock = new TimeControl(0);
    await clock.advance('1 hour');
    expect(clock.now).toBe(3_600_000);
  });

  it('advances to a specific timestamp', async () => {
    clock = new TimeControl(1000);
    await clock.advanceTo(5000);
    expect(clock.now).toBe(5000);
  });

  it('throws when advanceTo targets the past', async () => {
    clock = new TimeControl(5000);
    let threw = false;
    try {
      await clock.advanceTo(3000);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('fires a timer when time advances past its fireAt', async () => {
    clock = new TimeControl(0);
    let fired = false;
    clock.schedule(3000, () => {
      fired = true;
    });
    await clock.advance(5000);
    expect(fired).toBe(true);
  });

  it('fires multiple timers in chronological order', async () => {
    clock = new TimeControl(0);
    const order: number[] = [];
    clock.schedule(3000, () => {
      order.push(3000);
    });
    clock.schedule(1000, () => {
      order.push(1000);
    });
    clock.schedule(2000, () => {
      order.push(2000);
    });
    await clock.advance(5000);
    expect(order).toEqual([1000, 2000, 3000]);
  });

  it('does not fire a timer if time has not advanced far enough', async () => {
    clock = new TimeControl(0);
    let fired = false;
    clock.schedule(5000, () => {
      fired = true;
    });
    await clock.advance(3000);
    expect(fired).toBe(false);
  });

  it('does not fire a cancelled timer', async () => {
    clock = new TimeControl(0);
    let fired = false;
    const cancel = clock.schedule(2000, () => {
      fired = true;
    });
    cancel();
    await clock.advance(5000);
    expect(fired).toBe(false);
  });

  it('reports the correct pendingTimerCount', () => {
    clock = new TimeControl(0);
    expect(clock.pendingTimerCount).toBe(0);
    clock.schedule(1000, () => {});
    clock.schedule(2000, () => {});
    expect(clock.pendingTimerCount).toBe(2);
  });

  it('returns the earliest timer time via nextTimerAt', () => {
    clock = new TimeControl(0);
    expect(clock.nextTimerAt).toBeUndefined();
    clock.schedule(5000, () => {});
    clock.schedule(2000, () => {});
    expect(clock.nextTimerAt).toBe(2000);
  });

  it('awaits async timer callbacks', async () => {
    clock = new TimeControl(0);
    let resolved = false;
    clock.schedule(1000, async () => {
      await Promise.resolve();
      resolved = true;
    });
    await clock.advance(2000);
    expect(resolved).toBe(true);
  });

  it('clears timers and resets time on reset()', async () => {
    clock = new TimeControl(0);
    clock.schedule(1000, () => {});
    await clock.advance(500);
    clock.reset(100);
    expect(clock.now).toBe(100);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('sets now to the timer fireAt time when the callback executes', async () => {
    clock = new TimeControl(0);
    let timeAtFire: number | undefined;
    clock.schedule(3000, () => {
      timeAtFire = clock.now;
    });
    await clock.advance(5000);
    expect(timeAtFire).toBe(3000);
    expect(clock.now).toBe(5000);
  });
});
