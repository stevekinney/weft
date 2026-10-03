/**
 * Regression tests for COR-1413: `ctx.setFinalizerState()` must work on every
 * context the engine builds, not only the fresh inline start. A recovered
 * (crash-adopted) or forked workflow re-executes its handler from the top, so a
 * workflow that stages finalizer state works inline but, before the fix, threw
 * "only supported for inline workflow execution" on every adoption.
 *
 * Synchronization is deterministic: polling durable keys and ticking the scheduler
 * against a fixed `getNow`; no wall-clock assertions.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';

const NOW = 5_000_000;

/** Registers a finalizer workflow whose recorded state carries the generation of the run that recorded it. */
function registerGenerationWorkflow(
  engine: Engine,
  type: string,
  generation: string,
  destroyed: unknown[],
): void {
  const destroy = activity({
    name: `${type}-destroy`,
    execute: async (input: unknown) => {
      destroyed.push(input);
    },
  });
  engine.register(
    workflow({ name: type, finalizer: destroy }).execute(async function* (ctx: WorkflowContext) {
      ctx.setFinalizerState({ generation });
      yield* ctx.waitForSignal('never');
    }),
  );
}

async function waitForParked(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => (await engine.storage.get(KEYS.checkpoint(workflowId))) !== null,
    { label: `workflow ${workflowId} parked`, timeoutMs: 2000, intervalMs: 5 },
  );
}

async function statusOf(engine: Engine, workflowId: string): Promise<string | undefined> {
  const state = await engine.get(workflowId);
  return state?.status;
}

async function finalizerStatusOf(engine: Engine, workflowId: string): Promise<string | undefined> {
  const status = await engine.getFinalizerStatus(workflowId);
  return status?.status;
}

describe('ctx.setFinalizerState on recovered and replayed contexts (COR-1413)', () => {
  it('survives a crash-adopt: the replayed workflow does not fail and its finalizer runs with the recorded state', async () => {
    const storage = new MemoryStorage();
    const destroyed: unknown[] = [];

    const engine1 = new Engine({ storage, getNow: () => NOW });
    registerGenerationWorkflow(engine1, 'replay-adopt', 'first-run', destroyed);
    await engine1.start('replay-adopt', null, { id: 'replay-adopt-1' });
    await waitForParked(engine1, 'replay-adopt-1');
    engine1[Symbol.dispose](); // crash

    const engine2 = new Engine({ storage, getNow: () => NOW });
    registerGenerationWorkflow(engine2, 'replay-adopt', 'second-run', destroyed);
    await engine2.recoverAll();

    // The adopted workflow replays `setFinalizerState` and parks again; it must not have failed.
    expect(await statusOf(engine2, 'replay-adopt-1')).toBe('running');

    const handle = engine2.getHandle('replay-adopt-1');
    await engine2.cancel('replay-adopt-1');
    expect(await throwingRejectionOf(handle.result())).toThrow('Workflow cancelled');

    // The value staged by the replayed call is the one flushed with the terminal batch.
    const recorded = await storage.get(KEYS.finalizerState('replay-adopt-1'));
    expect(recorded).not.toBeNull();
    expect(decode(recorded!)).toEqual({ generation: 'second-run' });

    expect(await engine2.getFinalizerStatus('replay-adopt-1')).toEqual({
      status: 'pending',
      attempts: 0,
    });
    await engine2.scheduler.tick(NOW);

    expect(destroyed).toEqual([{ generation: 'second-run' }]);
    expect(await finalizerStatusOf(engine2, 'replay-adopt-1')).toBe('succeeded');

    engine2[Symbol.dispose]();
  });

  it('records finalizer state on a context launched from a checkpoint (fork)', async () => {
    const destroyed: unknown[] = [];
    const engine = new Engine({ getNow: () => NOW });
    registerGenerationWorkflow(engine, 'replay-fork', 'forked', destroyed);

    const original = await engine.start('replay-fork', null, { id: 'replay-fork-original' });
    await waitForParked(engine, original.id);

    const forked = await engine.fork(original.id);
    await waitForParked(engine, forked.id);
    expect(await statusOf(engine, forked.id)).toBe('running');

    await engine.cancel(forked.id);
    expect(await throwingRejectionOf(forked.result())).toThrow('Workflow cancelled');
    await engine.scheduler.tick(NOW);

    expect(destroyed).toEqual([{ generation: 'forked' }]);
    expect(await finalizerStatusOf(engine, forked.id)).toBe('succeeded');

    await engine.cancel(original.id);
    await throwingRejectionOf(original.result());
    engine[Symbol.dispose]();
  });
});
