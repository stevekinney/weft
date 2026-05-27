import { expect, jest } from 'bun:test';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const DEFAULT_MICROTASK_TURNS = 3;

/**
 * Enable Bun fake timers for the current test.
 *
 * Tests that exercise production timers should call this before constructing
 * the timer-owning object so scheduled callbacks are controlled by Bun's fake
 * clock from the start.
 */
export function useFakeTimers(now?: Date | number): void {
  jest.useFakeTimers();

  if (now !== undefined) {
    jest.setSystemTime(now);
  }
}

/** Restore real timers and clear any fake timers left by the current test. */
export function restoreRealTimers(): void {
  if (!jest.isFakeTimers()) return;

  jest.clearAllTimers();
  jest.useRealTimers();
}

/** Let promise continuations and queued microtasks settle without advancing time. */
export async function flushMicrotasks(turns = DEFAULT_MICROTASK_TURNS): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

/**
 * Advance Bun fake timers, then drain promise continuations that timer
 * callbacks may have queued.
 */
export async function advanceTimersByTime(milliseconds: number): Promise<void> {
  assertNonNegativeMilliseconds(milliseconds);

  if (!jest.isFakeTimers()) {
    useFakeTimers();
  }

  jest.advanceTimersByTime(milliseconds);
  await flushMicrotasks();
}

/**
 * Test-only replacement for raw `Bun.sleep`.
 *
 * A zero-duration sleep is only a microtask drain. A positive duration advances
 * the fake clock, so the suite does not spend wall-clock time waiting.
 */
export async function sleepForTesting(milliseconds: number): Promise<void> {
  assertNonNegativeMilliseconds(milliseconds);

  if (milliseconds === 0) {
    await flushMicrotasks();
    return;
  }

  if (jest.isFakeTimers()) {
    await advanceTimersByTime(milliseconds);
    return;
  }

  // Integration-style tests sometimes use this helper to let external
  // server/socket work breathe. Do not wait the requested wall-clock duration;
  // yield one minimal scheduler turn so real timers are not starved.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
}

/**
 * Wait for real production timers.
 *
 * Use this only in integration tests that intentionally exercise real server,
 * socket, or retry timers. Timer-unit tests should use `useFakeTimers()` and
 * `advanceTimersByTime()` instead.
 */
export async function waitForRealTimersForTesting(milliseconds: number): Promise<void> {
  assertNonNegativeMilliseconds(milliseconds);

  if (jest.isFakeTimers()) {
    throw new Error(
      'waitForRealTimersForTesting() requires real timers; use advanceTimersByTime() while fake timers are enabled.',
    );
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
  await flushMicrotasks();
}

/** Yield one event-loop turn, then drain continuations scheduled during that turn. */
export async function yieldToEventLoop(): Promise<void> {
  if (jest.isFakeTimers()) {
    await advanceTimersByTime(0);
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await flushMicrotasks();
}

/** Create a promise whose settlement is controlled by the test. */
export function createDeferred<T = void>(): Deferred<T> {
  let resolveDeferred!: Deferred<T>['resolve'];
  let rejectDeferred!: Deferred<T>['reject'];

  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

/** Return a never-settling promise without allocating a timer. */
export function waitForever(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * Race a promise against a timeout. In fake-timer tests, callers must advance
 * the fake clock for the timeout branch to fire.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label = 'operation',
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out after ${milliseconds}ms waiting for ${label}`));
    }, milliseconds);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Wait until an observable condition is true.
 *
 * Use this for event-driven tests where the exact delay is irrelevant. The
 * timeout is a failure guard; the helper returns as soon as the condition is
 * satisfied.
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 500,
    intervalMs = 1,
    label = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  assertNonNegativeMilliseconds(timeoutMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`intervalMs must be a finite, positive number, got: ${intervalMs}`);
  }

  if (jest.isFakeTimers()) {
    return waitForConditionWithFakeTimers(predicate, timeoutMs, intervalMs, label);
  }

  return waitForConditionWithRealTimers(predicate, timeoutMs, intervalMs, label);
}

async function waitForConditionWithFakeTimers(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<void> {
  let lastError: unknown;
  let elapsed = 0;

  while (elapsed <= timeoutMs) {
    const result = await checkWaitCondition(predicate);
    if (result.satisfied) {
      return;
    }
    lastError = result.error;

    await advanceTimersByTime(intervalMs);
    elapsed += intervalMs;
  }

  throw createWaitConditionTimeoutError(timeoutMs, label, lastError);
}

async function waitForConditionWithRealTimers(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<void> {
  let lastError: unknown;
  const start = performance.now();

  while (true) {
    const result = await checkWaitCondition(predicate);
    if (result.satisfied) {
      return;
    }
    lastError = result.error;

    const remainingMilliseconds = timeoutMs - (performance.now() - start);
    if (remainingMilliseconds <= 0) {
      const finalResult = await checkWaitCondition(predicate);
      if (finalResult.satisfied) {
        return;
      }
      lastError = finalResult.error ?? lastError;
      break;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, remainingMilliseconds));
    });
  }

  throw createWaitConditionTimeoutError(timeoutMs, label, lastError);
}

async function checkWaitCondition(
  predicate: () => boolean | Promise<boolean>,
): Promise<{ satisfied: true } | { satisfied: false; error?: unknown }> {
  try {
    return (await predicate()) ? { satisfied: true } : { satisfied: false };
  } catch (error) {
    return { satisfied: false, error };
  }
}

function createWaitConditionTimeoutError(
  timeoutMs: number,
  label: string,
  lastError: unknown,
): Error {
  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  return lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}

function assertNonNegativeMilliseconds(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      `milliseconds must be a finite, non-negative number, got: ${milliseconds}`,
    );
  }
}

/** Assert that a promise has not settled after pending microtasks drain. */
export async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;

  void promise.finally(() => {
    settled = true;
  });

  await flushMicrotasks();
  expect(settled).toBe(false);
}
