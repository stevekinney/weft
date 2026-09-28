import { afterEach, describe, expect, it, jest } from 'bun:test';

import {
  createRealTimerTracker,
  type RealTimerTracker,
  type TimerGlobals,
} from './real-timer-leak-guard.test-support.ts';

/**
 * Each test drives its own tracker over its own target object, so it neither
 * depends on nor disturbs the process-wide tracker `tests/test-preload.ts`
 * installs on `globalThis`. Every timer a test arms is cleared before it ends.
 */
function freshTarget(): TimerGlobals {
  const g = globalThis as unknown as TimerGlobals;
  return {
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    clearTimeout: g.clearTimeout,
    clearInterval: g.clearInterval,
  };
}

const armed: Array<() => void> = [];

afterEach(() => {
  for (const clear of armed.splice(0)) clear();
});

function trackerOver(
  target: TimerGlobals,
  options: { fake?: () => boolean; restore?: () => void } = {},
): RealTimerTracker {
  const tracker = createRealTimerTracker(
    target,
    options.fake ?? (() => false),
    options.restore ?? (() => {}),
  );
  tracker.install();
  armed.push(() => tracker.uninstall());
  return tracker;
}

describe('createRealTimerTracker', () => {
  it('reports a timeout still pending, with its delay and a frame in the arming file', async () => {
    const target = freshTarget();
    const tracker = trackerOver(target);
    const handle = target.setTimeout(() => {}, 60_000);
    armed.push(() => target.clearTimeout(handle));

    const leaked = await tracker.leaked();

    expect(leaked).toHaveLength(1);
    expect(leaked[0]?.kind).toBe('timeout');
    expect(leaked[0]?.delay).toBe(60_000);
    expect(leaked[0]?.frames.join('\n')).toContain('real-timer-leak-guard.test-support.test.ts');
  });

  it('reports an interval until it is cleared', async () => {
    const target = freshTarget();
    const tracker = trackerOver(target);
    const handle = target.setInterval(() => {}, 60_000);
    armed.push(() => target.clearInterval(handle));

    const whileArmed = await tracker.leaked();
    expect(whileArmed.map((timer) => timer.kind)).toEqual(['interval']);

    target.clearInterval(handle);
    expect(await tracker.leaked()).toEqual([]);
  });

  it('forgets a timeout once it fires', async () => {
    const target = freshTarget();
    const tracker = trackerOver(target);
    const fired = Promise.withResolvers<void>();
    target.setTimeout(() => fired.resolve(), 1);

    await fired.promise;

    expect(tracker.live()).toEqual([]);
  });

  it('forgets a timer cleared by its numeric id as well as by its handle', async () => {
    const target = freshTarget();
    const tracker = trackerOver(target);
    const byHandle = target.setTimeout(() => {}, 60_000);
    const byId = target.setInterval(() => {}, 60_000);
    armed.push(() => {
      target.clearTimeout(byHandle);
      target.clearInterval(byId);
    });

    target.clearTimeout(byHandle);
    target.clearInterval(Number(byId));

    expect(await tracker.leaked()).toEqual([]);
  });

  it('does not track a timer armed while fake timers are on', async () => {
    const target = freshTarget();
    let fake = true;
    const tracker = trackerOver(target, { fake: () => fake });
    const timeout = target.setTimeout(() => {}, 60_000);
    const interval = target.setInterval(() => {}, 60_000);
    armed.push(() => {
      target.clearTimeout(timeout);
      target.clearInterval(interval);
    });
    fake = false;

    expect(await tracker.leaked()).toEqual([]);
  });

  it('does not report a 0 ms timeout that is already due, because the settle turn lets it fire', async () => {
    const target = freshTarget();
    const tracker = trackerOver(target);
    let fired = false;
    target.setTimeout(() => {
      fired = true;
    }, 0);

    expect(await tracker.leaked()).toEqual([]);
    expect(fired).toBe(true);
  });

  it('restores real timers before the settle turn when fake timers are still on', async () => {
    const target = freshTarget();
    let fake = true;
    let restored = 0;
    const tracker = trackerOver(target, {
      fake: () => fake,
      restore: () => {
        restored += 1;
        fake = false;
      },
    });

    expect(await tracker.leaked()).toEqual([]);
    expect(restored).toBe(1);
  });

  it('omits exempt timers, and assertNoLeaks lists the rest with their creation frames', async () => {
    const target = freshTarget();
    const tracker = trackerOver(target);
    const exempt = target.setInterval(() => {}, 12_345);
    const leakedHandle = target.setTimeout(() => {}, 54_321);
    armed.push(() => {
      target.clearInterval(exempt);
      target.clearTimeout(leakedHandle);
    });
    const exemptions = [
      { reason: 'test', matches: (timer: { delay: number | undefined }) => timer.delay === 12_345 },
    ];

    const error = await tracker.assertNoLeaks(exemptions).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('1 real timer(s) outlived the tests that armed them');
    expect(message).toContain('timeout(54321ms) created');
    expect(message).toContain('real-timer-leak-guard.test-support.test.ts');
    expect(message).not.toContain('12345ms');

    target.clearTimeout(leakedHandle);
    await tracker.assertNoLeaks(exemptions);
  });

  it('by default reads Bun fake-timer state and restores real timers before the settle turn', async () => {
    const target = freshTarget();
    const tracker = createRealTimerTracker(target);
    tracker.install();
    armed.push(() => tracker.uninstall());
    jest.useFakeTimers();

    expect(await tracker.leaked()).toEqual([]);
    expect(jest.isFakeTimers()).toBe(false);
  });

  it('install and uninstall are idempotent and restore the original functions', () => {
    const target = freshTarget();
    const original = { ...target };
    const tracker = createRealTimerTracker(
      target,
      () => false,
      () => {},
    );

    tracker.install();
    tracker.install();
    expect(target.setTimeout).not.toBe(original.setTimeout);

    tracker.uninstall();
    tracker.uninstall();
    expect(target).toEqual(original);
  });

  it('passes a non-function callback through without tracking it', async () => {
    const target = freshTarget();
    const calls: unknown[][] = [];
    const recording: TimerGlobals = {
      ...target,
      setTimeout: (...args: unknown[]) => {
        calls.push(args);
        return 1;
      },
      setInterval: (...args: unknown[]) => {
        calls.push(args);
        return 2;
      },
    };
    const tracker = trackerOver(recording);

    recording.setTimeout('not a function' as never, 10);
    recording.setInterval('not a function' as never, 10);

    expect(calls).toHaveLength(2);
    expect(tracker.live()).toEqual([]);
  });
});
