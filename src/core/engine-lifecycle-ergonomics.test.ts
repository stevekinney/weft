import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { flush } from '../testing/storage-backends.test-support.ts';
import {
  clearEngineLeakWarningTokenForTesting,
  Engine,
  getEngineLeakCollectionCountForTesting,
  hasEngineLeakWarningTokenForTesting,
  setEngineLeakWarningOverrideForTesting,
  setNextEngineLeakWarningTokenForTesting,
  shouldEmitEngineLeakWarningForTesting,
} from './engine.ts';
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
