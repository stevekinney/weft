/**
 * Tests for ctx.saga() — sequential activity execution with reverse compensation.
 *
 * The saga primitive runs steps in order and, on any step failure, calls the
 * `compensate` function (if present) for every previously-completed step in
 * reverse order (last-completed first). The failing step itself is never
 * compensated. The original error is re-thrown after all compensators run.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import type { Context } from '../context.ts';
import { Engine } from '../engine.ts';
import type { ActivityDefinition, WorkflowContext } from '../types.ts';

/** Drain microtasks so fire-and-forget engine work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

// ---------------------------------------------------------------------------
// Reusable activity builder
// ---------------------------------------------------------------------------

function makeActivity<TInput, TOutput>(options: {
  name: string;
  execute: (input: TInput) => TOutput | Promise<TOutput>;
  compensate?: (input: TInput, output: TOutput) => void | Promise<void>;
}): ActivityDefinition<TInput, TOutput> {
  return {
    name: options.name,
    execute: async (input: TInput) => options.execute(input),
    ...(options.compensate !== undefined ? { compensate: options.compensate } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. 3-step saga where step 3 fails — compensators for steps 1 and 2 run in
//    reverse order (step 2 compensator first, then step 1 compensator).
// ---------------------------------------------------------------------------

describe('ctx.saga()', () => {
  it('runs compensators in reverse order when a step fails', async () => {
    const engine = new Engine();
    const compensationOrder: string[] = [];

    const step1 = makeActivity({
      name: 'step-one',
      execute: (_input: string) => 'output-one',
      compensate: (_input, _output) => {
        compensationOrder.push('step-one');
      },
    });

    const step2 = makeActivity({
      name: 'step-two',
      execute: (_input: string) => 'output-two',
      compensate: (_input, _output) => {
        compensationOrder.push('step-two');
      },
    });

    const step3 = makeActivity({
      name: 'step-three',
      execute: (_input: string): string => {
        throw new Error('step-three failed');
      },
      compensate: (_input, _output) => {
        compensationOrder.push('step-three');
      },
    });

    engine.register('saga-reverse', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.saga([
        { definition: step1, input: 'a' },
        { definition: step2, input: 'b' },
        { definition: step3, input: 'c' },
      ]);
    });

    const handle = await engine.start('saga-reverse', null);
    await expect(handle.result()).rejects.toThrow('step-three failed');

    // Compensators run in reverse order: step 2 first, then step 1.
    // step 3 (the failing step) must never be compensated.
    expect(compensationOrder).toEqual(['step-two', 'step-one']);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 2. The failing step's own compensator must not be called.
  // ---------------------------------------------------------------------------

  it('does not call the compensator for the failing step', async () => {
    const engine = new Engine();
    let failingStepCompensatorCalls = 0;

    const passing = makeActivity({
      name: 'passing',
      execute: (_input: string) => 'ok',
    });

    const failing = makeActivity({
      name: 'failing',
      execute: (_input: string): string => {
        throw new Error('expected failure');
      },
      compensate: () => {
        failingStepCompensatorCalls++;
      },
    });

    engine.register('no-compensate-failing-step', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.saga([
        { definition: passing, input: 'x' },
        { definition: failing, input: 'y' },
      ]);
    });

    const handle = await engine.start('no-compensate-failing-step', null);
    await expect(handle.result()).rejects.toThrow('expected failure');

    expect(failingStepCompensatorCalls).toBe(0);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 3. Clean path — all steps succeed, no compensators are called.
  // ---------------------------------------------------------------------------

  it('calls no compensators when all steps succeed', async () => {
    const engine = new Engine();
    let compensatorCalls = 0;

    const step = makeActivity({
      name: 'happy-step',
      execute: (input: number) => input + 1,
      compensate: () => {
        compensatorCalls++;
      },
    });

    engine.register('happy-saga', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      const result = yield* c.saga<number>([
        { definition: step, input: 1 },
        { definition: step, input: 2 },
        { definition: step, input: 3 },
      ]);
      return result;
    });

    const handle = await engine.start('happy-saga', null);
    const result = await handle.result();

    // Each step returns input + 1; saga returns the last step's output.
    expect(result).toBe(4);
    expect(compensatorCalls).toBe(0);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 4. Engine restart verification.
  //
  //    Run a 3-step saga where step 3 fails. The workflow completes (as failed)
  //    with compensators for steps 1 and 2 called exactly once each. On engine
  //    restart with the same storage, recoverAll() finds no runnable workflows
  //    (the workflow already reached a terminal state) so compensators are
  //    never called a second time.
  // ---------------------------------------------------------------------------

  it('compensators run exactly once each across an engine restart', async () => {
    const storage = new MemoryStorage();

    let step1CompensatorCalls = 0;
    let step2CompensatorCalls = 0;

    function buildActivities() {
      const activityOne = makeActivity({
        name: 'activity-one',
        execute: (_input: string) => 'result-one',
        compensate: () => {
          step1CompensatorCalls++;
        },
      });

      const activityTwo = makeActivity({
        name: 'activity-two',
        execute: (_input: string) => 'result-two',
        compensate: () => {
          step2CompensatorCalls++;
        },
      });

      const activityThree = makeActivity({
        name: 'activity-three',
        execute: (_input: string): string => {
          throw new Error('activity-three failed');
        },
      });

      return { activityOne, activityTwo, activityThree };
    }

    function registerWorkflow(engine: Engine): void {
      const { activityOne, activityTwo, activityThree } = buildActivities();
      engine.register('three-step-saga', async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        yield* c.saga([
          { definition: activityOne, input: 'in-1' },
          { definition: activityTwo, input: 'in-2' },
          { definition: activityThree, input: 'in-3' },
        ]);
      });
    }

    // --- First engine run ---
    const engine1 = new Engine({ storage });
    registerWorkflow(engine1);

    const handle1 = await engine1.start('three-step-saga', null, { id: 'saga-restart-wf' });
    await expect(handle1.result()).rejects.toThrow('activity-three failed');

    // Compensators for steps 1 and 2 ran exactly once on the first engine.
    expect(step1CompensatorCalls).toBe(1);
    expect(step2CompensatorCalls).toBe(1);

    engine1[Symbol.dispose]();

    // Reset counters to detect any re-execution on restart.
    step1CompensatorCalls = 0;
    step2CompensatorCalls = 0;

    // --- Second engine: restart with same storage ---
    const engine2 = new Engine({ storage });
    registerWorkflow(engine2);

    // The workflow reached a terminal (failed) state on engine1, so recoverAll
    // should find nothing to resume.
    const recovered = await engine2.recoverAll();
    await flush();

    expect(recovered).toHaveLength(0);

    // Compensators must not have been called a second time.
    expect(step1CompensatorCalls).toBe(0);
    expect(step2CompensatorCalls).toBe(0);

    engine2[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 5. Compensators receive the correct input and output from each step.
  // ---------------------------------------------------------------------------

  it('passes original input and step output to each compensator', async () => {
    const engine = new Engine();

    const compensatorArgs: Array<{ input: string; output: string }> = [];

    const trackingActivity = makeActivity({
      name: 'tracking',
      execute: (input: string) => `processed:${input}`,
      compensate: (input: string, output: string) => {
        compensatorArgs.push({ input, output });
      },
    });

    const failingActivity = makeActivity({
      name: 'terminal-failure',
      execute: (_input: string): string => {
        throw new Error('forced failure');
      },
    });

    engine.register('arg-check-saga', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.saga([
        { definition: trackingActivity, input: 'alpha' },
        { definition: trackingActivity, input: 'beta' },
        { definition: failingActivity, input: 'gamma' },
      ]);
    });

    const handle = await engine.start('arg-check-saga', null);
    await expect(handle.result()).rejects.toThrow('forced failure');

    // Compensators run in reverse (beta first, then alpha).
    expect(compensatorArgs).toHaveLength(2);
    expect(compensatorArgs[0]).toEqual({ input: 'beta', output: 'processed:beta' });
    expect(compensatorArgs[1]).toEqual({ input: 'alpha', output: 'processed:alpha' });

    engine[Symbol.dispose]();
  });
});
