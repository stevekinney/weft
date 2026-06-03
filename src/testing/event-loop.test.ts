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
    const original = globalThis.MessageChannel;
    // Simulate a runtime without MessageChannel (the else branch).
    // @ts-expect-error deliberately removing a global for the fallback path
    delete globalThis.MessageChannel;
    try {
      await expect(yieldToPortableEventLoop()).resolves.toBeUndefined();
    } finally {
      globalThis.MessageChannel = original;
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
