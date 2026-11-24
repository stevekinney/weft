import { afterEach, describe, expect, it, jest } from 'bun:test';

import { restoreRealTimers, useFakeTimers } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { settleInlineLaunches } from './inline-launch-settle.test-support.ts';

describe('settleInlineLaunches', () => {
  afterEach(() => {
    restoreRealTimers();
  });

  it('advances the virtual clock by the ten milliseconds the one-turn pause used to', async () => {
    useFakeTimers(new Date('2026-01-01T00:00:00.000Z'));
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 10);

    await settleInlineLaunches();

    expect(jest.isFakeTimers()).toBe(true);
    expect(fired).toBe(true);
  });

  it('returns at once under real timers when no engine has a launch scheduled', async () => {
    // An engine that has not started anything has nothing scheduled, so there is nothing to wait for.
    await settleInlineLaunches();
    expect(jest.isFakeTimers()).toBe(false);
  });
});
