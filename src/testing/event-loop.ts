/**
 * Let promise continuations and queued microtasks settle without advancing time
 * or yielding a full event-loop turn. Awaits `Promise.resolve()` `turns` times,
 * which is enough to drain chained `.then()` continuations. Use it when a test
 * needs queued microtasks to run but does not need a macrotask boundary.
 *
 * @example
 * ```ts
 * import { flushPortableMicrotasks } from '@lostgradient/weft/testing';
 *
 * let ran = false;
 * void Promise.resolve().then(() => {
 *   ran = true;
 * });
 * await flushPortableMicrotasks();
 * console.log(ran); // true
 * ```
 */
export async function flushPortableMicrotasks(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

/**
 * Yield one full event-loop turn without importing test-runner-only timer APIs,
 * then drain microtasks. Prefers a `MessageChannel` postMessage (a macrotask)
 * and falls back to `setTimeout(0)` where `MessageChannel` is unavailable.
 *
 * Use it in an `afterEach` to drain a prior test's deferred inline workflow
 * launch: under a shared-process runner (Bun, Jest, Vitest), an engine disposed
 * mid-workflow can leave a queued inline start that would otherwise starve the
 * next test's timers.
 *
 * @example
 * ```ts
 * import { afterEach } from 'bun:test';
 * import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
 *
 * afterEach(yieldToPortableEventLoop);
 * ```
 */
export async function yieldToPortableEventLoop(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  await flushPortableMicrotasks();
}
