import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { MemoryStorage } from '../storage/memory';
import { Engine } from './engine';
import {
  compileStepWorkflow,
  isAsyncGeneratorFunction,
  isGeneratorFunction,
  isGeneratorResult,
} from './step-context';
import type { StepWorkflowContext, WorkflowContext } from './types';
import { workflow } from './types';

describe('step-context', () => {
  it('runs a simple step workflow', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const greetingWorkflow = workflow({ name: 'greeting' }).execute(
      compileStepWorkflow(async (ctx: StepWorkflowContext, input: unknown) => {
        const { name } = input as { name: string };
        const greeting = await ctx.step('greet', () => `Hello, ${name}!`);
        const notification = await ctx.step('notify', () => `Notified: ${greeting}`);
        return { greeting, notification };
      }),
    );
    engine.register(greetingWorkflow);

    const handle = await engine.start('greeting', { name: 'World' });
    const result = await handle.result();

    expect(result).toEqual({
      greeting: 'Hello, World!',
      notification: 'Notified: Hello, World!',
    });
  });

  it('executes multiple steps in sequence', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const callOrder: string[] = [];

    const sequentialWorkflow = workflow({ name: 'sequential' }).execute(
      compileStepWorkflow(async (ctx: StepWorkflowContext, _input: unknown) => {
        await ctx.step('first', () => {
          callOrder.push('first');
          return 1;
        });
        await ctx.step('second', () => {
          callOrder.push('second');
          return 2;
        });
        await ctx.step('third', () => {
          callOrder.push('third');
          return 3;
        });
        return callOrder;
      }),
    );
    engine.register(sequentialWorkflow);

    const handle = await engine.start('sequential', {});
    await handle.result();

    expect(callOrder).toEqual(['first', 'second', 'third']);
  });

  it('handles async step functions', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const asyncStepsWorkflow = workflow({ name: 'async-steps' }).execute(
      compileStepWorkflow(async (ctx: StepWorkflowContext, _input: unknown) => {
        const value = await ctx.step('fetch', async () => {
          await sleepForTesting(1);
          return 42;
        });
        const doubled = await ctx.step('double', async () => {
          await sleepForTesting(1);
          return value * 2;
        });
        return { value, doubled };
      }),
    );
    engine.register(asyncStepsWorkflow);

    const handle = await engine.start('async-steps', {});
    const result = await handle.result();

    expect(result).toEqual({ value: 42, doubled: 84 });
  });

  it('propagates step errors to the workflow', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    const errorStepWorkflow = workflow({ name: 'error-step' }).execute(
      compileStepWorkflow(async (ctx: StepWorkflowContext, _input: unknown) => {
        await ctx.step('will-fail', () => {
          throw new Error('Step failed intentionally');
        });
        return 'should not reach here';
      }),
    );
    engine.register(errorStepWorkflow);

    const handle = await engine.start('error-step', {});
    await expect(handle.result()).rejects.toThrow('Step failed intentionally');
  });

  it('auto-detects step functions in register()', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    // Register a step-based workflow (plain async function)
    const stepBasedWorkflow = workflow({ name: 'step-based' }).execute(
      compileStepWorkflow(async (ctx: StepWorkflowContext, input: unknown) => {
        const { value } = input as { value: number };
        const result = await ctx.step('compute', () => value * 10);
        return result;
      }),
    );
    engine.register(stepBasedWorkflow);

    const handle = await engine.start('step-based', { value: 5 });
    const result = await handle.result();

    expect(result).toBe(50);
  });

  it('coexists with generator-based workflows on the same engine', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    // Register a step-based workflow
    const stepWorkflowWorkflow = workflow({ name: 'step-workflow' }).execute(
      compileStepWorkflow(async (ctx: StepWorkflowContext, input: unknown) => {
        const { name } = input as { name: string };
        const greeting = await ctx.step('greet', () => `Hi, ${name}!`);
        return greeting;
      }),
    );
    engine.register(stepWorkflowWorkflow);

    // Register a generator-based workflow
    const generatorWorkflowWorkflow = workflow({ name: 'generator-workflow' }).execute(
      async function* (ctx: WorkflowContext, input: unknown) {
        const context = ctx;
        const { name } = input as { name: string };
        const greeting = yield* context.run(async () => `Hello, ${name}!`);
        return greeting;
      },
    );
    engine.register(generatorWorkflowWorkflow);

    const stepHandle = await engine.start('step-workflow', { name: 'Alice' });
    const generatorHandle = await engine.start('generator-workflow', { name: 'Bob' });

    const stepResult = await stepHandle.result();
    const generatorResult = await generatorHandle.result();

    expect(stepResult).toBe('Hi, Alice!');
    expect(generatorResult).toBe('Hello, Bob!');
  });

  it('compileStepWorkflow produces a valid generator function', async () => {
    const stepFunction = async (ctx: StepWorkflowContext, input: unknown) => {
      const { x } = input as { x: number };
      const result = await ctx.step('multiply', () => x * 3);
      return result;
    };

    const compiled = compileStepWorkflow(stepFunction);

    // The compiled function should be an async generator function
    expect(typeof compiled).toBe('function');

    // Use it through the engine to verify it works as a WorkflowFunction
    const engine = new Engine({ storage: new MemoryStorage() });
    const compiledWorkflow = workflow({ name: 'compiled' }).execute(compiled);
    engine.register(compiledWorkflow);

    const handle = await engine.start('compiled', { x: 7 });
    const result = await handle.result();

    expect(result).toBe(21);
  });

  it('isAsyncGeneratorFunction correctly identifies function types', () => {
    const asyncGenerator = async function* () {
      yield 1;
    };
    const plainAsync = async () => 42;
    const syncFunction = () => 42;
    const syncGenerator = function* () {
      yield 1;
    };

    expect(isAsyncGeneratorFunction(asyncGenerator)).toBe(true);
    expect(isAsyncGeneratorFunction(plainAsync)).toBe(false);
    expect(isAsyncGeneratorFunction(syncFunction)).toBe(false);
    expect(isAsyncGeneratorFunction(syncGenerator)).toBe(false);
  });

  it('isGeneratorFunction correctly identifies sync generator functions', () => {
    const syncGenerator = function* () {
      yield 1;
    };
    const plainFunction = () => 42;

    expect(isGeneratorFunction(syncGenerator)).toBe(true);
    expect(isGeneratorFunction(plainFunction)).toBe(false);
  });

  it('does not trust spoofed constructor names when identifying generator functions', () => {
    const plainFunction = () => 42;
    const plainAsyncFunction = async () => 42;

    Object.defineProperty(plainFunction, 'constructor', {
      value: { name: 'GeneratorFunction' },
    });
    Object.defineProperty(plainAsyncFunction, 'constructor', {
      value: { name: 'AsyncGeneratorFunction' },
    });

    expect(isGeneratorFunction(plainFunction)).toBe(false);
    expect(isAsyncGeneratorFunction(plainAsyncFunction)).toBe(false);
  });

  it('isGeneratorResult correctly identifies generator and async generator objects', async () => {
    const syncGeneratorResult = (function* () {
      yield 1;
    })();
    const asyncGeneratorResult = (async function* () {
      yield 1;
    })();

    expect(isGeneratorResult(syncGeneratorResult)).toBe(true);
    expect(isGeneratorResult(asyncGeneratorResult)).toBe(true);
    expect(isGeneratorResult([])).toBe(false);

    await asyncGeneratorResult.return(undefined);
  });

  it('does not treat iterator-shaped objects as generator results', () => {
    const iteratorLike = {
      next() {
        return { done: true, value: undefined };
      },
      throw() {
        return { done: true, value: undefined };
      },
      return() {
        return { done: true, value: undefined };
      },
      [Symbol.iterator]() {
        return this;
      },
    };

    expect(isGeneratorResult(iteratorLike)).toBe(false);
  });
});

