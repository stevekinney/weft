import { afterEach, describe, expect, it } from 'bun:test';

import type { ScanOptions } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { flush } from '../testing/storage-backends.test-support.ts';
import { encode } from './codec.ts';
import {
  clearEngineLeakWarningTokenForTesting,
  Engine,
  getEngineLeakCollectionCountForTesting,
  hasEngineLeakWarningTokenForTesting,
  setEngineLeakWarningOverrideForTesting,
  setNextEngineLeakWarningTokenForTesting,
  shouldEmitEngineLeakWarningForTesting,
} from './engine.ts';
import { CleanupWarningEvent } from './events.ts';
import { activity, workflow, type WorkflowContext } from './types.ts';

async function forceFinalizers(stopWhen: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    Bun.gc(true);
    await flush();
    await sleepForTesting(5);

    if (stopWhen()) return;
  }

  throw new Error('Expected leaked Engine to be garbage-collected during the warning test.');
}

async function captureLeakWarning(run: () => void, token: symbol): Promise<boolean> {
  const initialCollectionCount = getEngineLeakCollectionCountForTesting();
  setNextEngineLeakWarningTokenForTesting(token);
  run();
  await flush();
  await forceFinalizers(() => getEngineLeakCollectionCountForTesting() > initialCollectionCount);
  await flush();
  return hasEngineLeakWarningTokenForTesting(token);
}

function createLeakedEngine(): void {
  void new Engine();
}

function createLeakedDetectorEngine(): void {
  // Detection on → the engine holds a live second-instance interval, so the
  // finalizer must clear THAT interval too (not only the cleanup interval) when
  // the engine is collected without [Symbol.dispose]().
  void new Engine({ detectSecondInstance: true });
}

