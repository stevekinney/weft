import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { normalizeListFilter } from '../list-filter-validation.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { TERMINAL_STATUSES } from './guards.ts';
import { Engine } from './index.ts';
import { TERMINAL_WORKFLOW_STATUSES } from './termination.ts';

/** Drain microtasks so a deferred inline start advances. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Read a workflow's current status (or undefined if it does not exist). */
async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

// Parks at a signal so a suspend can land while the run is genuinely paused
// mid-flight (the realistic suspend point), then advances on resume + signal.
const waiter = workflow({ name: 'waits' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal('go');
  return 'done';
});

describe('suspend/resume', () => {
  it('flips a running workflow to the non-terminal suspended status', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-1' });
    await flush();
    expect(await statusOf(engine, 'sus-1')).toBe('running');

    await handle.suspend();
    const state = await engine.get('sus-1');
    expect(state?.status).toBe('suspended');
    // The durable checkpoint must survive suspension so resume can re-drive it.
    expect(await engine.getCurrentCheckpointStep('sus-1')).not.toBeNull();
  });

  it('keeps result() pending across suspend, then resolves after resume + completion', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-pending' });
    await flush();
    await handle.suspend();

    // The result promise must NOT settle on suspend (unlike cancel, which
    // rejects it). Race it against a short timer to assert it is still pending.
    let settled = false;
    void handle.result().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);

    await handle.resume();
    await flush();
    await engine.signal('sus-pending', 'go');
    expect(await handle.result()).toBe('done');
  });

  it('same-process suspend → resume re-drives the run past the suspend point', async () => {
    // The discriminating test: cross-process resume works trivially (fresh
    // process, no local ownership), but same-process resume must NOT be a no-op
    // via the local-ownership early-return. Assert the run actually advances.
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-same' });
    await flush();
    await handle.suspend();
    expect(await statusOf(engine, 'sus-same')).toBe('suspended');

    await handle.resume();
    await flush();
    // Resume flipped it back to running...
    expect(await statusOf(engine, 'sus-same')).toBe('running');
    // ...and the run is live again: signalling it drives it to completion.
    await engine.signal('sus-same', 'go');
    expect(await handle.result()).toBe('done');
    expect(await statusOf(engine, 'sus-same')).toBe('completed');
  });

  it('is an idempotent no-op when the workflow is not running', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'instant' }).execute(async function* () {
        return 1;
      }),
    );

    const handle = await engine.start('instant', null, { id: 'sus-done' });
    expect(await handle.result()).toBe(1);
    expect(await statusOf(engine, 'sus-done')).toBe('completed');

    // Suspending a completed workflow must not change its terminal status.
    await handle.suspend();
    expect(await statusOf(engine, 'sus-done')).toBe('completed');
  });

  it('cancel on suspended is a no-op; resume then cancel terminates the run', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-cancel' });
    await flush();
    await handle.suspend();
    expect(await statusOf(engine, 'sus-cancel')).toBe('suspended');

    // Direct cancel of a suspended workflow is a no-op (cancel CAS excludes
    // 'suspended'); the status stays suspended.
    await handle.cancel();
    expect(await statusOf(engine, 'sus-cancel')).toBe('suspended');

    // Resume puts it back to running, after which cancel terminates it.
    await handle.resume();
    await flush();
    await handle.cancel();
    expect(await statusOf(engine, 'sus-cancel')).toBe('cancelled');
  });

  it('recoverAll skips suspended workflows (no auto-recovery, no throw)', async () => {
    const storage = new MemoryStorage();
    {
      using original = new Engine({ storage });
      original.register(waiter);
      const handle = await original.start('waits', null, { id: 'sus-recover' });
      await flush();
      await handle.suspend();
      expect(await statusOf(original, 'sus-recover')).toBe('suspended');
    }

    await using recovered = new Engine({ storage });
    recovered.register(waiter);
    const handles = await recovered.recoverAll();
    // The suspended workflow is NOT among the auto-recovered handles.
    expect(handles.some((candidate) => candidate.id === 'sus-recover')).toBe(false);
    // ...but it is still visible and still suspended.
    expect(await statusOf(recovered, 'sus-recover')).toBe('suspended');
  });

  it('cross-process: suspend + dispose, then explicit resume in a fresh engine', async () => {
    const storage = new MemoryStorage();
    {
      using original = new Engine({ storage });
      original.register(waiter);
      const handle = await original.start('waits', null, { id: 'sus-xproc' });
      await flush();
      await handle.suspend();
    }

    await using fresh = new Engine({ storage });
    fresh.register(waiter);
    // recoverAll skips it; resume it explicitly.
    await fresh.recoverAll();
    const handle = await fresh.resume('sus-xproc');
    await flush();
    expect(await statusOf(fresh, 'sus-xproc')).toBe('running');
    await fresh.signal('sus-xproc', 'go');
    expect(await handle.result()).toBe('done');
  });

  it('engine.resume throws for a terminal workflow', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'instant2' }).execute(async function* () {
        return 1;
      }),
    );
    const handle = await engine.start('instant2', null, { id: 'res-terminal' });
    await handle.result();
    await expect(engine.resume('res-terminal')).rejects.toThrow(/status is "completed"/);
  });

  it('list filter accepts suspended as a valid status', () => {
    // The visibility-filter contract: list({ status: 'suspended' }) must be
    // ACCEPTED by the canonical normalizer, not rejected as an unknown status.
    expect(() => normalizeListFilter({ status: 'suspended' })).not.toThrow();
    expect(normalizeListFilter({ status: 'suspended' }).status).toBe('suspended');
    expect(normalizeListFilter({ status: ['running', 'suspended'] }).status).toEqual([
      'running',
      'suspended',
    ]);
  });

  it('engine.list filters by suspended status', async () => {
    await using engine = new Engine();
    engine.register(waiter);
    const handle = await engine.start('waits', null, { id: 'sus-list' });
    await flush();
    await handle.suspend();

    const suspended = await engine.list({ status: 'suspended' });
    expect(suspended.items.some((summary) => summary.id === 'sus-list')).toBe(true);

    const running = await engine.list({ status: 'running' });
    expect(running.items.some((summary) => summary.id === 'sus-list')).toBe(false);
  });

  it('the two terminal-status sets agree and exclude suspended (drift guard)', () => {
    // guards.ts TERMINAL_STATUSES and termination/cleanup.ts
    // TERMINAL_WORKFLOW_STATUSES are duplicated; they must stay equal, and
    // neither may classify 'suspended' as terminal.
    expect([...TERMINAL_STATUSES].toSorted()).toEqual([...TERMINAL_WORKFLOW_STATUSES].toSorted());
    expect(TERMINAL_STATUSES.has('suspended')).toBe(false);
    expect(TERMINAL_WORKFLOW_STATUSES.has('suspended')).toBe(false);
  });
});
