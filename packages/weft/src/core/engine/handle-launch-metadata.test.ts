import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';

/** Drain microtasks so a deferred inline start advances. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const waiter = workflow({ name: 'waits' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal('go');
  return 'done';
});

describe('WorkflowHandle.getLaunchMetadata', () => {
  it('returns the original input and id for a started workflow', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const input = { user: 'ada', items: [1, 2, 3], nested: { flag: true } };
    const handle = await engine.start('waits', input, { id: 'run-1' });

    const metadata = await handle.getLaunchMetadata();
    expect(metadata).not.toBeNull();
    expect(metadata?.input).toEqual(input);
    expect(metadata?.launchOptions.id).toBe('run-1');
    // No tags were passed, so the key is omitted entirely.
    expect(metadata?.launchOptions.tags).toBeUndefined();
  });

  it('carries tags when the workflow was started with them', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, {
      id: 'run-tagged',
      tags: ['nightly', 'ops'],
    });

    const metadata = await handle.getLaunchMetadata();
    expect(metadata?.launchOptions.tags).toEqual(['nightly', 'ops']);
  });

  it('excludes onTerminalConflict — it is a start-time policy, not a recoverable launch option', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(waiter);

    // Seed a terminal run, then restart it under the same id with the policy.
    const seedCompleter = workflow({ name: 'completes' }).execute(async function* () {
      return 'done';
    });
    engine.register(seedCompleter);
    const seed = await engine.start('completes', null, { id: 'policy-run' });
    await seed.result();

    const handle = await engine.start(
      'waits',
      { v: 1 },
      {
        id: 'policy-run',
        onTerminalConflict: 'start-new',
      },
    );

    const metadata = await handle.getLaunchMetadata();
    expect(metadata?.launchOptions.id).toBe('policy-run');
    // The policy is consumed at start time and never persisted, so it cannot
    // (and must not) appear on the recovered launch options.
    expect(metadata?.launchOptions).not.toHaveProperty('onTerminalConflict');
  });

  it('returns null for a handle whose workflow does not exist', async () => {
    await using engine = new Engine();
    const handle = engine.getHandle('never-started');
    expect(await handle.getLaunchMetadata()).toBeNull();
  });

  it('behaves identically on a getHandle-created handle (no special-casing)', async () => {
    await using engine = new Engine();
    engine.register(waiter);
    await engine.start('waits', { seed: 7 }, { id: 'run-gh' });

    // A fresh handle from getHandle() was created without a state load, yet the
    // async accessor loads state and resolves the same metadata.
    const fresh = engine.getHandle('run-gh');
    const metadata = await fresh.getLaunchMetadata();
    expect(metadata?.input).toEqual({ seed: 7 });
    expect(metadata?.launchOptions.id).toBe('run-gh');
  });

  it('recovers the original input on a handle returned from recoverAll', async () => {
    const storage = new MemoryStorage();

    const input = { tenant: 'acme', model: 'opus' };
    // Scope the first engine so it is disposed (releasing its timers) before the
    // recovery engine opens the same storage, even if an assertion below throws.
    {
      using original = new Engine({ storage });
      original.register(waiter);
      await original.start('waits', input, { id: 'recoverable', tags: ['t1'] });
      await flush();
    }

    // Fresh process: recover and read launch context off the recovered handle
    // without any side table correlating the run back to its start call.
    await using recovered = new Engine({ storage });
    recovered.register(waiter);
    const handles = await recovered.recoverAll();
    const handle = handles.find((candidate) => candidate.id === 'recoverable');
    expect(handle).toBeDefined();

    const metadata = await handle?.getLaunchMetadata();
    expect(metadata?.input).toEqual(input);
    expect(metadata?.launchOptions.id).toBe('recoverable');
    expect(metadata?.launchOptions.tags).toEqual(['t1']);
  });
});
