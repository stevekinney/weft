import { describe, expect, it } from 'bun:test';

import { flushPortableMicrotasks, yieldToPortableEventLoop } from './event-loop';
import * as testingBarrel from './index';

describe('flushPortableMicrotasks', () => {
  it('lets queued microtasks settle before resolving', async () => {
    const order: string[] = [];
    void Promise.resolve().then(() => order.push('microtask'));
    await flushPortableMicrotasks();
    expect(order).toEqual(['microtask']);
  });

  it('accepts a custom number of turns', async () => {
    await expect(flushPortableMicrotasks(1)).resolves.toBeUndefined();
  });
});

describe('yieldToPortableEventLoop', () => {
  it('resolves after yielding a turn, with microtasks drained', async () => {
    const order: string[] = [];
    void Promise.resolve().then(() => order.push('microtask'));
    await yieldToPortableEventLoop();
    // The MessageChannel turn plus the trailing flushPortableMicrotasks() must
    // have let the queued microtask run before this resolves.
    expect(order).toEqual(['microtask']);
  });

  it('falls back to setTimeout when MessageChannel is unavailable', async () => {
    const hadMessageChannel = 'MessageChannel' in globalThis;
    const original = globalThis.MessageChannel;
    // The implementation gates on `typeof MessageChannel !== 'undefined'`, so
    // override the value to `undefined` rather than `delete` it: a non-configurable
    // global would make `delete` silently fail and let the test pass without ever
    // exercising the setTimeout branch. Assignment makes `typeof` report
    // 'undefined' deterministically. If even assignment is rejected, skip rather
    // than assert against a branch we couldn't force.
    try {
      // @ts-expect-error deliberately blanking a global for the fallback path
      globalThis.MessageChannel = undefined;
    } catch {
      return;
    }
    if (typeof MessageChannel !== 'undefined') {
      // Could not force the fallback condition; don't assert vacuously.
      globalThis.MessageChannel = original;
      return;
    }
    try {
      await expect(yieldToPortableEventLoop()).resolves.toBeUndefined();
    } finally {
      if (hadMessageChannel) {
        globalThis.MessageChannel = original;
      } else {
        // @ts-expect-error restoring absence — do not leave an undefined property
        delete globalThis.MessageChannel;
      }
    }
  });
});

describe('@lostgradient/weft/testing barrel re-exports', () => {
  // These helpers were defined and used internally but never reachable from the
  // public testing barrel. A consumer could not write
  // `afterEach(yieldToPortableEventLoop)` to drain a deferred inline launch
  // under a shared-process runner — these assertions pin them to the public surface.
  it('exposes yieldToPortableEventLoop', () => {
    expect(typeof testingBarrel.yieldToPortableEventLoop).toBe('function');
    expect(testingBarrel.yieldToPortableEventLoop).toBe(yieldToPortableEventLoop);
  });

  it('exposes flushPortableMicrotasks', () => {
    expect(typeof testingBarrel.flushPortableMicrotasks).toBe('function');
    expect(testingBarrel.flushPortableMicrotasks).toBe(flushPortableMicrotasks);
  });
});
