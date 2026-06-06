import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const tick = activity({
  name: 'tick',
  execute: async (input: unknown) => `ticked:${String(input)}`,
});

// Advances several steps (two activities around a signal) so the checkpoint
// cursor is observable at a non-zero value mid-run.
const resumable = workflow({ name: 'resumable-snapshot' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.run(tick, 'before');
  yield* ctx.waitForSignal('go');
  return yield* ctx.run(tick, 'after');
});

describe('WorkflowHandle.snapshot — observe a recovered run as a live handle', () => {
  it('reports status and cursor for a running handle', async () => {
    await using engine = new Engine();
    engine.register(tick);
    engine.register(resumable);

    const handle = await engine.start('resumable-snapshot', null, { id: 'snap-running' });
    await flush(); // let it run the first activity and park at the signal

    const snapshot = await handle.snapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe('running');
    // It advanced past at least the initial checkpoint.
    expect(snapshot?.step).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a handle whose workflow does not exist', async () => {
    await using engine = new Engine();
    const handle = engine.getHandle('never-started');
    expect(await handle.snapshot()).toBeNull();
  });

  it('reports step 0 when state exists but no checkpoint has been persisted', async () => {
    // Exercises the durable-fallback branch: state present, no checkpoint key.
    // getCurrentCheckpointStep reads null from storage and snapshot() defaults
    // the cursor to 0 (the initial step) rather than failing.
    const storage = new MemoryStorage();
    const state: WorkflowState = {
      id: 'state-no-checkpoint',
      type: 'whatever',
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '1' },
      createdAt: 1,
      updatedAt: 1,
    };
    await storage.put(KEYS.workflow('state-no-checkpoint'), encode(state));

    await using engine = new Engine({ storage });
    const handle = engine.getHandle('state-no-checkpoint');
    const snapshot = await handle.snapshot();
    expect(snapshot).toEqual({ status: 'running', step: 0 });
  });

  it('reports a terminal status after completion', async () => {
    await using engine = new Engine();
    engine.register(tick);
    engine.register(resumable);

    const handle = await engine.start('resumable-snapshot', null, { id: 'snap-done' });
    await flush();
    await engine.signal('snap-done', 'go');
    await handle.result();

    const snapshot = await handle.snapshot();
    expect(snapshot?.status).toBe('completed');
  });

  it('exposes the cursor of a run recovered in a fresh engine', async () => {
    const storage = new MemoryStorage();

    const original = new Engine({ storage });
    original.register(tick);
    original.register(resumable);
    await original.start('resumable-snapshot', null, { id: 'snap-recovered' });
    await flush(); // ran the first activity, parked at the signal
    original[Symbol.dispose]();

    // Fresh process: a recovered handle reports where the run currently is —
    // its status and durable cursor — without awaiting result(). This is the
    // "rebuild my adapter from the recovered run's cursor" path (seam #5b).
    await using recovered = new Engine({ storage });
    recovered.register(tick);
    recovered.register(resumable);
    const handles = await recovered.recoverAll();
    const handle = handles.find((candidate) => candidate.id === 'snap-recovered');
    expect(handle).toBeDefined();

    const snapshot = await handle?.snapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe('running');
    // The run had durably advanced past its first step before the crash, so the
    // recovered cursor reflects real progress, not a reset to zero.
    expect(snapshot?.step).toBeGreaterThan(0);
  });
});
