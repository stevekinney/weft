import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileSvelteHarnessModule,
  createGeneratedArtifactTracker,
  installDashboardDom,
} from './svelte-test-harness.test-support.ts';

const SENTINEL = Symbol('pre-existing-global');

// Unique synthetic keys so the tests never assume anything about which globals
// the runtime provides by default. Each test installs the helper (and any probe
// it sets directly), then restores the captured descriptors in afterEach rather
// than blindly deleting — mirroring the save/restore contract under test.
const ABSENT_PROBE = '__harnessAbsentProbe';
const PRESENT_PROBE = '__harnessPresentProbe';

let teardown: (() => void) | undefined;
const probeKeys = [ABSENT_PROBE, PRESENT_PROBE] as const;
const savedProbeDescriptors = new Map<string, PropertyDescriptor | undefined>();

afterEach(() => {
  teardown?.();
  teardown = undefined;
  for (const key of probeKeys) {
    const descriptor = savedProbeDescriptors.get(key);
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  savedProbeDescriptors.clear();
});

function rememberProbe(key: string): void {
  savedProbeDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
}

describe('installDashboardDom', () => {
  it('installs base globals and runs the requestAnimationFrame shim', async () => {
    teardown = await installDashboardDom();

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
    teardown = await installDashboardDom();

    let fired = false;
    const handle = globalThis.requestAnimationFrame(() => {
      fired = true;
    });
    globalThis.cancelAnimationFrame(handle);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fired).toBe(false);
  });

  it('merges extraGlobals over the base set', async () => {
    teardown = await installDashboardDom((window) => ({
      HTMLButtonElement: window.HTMLButtonElement,
    }));

    expect(typeof (globalThis as Record<string, unknown>)['HTMLButtonElement']).toBe('function');
  });

  it('teardown deletes globals that did not previously exist', async () => {
    rememberProbe(ABSENT_PROBE);
    expect(ABSENT_PROBE in globalThis).toBe(false);

    const cleanup = await installDashboardDom((window) => ({ [ABSENT_PROBE]: window.document }));
    expect(ABSENT_PROBE in globalThis).toBe(true);

    cleanup();
    expect(ABSENT_PROBE in globalThis).toBe(false);
  });

  it('teardown restores a global that already existed', async () => {
    rememberProbe(PRESENT_PROBE);
    Object.defineProperty(globalThis, PRESENT_PROBE, {
      configurable: true,
      writable: true,
      value: SENTINEL,
    });

    const cleanup = await installDashboardDom((window) => ({ [PRESENT_PROBE]: window.document }));
    expect((globalThis as Record<string, unknown>)[PRESENT_PROBE]).toBe(
      (globalThis as { document: unknown }).document,
    );

    cleanup();
    expect((globalThis as Record<string, unknown>)[PRESENT_PROBE]).toBe(SENTINEL);
  });

  it('throws when the Svelte build reports success without an output file', async () => {
    const tracker = createGeneratedArtifactTracker();
    const componentDirectory = await mkdtemp(join(tmpdir(), 'weft-dashboard-harness-'));
    const buildSpy = spyOn(Bun, 'build').mockResolvedValue({
      success: true,
      outputs: [],
      logs: [],
    } as never);

    try {
      await expect(
        compileSvelteHarnessModule({
          componentDirectory,
          harnessBaseName: 'missing-output',
          harnessExtension: '.ts',
          source: 'export const value = 1;',
          tracker,
        }),
      ).rejects.toThrow('Svelte component build did not produce an output file');
    } finally {
      buildSpy.mockRestore();
      tracker.cleanup();
    }
  });
});
