import { jest } from 'bun:test';

/**
 * Tracks real timers so a test run can fail when one outlives the tests that
 * armed it.
 *
 * A leaked real timer keeps firing into every later test file in the same
 * `bun test` process. Under Bun's fake timers, a real interval that fires at a
 * real event-loop turn is re-armed as a fake timer and inflates
 * `jest.getTimerCount()` (COR-1339), and any leaked timer keeps its closure,
 * often a whole engine, alive. `tests/test-preload.ts` installs one tracker on
 * `globalThis` and asserts in `afterAll`, which Bun runs once per process after
 * every file's own hooks.
 */

type TimerHandle = unknown;
type TimerCallback = (...args: unknown[]) => unknown;

/** The four timer functions a tracker wraps. `globalThis` satisfies this. */
export type TimerGlobals = {
  setTimeout: (callback: TimerCallback, delay?: number, ...args: unknown[]) => TimerHandle;
  setInterval: (callback: TimerCallback, delay?: number, ...args: unknown[]) => TimerHandle;
  clearTimeout: (handle?: TimerHandle) => void;
  clearInterval: (handle?: TimerHandle) => void;
};

export type LiveRealTimer = {
  kind: 'timeout' | 'interval';
  delay: number | undefined;
  /** Creation stack frames, innermost first, with the tracker's own frames removed. */
  frames: readonly string[];
};

/** A named reason to ignore matching live timers. */
export type RealTimerExemption = {
  reason: string;
  matches: (timer: LiveRealTimer) => boolean;
};

export type RealTimerTracker = {
  install(): void;
  uninstall(): void;
  live(): readonly LiveRealTimer[];
  /** Live timers after one real event-loop turn, less any exempt ones. */
  leaked(exemptions?: readonly RealTimerExemption[]): Promise<readonly LiveRealTimer[]>;
  /** Throws, listing each leaked timer's creation stack, when {@link leaked} finds any. */
  assertNoLeaks(exemptions?: readonly RealTimerExemption[]): Promise<void>;
};

const TRACKER_FRAME = 'real-timer-leak-guard.test-support.ts';
const MAX_REPORTED_FRAMES = 8;

/**
 * A timer's identity for bookkeeping. Bun's `Timer` objects convert to their
 * numeric id, and `clearTimeout` accepts either form, so both must map to the
 * same entry.
 */
function timerKey(handle: TimerHandle): TimerHandle {
  if (typeof handle === 'object' && handle !== null && Symbol.toPrimitive in handle) {
    return Number(handle);
  }
  return handle;
}

function creationFrames(): string[] {
  return (new Error().stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(TRACKER_FRAME))
    .slice(0, MAX_REPORTED_FRAMES);
}

function describeTimer(timer: LiveRealTimer): string {
  const delay = timer.delay === undefined ? '' : `${timer.delay}ms`;
  const frames = timer.frames.map((frame) => `      ${frame}`).join('\n');
  return `  ${timer.kind}(${delay}) created\n${frames}`;
}

export function createRealTimerTracker(
  target: TimerGlobals = globalThis as unknown as TimerGlobals,
  isFakeTimers: () => boolean = () => jest.isFakeTimers(),
  restoreRealTimers: () => void = () => jest.useRealTimers(),
): RealTimerTracker {
  const native = {
    setTimeout: target.setTimeout,
    setInterval: target.setInterval,
    clearTimeout: target.clearTimeout,
    clearInterval: target.clearInterval,
  };
  const live = new Map<TimerHandle, LiveRealTimer>();
  let installed = false;

  function setTimeout(callback: TimerCallback, delay?: number, ...args: unknown[]): TimerHandle {
    if (isFakeTimers() || typeof callback !== 'function') {
      return native.setTimeout.call(target, callback, delay, ...args);
    }
    const frames = creationFrames();
    let key: TimerHandle = undefined;
    const handle = native.setTimeout.call(
      target,
      (...callbackArgs: unknown[]) => {
        live.delete(key);
        return callback(...callbackArgs);
      },
      delay,
      ...args,
    );
    key = timerKey(handle);
    live.set(key, { kind: 'timeout', delay, frames });
    return handle;
  }

  function setInterval(callback: TimerCallback, delay?: number, ...args: unknown[]): TimerHandle {
    const handle = native.setInterval.call(target, callback, delay, ...args);
    if (!isFakeTimers() && typeof callback === 'function') {
      live.set(timerKey(handle), { kind: 'interval', delay, frames: creationFrames() });
    }
    return handle;
  }

  function clearTimeout(handle?: TimerHandle): void {
    live.delete(timerKey(handle));
    native.clearTimeout.call(target, handle);
  }

  function clearInterval(handle?: TimerHandle): void {
    live.delete(timerKey(handle));
    native.clearInterval.call(target, handle);
  }

  async function leaked(
    exemptions: readonly RealTimerExemption[] = [],
  ): Promise<readonly LiveRealTimer[]> {
    // The settle turn needs a real timer, so fake timers left on would hang it.
    if (isFakeTimers()) restoreRealTimers();
    // One real turn lets a timer that is already due (a 0 ms flush, say) fire
    // instead of being reported as a leak.
    await new Promise<void>((resolve) => {
      native.setTimeout.call(target, () => resolve(), 0);
    });
    return [...live.values()].filter(
      (timer) => !exemptions.some((exemption) => exemption.matches(timer)),
    );
  }

  return {
    install() {
      if (installed) return;
      installed = true;
      Object.assign(target, { setTimeout, setInterval, clearTimeout, clearInterval });
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      Object.assign(target, native);
    },
    live() {
      return [...live.values()];
    },
    leaked,
    async assertNoLeaks(exemptions = []) {
      const found = await leaked(exemptions);
      if (found.length === 0) return;
      throw new Error(
        `${found.length} real timer(s) outlived the tests that armed them. Clear each ` +
          'timer, or dispose or shut down whatever owns it, before the test ends:\n' +
          found.map(describeTimer).join('\n'),
      );
    },
  };
}