describe('Engine lifecycle ergonomics', () => {
  afterEach(() => {
    setEngineLeakWarningOverrideForTesting(undefined);
    setNextEngineLeakWarningTokenForTesting(undefined);
  });

  it('emits a development warning when an engine is garbage-collected without disposal', async () => {
    setEngineLeakWarningOverrideForTesting(true);

    const token = Symbol('leaked engine warning');
    const emittedWarning = await captureLeakWarning(createLeakedEngine, token);

    expect(emittedWarning).toBe(true);
    clearEngineLeakWarningTokenForTesting(token);
  });

  it('clears the second-instance detection interval when a detector engine is collected without disposal', async () => {
    setEngineLeakWarningOverrideForTesting(true);

    const token = Symbol('leaked detector engine warning');
    // The finalizer fires (warning emitted) AND its detection-interval clear arm
    // runs because the leaked engine had detection enabled.
    const emittedWarning = await captureLeakWarning(createLeakedDetectorEngine, token);

    expect(emittedWarning).toBe(true);
    clearEngineLeakWarningTokenForTesting(token);
  });

  it('does not emit disposal warnings when the leak-warning gate is disabled', async () => {
    setEngineLeakWarningOverrideForTesting(false);
    expect(shouldEmitEngineLeakWarningForTesting()).toBe(false);

    const token = Symbol('disabled leaked engine warning');
    const emittedWarning = await captureLeakWarning(createLeakedEngine, token);

    expect(emittedWarning).toBe(false);
    clearEngineLeakWarningTokenForTesting(token);

    setEngineLeakWarningOverrideForTesting(true);
    expect(shouldEmitEngineLeakWarningForTesting()).toBe(true);
  });

  it('recovers by default and opts out with recover: false', async () => {
    const storage = new MemoryStorage();
    const resumable = workflow({ name: 'resumable' }).execute(async function* (
      ctx: WorkflowContext,
    ): AsyncGenerator<unknown, string, unknown> {
      const suffix = yield* ctx.waitForSignal<string>('release');
      return `done:${suffix}`;
    });

    // Populate via Engine.create so the schema-version sentinel is stamped, then
    // reopen the same storage below — the current setup.
    const original = await Engine.create({ storage, recover: false, workflows: { resumable } });
    const handle = await original.start('resumable', undefined, { id: 'recoverable-workflow' });
    handle.result().catch(() => {});
    await flush();
    original[Symbol.dispose]();

    // `recover: false` opts out of the default recovery sweep, leaving the
    // workflow dormant for inspection.
    const inspecting = await Engine.create({ storage, recover: false });
    const dormantState = await inspecting.get('recoverable-workflow');
    expect(dormantState?.status).toBe('running');
    inspecting[Symbol.dispose]();

    // Recovery is the default: a fresh engine that registers the workflow type
    // resumes the in-flight workflow on construction without an explicit flag.
    const recovered = await Engine.create({
      storage,
      workflows: { resumable },
    });
    await recovered.signal('recoverable-workflow', 'release', 'ok');
    await expect(recovered.getHandle('recoverable-workflow').result()).resolves.toBe('done:ok');
    recovered[Symbol.dispose]();
  });

  it('runs durable timers without constructing background intervals in manual mode', async () => {
    const originalSetInterval = globalThis.setInterval;
    const sleeper = workflow({ name: 'sleeper' }).execute(async function* (
      ctx: WorkflowContext,
    ): AsyncGenerator<unknown, string, unknown> {
      yield* ctx.sleep('1m');
      return 'awake';
    });
    let disposeEngine: (() => void) | undefined;

    globalThis.setInterval = (() => {
      throw new Error('manual background tasks must not create an interval');
    }) as typeof setInterval;

    try {
      const engine = await Engine.create({
        backgroundTasks: 'manual',
        workflows: { sleeper },
        retention: { completed: '1d' },
        alerts: {
          rules: [{ metric: 'workflow.failure_rate', threshold: 1, action: 'log' }],
        },
      });
      disposeEngine = () => engine[Symbol.dispose]();
      const handle = await engine.start('sleeper', undefined);
      await flush();

      await engine.runMaintenance(Date.now() + 60_000);

      await expect(handle.result()).resolves.toBe('awake');
    } finally {
      disposeEngine?.();
      globalThis.setInterval = originalSetInterval;
    }
  });

  it('rejects interval-owning options in manual background-task mode', async () => {
    expect(() => new Engine({ backgroundTasks: 'manual', detectSecondInstance: true })).toThrow(
      'detectSecondInstance cannot be enabled when backgroundTasks is "manual"',
    );
    expect(() => new Engine({ backgroundTasks: 'manual', ownership: 'lease' })).toThrow(
      'ownership cannot be "lease" when backgroundTasks is "manual"',
    );
    await expect(
      Engine.create({ backgroundTasks: 'manual', startScheduler: true }),
    ).rejects.toThrow('startScheduler cannot be true when backgroundTasks is "manual"');
    expect(() => new Engine({ backgroundTasks: 'invalid' } as never)).toThrow(
      'options.backgroundTasks must be "automatic" or "manual" when provided',
    );
  });

  it('reports manual update-response cleanup failures without skipping the cycle', async () => {
    class CleanupFailingStorage extends MemoryStorage {
      override async *scan(
        prefix: string,
        options?: ScanOptions,
      ): AsyncIterable<[string, Uint8Array]> {
        if (prefix === 'upr:') throw new Error('manual cleanup exploded');
        yield* super.scan(prefix, options);
      }
    }
    using engine = new Engine({
      backgroundTasks: 'manual',
      storage: new CleanupFailingStorage(),
    });
    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => warnings.push(event));

    await engine.runMaintenance();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe('cleanupExpiredResponses');
    expect(warnings[0]!.error.message).toBe('manual cleanup exploded');
  });

  it('runs update-response cleanup and retention during manual maintenance', async () => {
    const storage = new MemoryStorage();
    const completes = workflow({ name: 'completes' }).execute(async function* () {
      return 'done';
    });
    const engine = await Engine.create({
      backgroundTasks: 'manual',
      storage,
      retention: { completed: 0 },
      workflows: { completes },
    });

    try {
      const handle = await engine.start('completes', undefined, { id: 'retained-workflow' });
      await expect(handle.result()).resolves.toBe('done');
      await storage.put(
        'upr:expired-update',
        encode({
          updateId: 'expired-update',
          result: 'stale',
          createdAt: Date.now() - 25 * 60 * 60 * 1_000,
        }),
      );

      await engine.runMaintenance();

      expect(await storage.get('upr:expired-update')).toBeNull();
      expect(await engine.get('retained-workflow')).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('registers activity definitions through register()', async () => {
    const greet = activity({
      name: 'greet',
      execute: async (input: { name: string }) => `Hello, ${input.name}`,
    });
    const welcome = workflow({ name: 'welcome' }).execute(async function* (
      ctx: WorkflowContext,
      input: { name: string },
    ) {
      return yield* ctx.run(greet, input);
    });

    const engine = new Engine();
    engine.register(greet).register(welcome);

    const handle = await engine.start('welcome', { name: 'Ada' });
    await expect(handle.result()).resolves.toBe('Hello, Ada');
    engine[Symbol.dispose]();
  });
});
