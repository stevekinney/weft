/**
 * Tests for cancellation teardown hooks and saga compensation on cancel.
 *
 * ctx.onCancel(handler) registers an async handler that runs when the
 * workflow is cancelled, before the workflow finalizes as cancelled.
 * Handlers run in registration order; failures are swallowed.
 *
 * When a saga is cancelled mid-execution, already-completed steps'
 * compensate functions run in reverse order (last-completed first).
 */

import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import type { ActivityDefinition, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

// ---------------------------------------------------------------------------
// Helper — deferred promise
// ---------------------------------------------------------------------------

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  const result = {} as {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
  result.promise = new Promise<T>((resolve, reject) => {
    result.resolve = resolve;
    result.reject = reject;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Helper — simple activity builder
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
// 1. ctx.onCancel — basic handler fires on cancel
// ---------------------------------------------------------------------------

describe('ctx.onCancel()', () => {
  it('runs the handler when the workflow is cancelled', async () => {
    const engine = new Engine();
    const onCancelRan: string[] = [];

    const cancelWorkflow = workflow({ name: 'on-cancel-basic' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => {
        onCancelRan.push('handler-ran');
      });
      yield* ctx.waitForSignal('never');
    });
    engine.register(cancelWorkflow);

    const handle = await engine.start('on-cancel-basic', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(onCancelRan).toEqual(['handler-ran']);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 2. Multiple handlers run in registration order
  // -------------------------------------------------------------------------

  it('runs multiple handlers in registration order', async () => {
    const engine = new Engine();
    const order: string[] = [];

    const multiHandlerWorkflow = workflow({ name: 'on-cancel-multi' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => void order.push('first'));
      ctx.onCancel(() => void order.push('second'));
      ctx.onCancel(() => void order.push('third'));
      yield* ctx.waitForSignal('never');
    });
    engine.register(multiHandlerWorkflow);

    const handle = await engine.start('on-cancel-multi', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(order).toEqual(['first', 'second', 'third']);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 3. Handler failure is swallowed — workflow still finalizes as cancelled
  // -------------------------------------------------------------------------

  it('swallows handler errors and still finalizes as cancelled', async () => {
    const engine = new Engine();
    let afterFailure = false;

    const throwingHandlerWorkflow = workflow({ name: 'on-cancel-throw' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => {
        throw new Error('handler exploded');
      });
      ctx.onCancel(() => {
        afterFailure = true;
      });
      yield* ctx.waitForSignal('never');
    });
    engine.register(throwingHandlerWorkflow);

    const handle = await engine.start('on-cancel-throw', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(afterFailure).toBe(true);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 4. Handler does not fire on normal completion
  // -------------------------------------------------------------------------

  it('does not call the handler when the workflow completes normally', async () => {
    const engine = new Engine();
    let cancelFired = false;

    const normalCompletionWorkflow = workflow({ name: 'on-cancel-no-fire' }).execute(
      async function* (ctx: WorkflowContext) {
        ctx.onCancel(() => {
          cancelFired = true;
        });
        return 'done';
      },
    );
    engine.register(normalCompletionWorkflow);

    const handle = await engine.start('on-cancel-no-fire', null);
    await expect(handle.result()).resolves.toBe('done');

    expect(cancelFired).toBe(false);

    engine[Symbol.dispose]();
  });

  it('does not call handlers when cancellation loses the terminal race', async () => {
    const engine = new Engine();
    let cancelFired = false;

    const fastWorkflow = workflow({ name: 'on-cancel-race-no-fire' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => {
        cancelFired = true;
      });
      return 'done';
    });
    engine.register(fastWorkflow);

    const handle = await engine.start('on-cancel-race-no-fire', null);
    await expect(handle.result()).resolves.toBe('done');

    await engine.cancel(handle.id);
    expect(cancelFired).toBe(false);

    engine[Symbol.dispose]();
  });

  it('does not call the handler when the workflow times out', async () => {
    const engine = new Engine();
    let cancelFired = false;

    const timeoutWorkflow = workflow({ name: 'on-cancel-timeout' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => {
        cancelFired = true;
      });
      yield* ctx.waitForSignal('never');
    });
    engine.register(timeoutWorkflow);

    const handle = await engine.start('on-cancel-timeout', null);
    await flush();

    await engine.timeout(handle.id);

    await expect(handle.result()).rejects.toThrow('exceeded execution timeout');
    expect(cancelFired).toBe(false);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 5. Async handler awaited before workflow finalizes
  // -------------------------------------------------------------------------

  it('awaits async handlers before the workflow finalizes', async () => {
    const engine = new Engine();
    const sequence: string[] = [];

    const asyncHandlerWorkflow = workflow({ name: 'on-cancel-async' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        sequence.push('async-handler-done');
      });
      yield* ctx.waitForSignal('never');
    });
    engine.register(asyncHandlerWorkflow);

    const handle = await engine.start('on-cancel-async', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(sequence).toEqual(['async-handler-done']);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 6. Handler registered after a park (post-resume) still fires on cancel
  // -------------------------------------------------------------------------

  it('runs a handler registered after the workflow resumes from a park', async () => {
    const engine = new Engine();
    const ran: string[] = [];

    const postResumeWorkflow = workflow({ name: 'on-cancel-post-resume' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('resume');
      ctx.onCancel(() => void ran.push('post-resume'));
      yield* ctx.waitForSignal('never');
    });
    engine.register(postResumeWorkflow);

    const handle = await engine.start('on-cancel-post-resume', null);
    await flush();

    await engine.signal(handle.id, 'resume', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(ran).toEqual(['post-resume']);

    engine[Symbol.dispose]();
  });

  it('does not duplicate a pre-park handler when the workflow resumes from a park', async () => {
    const engine = new Engine();
    const ran: string[] = [];

    const preParkWorkflow = workflow({ name: 'on-cancel-pre-park-resume' }).execute(
      async function* (ctx: WorkflowContext) {
        ctx.onCancel(() => void ran.push('pre-park'));
        yield* ctx.waitForSignal('resume');
        yield* ctx.waitForSignal('never');
      },
    );
    engine.register(preParkWorkflow);

    const handle = await engine.start('on-cancel-pre-park-resume', null);
    await flush();

    await engine.signal(handle.id, 'resume', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(ran).toEqual(['pre-park']);

    engine[Symbol.dispose]();
  });

  it('runs cancellation handlers for workflows launched from a checkpoint', async () => {
    const engine = new Engine();
    const ranForWorkflowIds: string[] = [];

    const forkedWorkflow = workflow({ name: 'on-cancel-forked-checkpoint' }).execute(
      async function* (ctx: WorkflowContext) {
        ctx.onCancel(() => void ranForWorkflowIds.push(ctx.workflowId));
        yield* ctx.waitForSignal('never');
      },
    );
    engine.register(forkedWorkflow);

    const original = await engine.start('on-cancel-forked-checkpoint', null);
    await flush();

    const forked = await engine.fork(original.id);
    await flush();

    await engine.cancel(forked.id);

    await expect(forked.result()).rejects.toThrow('Workflow cancelled');
    expect(ranForWorkflowIds).toEqual([forked.id]);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// 7. saga compensation on cancel — in-progress saga compensates already-
//    completed steps in reverse order when the workflow is cancelled.
// ---------------------------------------------------------------------------

describe('ctx.saga() — cancellation compensation', () => {
  it('compensates already-completed steps in reverse order when cancelled mid-saga', async () => {
    const engine = new Engine();
    const compensationOrder: string[] = [];

    const gate = deferred();

    const step1 = makeActivity({
      name: 'step-one',
      execute: (_input: string) => 'out-one',
      compensate: (_input, _output) => {
        compensationOrder.push('step-one');
      },
    });

    const step2 = makeActivity({
      name: 'step-two',
      execute: (_input: string) => 'out-two',
      compensate: (_input, _output) => {
        compensationOrder.push('step-two');
      },
    });

    const step3 = makeActivity({
      name: 'step-three',
      execute: async (_input: string) => {
        await gate.promise;
        return 'out-three';
      },
      compensate: (_input, _output) => {
        compensationOrder.push('step-three-should-not-run');
      },
    });

    const sagaCancelWorkflow = workflow({ name: 'saga-cancel' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.saga([
        { definition: step1, input: 'a' },
        { definition: step2, input: 'b' },
        { definition: step3, input: 'c' },
      ]);
    });
    engine.register(sagaCancelWorkflow);

    const handle = await engine.start('saga-cancel', null);
    await flush();

    await engine.cancel(handle.id);
    gate.resolve();

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');

    // Steps 1 and 2 completed before cancel, so their compensators run in reverse.
    // Step 3 was in-flight (not completed) so its compensator must NOT run.
    expect(compensationOrder).toEqual(['step-two', 'step-one']);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 7. Compensate receives correct input and output
  // -------------------------------------------------------------------------

  it('passes correct input and output to each compensator on cancellation', async () => {
    const engine = new Engine();
    const compensatorArgs: Array<{ input: string; output: string }> = [];

    const gate = deferred();

    const trackingActivity = makeActivity({
      name: 'tracking',
      execute: (input: string) => `processed:${input}`,
      compensate: (input: string, output: string) => {
        compensatorArgs.push({ input, output });
      },
    });

    const blockingActivity = makeActivity({
      name: 'blocking',
      execute: async (_input: string) => {
        await gate.promise;
        return 'never';
      },
    });

    const argCheckCancelWorkflow = workflow({ name: 'arg-check-cancel-saga' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.saga([
          { definition: trackingActivity, input: 'alpha' },
          { definition: trackingActivity, input: 'beta' },
          { definition: blockingActivity, input: 'gamma' },
        ]);
      },
    );
    engine.register(argCheckCancelWorkflow);

    const handle = await engine.start('arg-check-cancel-saga', null);
    await flush();

    await engine.cancel(handle.id);
    gate.resolve();

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');

    // Compensators run in reverse (beta first, then alpha) with correct args.
    expect(compensatorArgs).toHaveLength(2);
    expect(compensatorArgs[0]).toEqual({ input: 'beta', output: 'processed:beta' });
    expect(compensatorArgs[1]).toEqual({ input: 'alpha', output: 'processed:alpha' });

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 8. Compensation is idempotent — a failed step also compensates, but
  //    cancellation must not double-compensate.
  // -------------------------------------------------------------------------

  it('does not double-compensate steps that were compensated by a step failure', async () => {
    const engine = new Engine();
    let compensatorCallCount = 0;

    const passing = makeActivity({
      name: 'passing',
      execute: (_input: string) => 'ok',
      compensate: (_input, _output) => {
        compensatorCallCount++;
      },
    });

    const failing = makeActivity({
      name: 'failing',
      execute: (_input: string): string => {
        throw new Error('step failed');
      },
    });

    const failBeforeCancelWorkflow = workflow({ name: 'fail-not-cancel-saga' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.saga([
          { definition: passing, input: 'x' },
          { definition: failing, input: 'y' },
        ]);
      },
    );
    engine.register(failBeforeCancelWorkflow);

    const handle = await engine.start('fail-not-cancel-saga', null);
    await expect(handle.result()).rejects.toThrow('step failed');

    // Compensator for 'passing' must have run exactly once via error path.
    expect(compensatorCallCount).toBe(1);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 9. No compensation when saga has no completed steps (cancelled before
  //    the first step finishes)
  // -------------------------------------------------------------------------

  it('does not call any compensators when no steps have completed on cancel', async () => {
    const engine = new Engine();
    let compensatorCalls = 0;

    const gate = deferred();

    const step = makeActivity({
      name: 'never-completes',
      execute: async (_input: string) => {
        await gate.promise;
        return 'done';
      },
      compensate: (_input, _output) => {
        compensatorCalls++;
      },
    });

    const noneCompletedWorkflow = workflow({ name: 'none-completed-saga' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.saga([{ definition: step, input: 'x' }]);
      },
    );
    engine.register(noneCompletedWorkflow);

    const handle = await engine.start('none-completed-saga', null);
    await flush();

    await engine.cancel(handle.id);
    gate.resolve();

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');

    expect(compensatorCalls).toBe(0);

    engine[Symbol.dispose]();
  });

  it('does not compensate a saga that completed before the workflow is cancelled', async () => {
    const engine = new Engine();
    const compensationOrder: string[] = [];

    const completedStep = makeActivity({
      name: 'completed-before-later-cancel',
      execute: (_input: string) => 'done',
      compensate: (_input, _output) => {
        compensationOrder.push('should-not-run');
      },
    });

    const completedSagaThenParkWorkflow = workflow({
      name: 'completed-saga-then-cancel',
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.saga([{ definition: completedStep, input: 'x' }]);
      yield* ctx.waitForSignal('never');
    });
    engine.register(completedSagaThenParkWorkflow);

    const handle = await engine.start('completed-saga-then-cancel', null);
    await flush();

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(compensationOrder).toEqual([]);

    engine[Symbol.dispose]();
  });

  // -------------------------------------------------------------------------
  // 10. Engine restart: cancellation that ran compensators does not re-run
  //     them on engine restart (workflow is already terminal).
  // -------------------------------------------------------------------------

  it('does not re-run compensators after engine restart when already cancelled', async () => {
    const storage = new MemoryStorage();
    let compensatorCallCount = 0;

    const gate = deferred();

    function buildStep() {
      const step1 = makeActivity({
        name: 'step-one',
        execute: (_input: string) => 'out-one',
        compensate: (_input, _output) => {
          compensatorCallCount++;
        },
      });

      const step2 = makeActivity({
        name: 'step-two',
        execute: async (_input: string) => {
          await gate.promise;
          return 'out-two';
        },
      });

      return { step1, step2 };
    }

    function registerWorkflow(engine: Engine): void {
      const { step1, step2 } = buildStep();
      const sagaRestartWorkflow = workflow({ name: 'saga-restart-cancel' }).execute(
        async function* (ctx: WorkflowContext) {
          yield* ctx.saga([
            { definition: step1, input: 'a' },
            { definition: step2, input: 'b' },
          ]);
        },
      );
      engine.register(sagaRestartWorkflow);
    }

    const engine1 = new Engine({ storage });
    registerWorkflow(engine1);

    const handle1 = await engine1.start('saga-restart-cancel', null, {
      id: 'cancel-restart-wf',
    });
    await flush();

    await engine1.cancel(handle1.id);
    gate.resolve();

    await expect(handle1.result()).rejects.toThrow('Workflow cancelled');
    expect(compensatorCallCount).toBe(1);

    engine1[Symbol.dispose]();

    compensatorCallCount = 0;

    const engine2 = new Engine({ storage });
    registerWorkflow(engine2);

    const recovered = await engine2.recoverAll();
    await flush();

    expect(recovered).toHaveLength(0);
    expect(compensatorCallCount).toBe(0);

    engine2[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Race condition: handlers must not fire on an already-terminal workflow
// ---------------------------------------------------------------------------

describe('cancel-handler race condition', () => {
  // Note: in the single JS event loop, two concurrent async calls interleave at
  // `await` boundaries. This test validates the at-most-once outcome: handlers
  // must not fire more than once regardless of interleave order. The invariant
  // is enforced by gating `runCancellationHandlersForStatus` behind the storage
  // conditional-batch result — exactly one caller wins the state transition.
  it('does not run cancel handlers when the workflow is already terminal', async () => {
    let handlerCallCount = 0;

    const racingWorkflow = workflow({ name: 'racing-cancel-wf' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => {
        handlerCallCount++;
      });
      yield* ctx.waitForSignal('never');
    });

    const engine = new Engine();
    engine.register(racingWorkflow);

    const handle = await engine.start('racing-cancel-wf', null, { id: 'race-wf' });
    await flush();

    // Fire two concurrent cancels — only the first should commit the state
    // transition; the second must see the already-terminal state and skip handlers.
    await Promise.allSettled([engine.cancel(handle.id), engine.cancel(handle.id)]);
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');

    // Handler must fire exactly once — not twice due to the race.
    expect(handlerCallCount).toBe(1);

    engine[Symbol.dispose]();
  });

  it('does not run cancel handlers when the workflow times out', async () => {
    let handlerCallCount = 0;

    const timedOutWorkflow = workflow({ name: 'racing-timeout-wf' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      ctx.onCancel(() => {
        handlerCallCount++;
      });
      yield* ctx.waitForSignal('never');
    });

    const engine = new Engine();
    engine.register(timedOutWorkflow);

    const handle = await engine.start('racing-timeout-wf', null, { id: 'race-timeout-wf' });
    await flush();

    await engine.timeout(handle.id);
    await expect(handle.result()).rejects.toThrow('exceeded execution timeout');

    // Cancel handlers must never fire on timeout — they are scoped to cancellation only.
    expect(handlerCallCount).toBe(0);

    engine[Symbol.dispose]();
  });
});