describe('step-context durability', () => {
  /** Drain microtasks so fire-and-forget engine work settles. */
  async function flush(): Promise<void> {
    await sleepForTesting(10);
  }

  it('does not re-execute completed steps after a crash and recovery', async () => {
    const storage = new MemoryStorage();

    // Per-step side-effect counters. These survive the "crash" (they live in
    // the closure, not the engine) so we can detect whether a checkpointed step
    // is wrongly re-executed on replay. A happy-path "it resumes" assertion
    // would not catch a positional-slot mismatch — the counter is the
    // discriminator.
    let step1Calls = 0;
    let step2Calls = 0;

    // Step 2 blocks forever on the first engine so the workflow is parked AFTER
    // step 1 is checkpointed but BEFORE step 2 settles — the deterministic crash
    // point. The recovered engine bypasses the gate via `firstEngineActive`, so
    // step 2 completes there. The gate is never resolved: engine 1's parked
    // step-2 fn stays pending after dispose, which is harmless.
    const neverResolves = new Promise<void>(() => {});
    let firstEngineActive = true;

    function makeWorkflow() {
      return workflow({ name: 'durable-steps' }).execute(
        compileStepWorkflow(async (ctx: StepWorkflowContext, input: unknown) => {
          const seed = (input as { seed: string }).seed;
          const r1 = await ctx.step('first', () => {
            step1Calls++;
            return `r1:${seed}`;
          });
          const r2 = await ctx.step('second', async () => {
            step2Calls++;
            // Only the first engine parks at the gate; the recovered engine
            // skips it and completes.
            if (firstEngineActive) await neverResolves;
            return `r2:${r1}`;
          });
          return r2;
        }),
      );
    }

    // --- First engine: step 1 checkpoints, step 2 parks at the gate ---
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());
    await engine1.start('durable-steps', { seed: 'hello' }, { id: 'wf-durable-steps' });
    await flush();

    // Step 1 ran once and completed; step 2 was dispatched (entered fn) but is
    // parked at the gate.
    expect(step1Calls).toBe(1);

    // "Crash" the engine while step 2 is in flight. The recovered engine
    // bypasses the gate via `firstEngineActive = false`; we intentionally do
    // NOT release the gate for the disposed engine 1 (its parked step-2 fn is
    // harmless left pending, and resolving it into a dead engine would be a
    // post-dispose write race that could mask re-execution).
    engine1[Symbol.dispose]();
    firstEngineActive = false;

    // Reset counters to detect re-execution on replay.
    step1Calls = 0;
    step2Calls = 0;

    // --- Second engine: recover ---
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());
    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);

    const result = await handles[0]!.result();
    expect(result).toBe('r2:r1:hello');

    // Step 1 was checkpointed on engine 1 — it MUST NOT re-execute on replay.
    expect(step1Calls).toBe(0);
    // Step 2 was in flight and never checkpointed at the crash — it MUST
    // re-execute exactly once on recovery. This pins the boundary precisely at
    // step 1, so an over-caching bug (step 2 wrongly treated as cached) fails
    // here instead of passing silently.
    expect(step2Calls).toBe(1);

    engine2[Symbol.dispose]();
  });

  it('uses the explicit step name as the durable activity label, not fn.name', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'named-steps' }).execute(
        compileStepWorkflow(async (ctx: StepWorkflowContext) => {
          // A function with its own `.name`: the explicit step name must win,
          // so the timeline label is the step name, not `someInternalName`.
          const namedFn = function someInternalName() {
            return 42;
          };
          await ctx.step('explicit-charge-label', namedFn);
          return 'ok';
        }),
      ),
    );

    const handle = await engine.start('named-steps', null, { id: 'wf-named-step' });
    await handle.result();

    const timeline = await engine.getTimeline('wf-named-step');
    const labels = timeline.map((e) => e.operationLabel);
    expect(labels).toContain('explicit-charge-label');
    expect(labels).not.toContain('someInternalName');

    engine[Symbol.dispose]();
  });

  it('propagates a step error to the awaiting step caller', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'failing-step' }).execute(
        compileStepWorkflow(async (ctx: StepWorkflowContext) => {
          await ctx.step('boom', () => {
            throw new Error('step blew up');
          });
          return 'unreachable';
        }),
      ),
    );

    const handle = await engine.start('failing-step', null, { id: 'wf-failing-step' });
    await expect(handle.result()).rejects.toThrow('step blew up');

    engine[Symbol.dispose]();
  });
});
