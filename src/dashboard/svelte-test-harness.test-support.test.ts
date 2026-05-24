import { afterEach, describe, expect, it } from 'bun:test';

import { installDashboardDom } from './svelte-test-harness.test-support.ts';

const SENTINEL = Symbol('pre-existing-global');

let teardown: (() => void) | undefined;

afterEach(() => {
  teardown?.();
  teardown = undefined;
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  Reflect.deleteProperty(globalThis, '__harnessProbe');
});

describe('installDashboardDom', () => {
  it('installs base globals and runs the requestAnimationFrame shim', async () => {
    teardown = installDashboardDom();

    expect(typeof globalThis.requestAnimationFrame).toBe('function');
    expect(typeof globalThis.document).toBe('object');

    let frameTimestamp: number | undefined;
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame((timestamp) => {
        frameTimestamp = timestamp;
        resolve();
      });
    });

    expect(typeof frameTimestamp).toBe('number');
  });

  it('cancelAnimationFrame prevents a pending callback from firing', async () => {
    teardown = installDashboardDom();

    let fired = false;
    const handle = globalThis.requestAnimationFrame(() => {
      fired = true;
    });
    globalThis.cancelAnimationFrame(handle);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fired).toBe(false);
  });

  it('merges extraGlobals over the base set', () => {
    teardown = installDashboardDom((window) => ({
      HTMLButtonElement: window.HTMLButtonElement,
    }));

    expect(typeof (globalThis as Record<string, unknown>)['HTMLButtonElement']).toBe('function');
  });

  it('teardown deletes globals that did not previously exist', () => {
    expect('requestAnimationFrame' in globalThis).toBe(false);

    const cleanup = installDashboardDom();
    expect('requestAnimationFrame' in globalThis).toBe(true);

    cleanup();
    expect('requestAnimationFrame' in globalThis).toBe(false);
  });

  it('teardown restores a global that already existed', () => {
    Object.defineProperty(globalThis, '__harnessProbe', {
      configurable: true,
      writable: true,
      value: SENTINEL,
    });

    const cleanup = installDashboardDom((window) => ({
      __harnessProbe: window.document,
    }));
    expect((globalThis as Record<string, unknown>)['__harnessProbe']).toBe(
      (globalThis as { document: unknown }).document,
    );

    cleanup();
    expect((globalThis as Record<string, unknown>)['__harnessProbe']).toBe(SENTINEL);
  });
});
