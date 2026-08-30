import { makeActivity } from '../../testing/activity.test-support.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
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
import { Engine } from '../engine.ts';
import type { WorkflowInterceptor } from '../interceptor.ts';
import type { ActivityContext, ActivityDefinition, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';

/** Drain microtasks so fire-and-forget engine work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
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

    const sagaReverseWorkflow = workflow({ name: 'saga-reverse' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      yield* c.saga([
        { definition: step1, input: 'a' },
        { definition: step2, input: 'b' },
        { definition: step3, input: 'c' },
      ]);
    });
    engine.register(sagaReverseWorkflow);

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

    const noCompensateFailingStepWorkflow = workflow({
      name: 'no-compensate-failing-step',
    }).execute(async function* (ctx: WorkflowContext) {
      const c = ctx;
      yield* c.saga([
        { definition: passing, input: 'x' },
        { definition: failing, input: 'y' },
      ]);
    });
    engine.register(noCompensateFailingStepWorkflow);

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

    const happySagaWorkflow = workflow({ name: 'happy-saga' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const result = yield* c.saga<number>([
        { definition: step, input: 1 },
        { definition: step, input: 2 },
        { definition: step, input: 3 },
      ]);
      return result;
    });
    engine.register(happySagaWorkflow);

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
      const threeStepSagaWorkflow = workflow({ name: 'three-step-saga' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const c = ctx;
        yield* c.saga([
          { definition: activityOne, input: 'in-1' },
          { definition: activityTwo, input: 'in-2' },
          { definition: activityThree, input: 'in-3' },
        ]);
      });
      engine.register(threeStepSagaWorkflow);
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

    const argCheckSagaWorkflow = workflow({ name: 'arg-check-saga' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      yield* c.saga([
        { definition: trackingActivity, input: 'alpha' },
        { definition: trackingActivity, input: 'beta' },
        { definition: failingActivity, input: 'gamma' },
      ]);
    });
    engine.register(argCheckSagaWorkflow);

    const handle = await engine.start('arg-check-saga', null);
    await expect(handle.result()).rejects.toThrow('forced failure');

    // Compensators run in reverse (beta first, then alpha).
    expect(compensatorArgs).toHaveLength(2);
    expect(compensatorArgs[0]).toEqual({ input: 'beta', output: 'processed:beta' });
    expect(compensatorArgs[1]).toEqual({ input: 'alpha', output: 'processed:alpha' });

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 6. Compensator failure isolation.
  //
  //    When a compensator itself throws, that failure must not mask the original
  //    saga error. The original error propagates to the caller unchanged.
  // ---------------------------------------------------------------------------

  it('propagates the original error even when a compensator throws', async () => {
    const engine = new Engine();

    const passing = makeActivity({
      name: 'passing-for-isolation',
      execute: (_input: string) => 'ok',
      compensate: (_input, _output) => {
        throw new Error('compensator exploded');
      },
    });

    const failing = makeActivity({
      name: 'failing-for-isolation',
      execute: (_input: string): string => {
        throw new Error('original saga error');
      },
    });

    const compensatorFailureSagaWorkflow = workflow({ name: 'compensator-failure-saga' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        yield* c.saga([
          { definition: passing, input: 'x' },
          { definition: failing, input: 'y' },
        ]);
      },
    );
    engine.register(compensatorFailureSagaWorkflow);

    const handle = await engine.start('compensator-failure-saga', null);
    // The original error — not the compensator error — must surface to the caller.
    await expect(handle.result()).rejects.toThrow('original saga error');

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 7. Empty steps array.
  //
  //    saga([]) with no steps should complete successfully, returning undefined,
  //    without throwing or calling any compensators.
  // ---------------------------------------------------------------------------

  it('completes successfully with no steps and returns undefined', async () => {
    const engine = new Engine();

    const emptySagaWorkflow = workflow({ name: 'empty-saga' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const result = yield* c.saga([]);
      return result;
    });
    engine.register(emptySagaWorkflow);

    const handle = await engine.start('empty-saga', null);
    const result = await handle.result();

    expect(result).toBeUndefined();

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 8. Execute wrapper is named — regression for anonymous-step observability bug.
  //
  //    ctx.run() derives activityName from fn.name || 'anonymous'. Without an
  //    explicit Object.defineProperty on the execute wrapper, every saga step
  //    would appear as 'anonymous' in the operation request, breaking
  //    observability, logging, and interceptor differentiation by activity name.
  // ---------------------------------------------------------------------------

  it('execute wrapper carries the activity definition name', async () => {
    const engine = new Engine();
    const capturedNames: string[] = [];

    // Intercept the raw activity function name by wrapping the inner execute.
    // We do this by defining a custom activity whose execute fn captures what
    // name ctx.run received from the wrapper.
    const activity = makeActivity({
      name: 'named-activity',
      execute: (_input: string) => 'done',
    });

    const nameCheckSagaWorkflow = workflow({ name: 'name-check-saga' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;

      // Patch ctx.run to record the function name it receives.
      const originalRun = c.run.bind(c);
      c.run = function* (fn: (input?: unknown) => unknown, input?: unknown) {
        capturedNames.push(fn.name);
        if (arguments.length === 1) {
          return yield* originalRun(fn);
        }
        return yield* originalRun(fn, input);
      } as typeof c.run;

      yield* c.saga([{ definition: activity, input: 'test' }]);
    });
    engine.register(nameCheckSagaWorkflow);

    const handle = await engine.start('name-check-saga', null);
    await handle.result();

    // The execute wrapper must carry the activity's definition name, not 'anonymous'.
    expect(capturedNames[0]).toBe('named-activity');

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 9. Input that looks like ActivityCallOptions is not silently swallowed.
  //
  //    ctx.run() applies an isActivityCallOptions heuristic for zero-input
  //    activities. Saga must still pass step.input through the operation so
  //    interceptors and remote workers see the real payload, even when that
  //    payload looks like ActivityCallOptions.
  // ---------------------------------------------------------------------------

  it('delivers input that looks like ActivityCallOptions unchanged to the activity', async () => {
    const engine = new Engine();
    let receivedInput: unknown;

    const activity = makeActivity({
      name: 'options-like-input',
      execute: (input: { queue: string }) => {
        receivedInput = input;
        return 'captured';
      },
    });

    const optionsLikeSagaWorkflow = workflow({ name: 'options-like-saga' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        // This input has a 'queue' key, which is a DISCRIMINATOR_KEYS member.
        // If ctx.run() classified every final { queue } object as options, this
        // would be stripped and the activity would receive undefined.
        yield* c.saga([{ definition: activity, input: { queue: 'orders' } }]);
      },
    );
    engine.register(optionsLikeSagaWorkflow);

    const handle = await engine.start('options-like-saga', null);
    await handle.result();

    // The activity must have received the full object, not undefined.
    expect(receivedInput).toEqual({ queue: 'orders' });

    engine[Symbol.dispose]();
  });

  it('passes saga step input through workflow activity interceptors', async () => {
    const engine = new Engine();
    const observedInputs: unknown[] = [];

    const interceptor: WorkflowInterceptor = {
      *activity(interception, next) {
        observedInputs.push(interception.input);
        return yield* next(interception);
      },
    };

    engine.addInterceptor(interceptor);

    const activity = makeActivity({
      name: 'intercepted-saga-step',
      execute: (input: { queue: string }) => `processed:${input.queue}`,
    });

    const interceptedSagaWorkflow = workflow({ name: 'intercepted-saga' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.saga([{ definition: activity, input: { queue: 'orders' } }]);
    });
    engine.register(interceptedSagaWorkflow);

    const handle = await engine.start('intercepted-saga', null);
    await expect(handle.result()).resolves.toBe('processed:orders');
    expect(observedInputs).toEqual([{ queue: 'orders' }]);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 10. ActivityContext is forwarded to the execute wrapper — regression for
  //     the zero-arg wrapper that dropped the engine-injected context.
  //
  //     When the engine calls an activity it appends the ActivityContext as the
  //     last positional argument. A wrapper that ignores all args silently
  //     discards that context, preventing activities from sending heartbeats or
  //     checking the abort signal. The execute wrapper must forward the context.
  // ---------------------------------------------------------------------------

  it('forwards ActivityContext to execute so heartbeat and signal are available', async () => {
    const engine = new Engine();
    let receivedContext: ActivityContext | undefined;

    const activity: ActivityDefinition<string, string> = {
      name: 'context-capturing',
      execute: async (input: string, context?: ActivityContext) => {
        receivedContext = context;
        return `done:${input}`;
      },
    };

    const contextForwardingSagaWorkflow = workflow({ name: 'context-forwarding-saga' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        yield* c.saga([{ definition: activity, input: 'hello' }]);
      },
    );
    engine.register(contextForwardingSagaWorkflow);

    const handle = await engine.start('context-forwarding-saga', null);
    await handle.result();

    // The activity must have received an ActivityContext (not undefined).
    // Without context forwarding in the execute wrapper, this would be undefined.
    expect(receivedContext).toBeDefined();
    expect(typeof receivedContext?.signal).toBe('object');
    expect(typeof receivedContext?.heartbeat).toBe('function');

    engine[Symbol.dispose]();
  });
});
