import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.ts';
import { flush } from '../testing/storage-backends.ts';
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

  it('requires explicit recovery for both new Engine and Engine.create', async () => {
    const storage = new MemoryStorage();
    const resumable = workflow({
      name: 'resumable',
      handler: async function* (ctx: WorkflowContext): AsyncGenerator<unknown, string, unknown> {
        const suffix = yield* ctx.waitForSignal<string>('release');
        return `done:${suffix}`;
      },
    });

    const original = new Engine({ storage });
    original.register(resumable);
    const handle = await original.start('resumable', undefined, { id: 'recoverable-workflow' });
    handle.result().catch(() => {});
    await flush();
    original[Symbol.dispose]();

    const createdWithoutRecovery = await Engine.create({ storage });
    const unrecoveredState = await createdWithoutRecovery.get('recoverable-workflow');
    expect(unrecoveredState?.status).toBe('running');
    createdWithoutRecovery[Symbol.dispose]();

    const recovered = await Engine.create({
      storage,
      workflows: { resumable },
      recover: true,
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
    const welcome = workflow({
      name: 'welcome',
      handler: async function* (ctx: WorkflowContext, input: { name: string }) {
        return yield* ctx.run(greet, input);
      },
    });

    const engine = new Engine();
    engine.register(greet).register(welcome);

    const handle = await engine.start('welcome', { name: 'Ada' });
    await expect(handle.result()).resolves.toBe('Hello, Ada');
    engine[Symbol.dispose]();
  });
});
