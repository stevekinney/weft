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
