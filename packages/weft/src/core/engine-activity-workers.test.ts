import { describe, expect, it } from 'bun:test';

import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { activity, workflow } from './types.ts';

// ---------------------------------------------------------------------------
// Test activity worker URL — uses test-activity-worker.ts which registers
// greet, double, asyncDouble, failingActivity, and slowActivity.
// ---------------------------------------------------------------------------

const activityWorkerUrl = new URL('../workers/test-activity-worker.ts', import.meta.url);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Engine with activity worker execution', () => {
  // -------------------------------------------------------------------------
  // Basic activity execution in workers
  // -------------------------------------------------------------------------

  describe('basic execution', () => {
    it('executes a synchronous activity in a worker', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
        },
      });

      const greet = activity({
        name: 'greet',
        execute: async (input: unknown) => `hello ${String(input)}`,
      });

      const greetWorkflowWorkflow = workflow({ name: 'greet-workflow' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(greet, input);
        return result;
      });
      engine.register(greetWorkflowWorkflow);

      const handle = await engine.start('greet-workflow', 'world');
      const result = await handle.result();
      expect(result).toBe('hello world');

      engine[Symbol.dispose]();
    });

    it('executes an async activity in a worker', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
        },
      });

      const asyncDouble = activity({
        name: 'asyncDouble',
        execute: async (input: unknown) => (input as number) * 2,
      });

      const asyncDoubleWorkflow = workflow({ name: 'async-double' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(asyncDouble, input);
        return result;
      });
      engine.register(asyncDoubleWorkflow);

      const handle = await engine.start('async-double', 21);
      const result = await handle.result();
      expect(result).toBe(42);

      engine[Symbol.dispose]();
    });

    it('executes saga activity input through a worker-backed operation', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
        },
      });

      const double = activity({
        name: 'double',
        execute: async (input: number) => input * 2,
      });

      const workerSagaWorkflow = workflow({ name: 'worker-saga' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.saga([{ definition: double, input: 21 }]);
      });
      engine.register(workerSagaWorkflow);

      const handle = await engine.start('worker-saga', null);
      await expect(handle.result()).resolves.toBe(42);

      engine[Symbol.dispose]();
    });
  });

  // -------------------------------------------------------------------------
  // Multi-step workflows
  // -------------------------------------------------------------------------

  describe('multi-step workflows', () => {
    it('executes multiple activities sequentially in workers', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
        },
      });

      const greet = activity({
        name: 'greet',
        execute: async (input: unknown) => `hello ${String(input)}`,
      });

      const double = activity({
        name: 'double',
        execute: async (input: unknown) => (input as number) * 2,
      });

      const multiStepWorkflow = workflow({ name: 'multi-step' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const data = input as { name: string; value: number };
        const greeting = yield* ctx.run(greet, data.name);
        const doubled = yield* ctx.run(double, data.value);
        return { greeting, doubled };
      });
      engine.register(multiStepWorkflow);

      const handle = await engine.start('multi-step', { name: 'test', value: 5 });
      const result = await handle.result();
      expect(result).toEqual({ greeting: 'hello test', doubled: 10 });

      engine[Symbol.dispose]();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('propagates activity failures from workers', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
        },
      });

      const failing = activity({
        name: 'failingActivity',
        execute: async () => {
          throw new Error('boom');
        },
      });

      const failingWorkflowWorkflow = workflow({ name: 'failing-workflow' }).execute(
        async function* (ctx: WorkflowContext) {
          const result = yield* ctx.run(failing);
          return result;
        },
      );
      engine.register(failingWorkflowWorkflow);

      const handle = await engine.start('failing-workflow', null);

      await expect(handle.result()).rejects.toThrow();

      engine[Symbol.dispose]();
    });

    it('handles unknown activities gracefully', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
        },
      });

      const unknown = activity({
        name: 'nonexistent-activity',
        execute: async () => 'should not reach',
      });

      const unknownActivityWorkflowWorkflow = workflow({
        name: 'unknown-activity-workflow',
      }).execute(async function* (ctx: WorkflowContext) {
        const result = yield* ctx.run(unknown);
        return result;
      });
      engine.register(unknownActivityWorkflowWorkflow);

      const handle = await engine.start('unknown-activity-workflow', null);

      await expect(handle.result()).rejects.toThrow();

      engine[Symbol.dispose]();
    });
  });

  // -------------------------------------------------------------------------
  // Configurable pool size
  // -------------------------------------------------------------------------

  describe('configurable pool size', () => {
    it('defaults pool size to 4 when not specified', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
        },
      });

      const greet = activity({
        name: 'greet',
        execute: async (input: unknown) => `hello ${String(input)}`,
      });

      const defaultPoolWorkflow = workflow({ name: 'default-pool' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(greet, input);
        return result;
      });
      engine.register(defaultPoolWorkflow);

      const handle = await engine.start('default-pool', 'test');
      const result = await handle.result();
      expect(result).toBe('hello test');

      engine[Symbol.dispose]();
    });

    it('works with pool size of 1', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 1,
        },
      });

      const double = activity({
        name: 'double',
        execute: async (input: unknown) => (input as number) * 2,
      });

      const pool1Workflow = workflow({ name: 'pool-1' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(double, input);
        return result;
      });
      engine.register(pool1Workflow);

      const handle = await engine.start('pool-1', 7);
      const result = await handle.result();
      expect(result).toBe(14);

      engine[Symbol.dispose]();
    });

    it('supports concurrent workflows with larger pool', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 4,
        },
      });

      const double = activity({
        name: 'double',
        execute: async (input: unknown) => (input as number) * 2,
      });

      const concurrentWorkflow = workflow({ name: 'concurrent' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(double, input);
        return result;
      });
      engine.register(concurrentWorkflow);

      // Start 4 workflows concurrently
      const handles = await Promise.all([
        engine.start('concurrent', 1),
        engine.start('concurrent', 2),
        engine.start('concurrent', 3),
        engine.start('concurrent', 4),
      ]);

      const results = await Promise.all(handles.map((handle) => handle.result()));
      expect(results).toEqual([2, 4, 6, 8]);

      engine[Symbol.dispose]();
    });
  });

  // -------------------------------------------------------------------------
  // Without activity execution (baseline)
  // -------------------------------------------------------------------------

  describe('without activityExecution (inline baseline)', () => {
    it('still works inline when activityExecution is not configured', async () => {
      const engine = new Engine();

      const doubleInline = async (...args: unknown[]) => (args[0] as number) * 2;

      const inlineWorkflow = workflow({ name: 'inline' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(doubleInline, input);
        return result;
      });
      engine.register(inlineWorkflow);

      const handle = await engine.start('inline', 5);
      const result = await handle.result();
      expect(result).toBe(10);

      engine[Symbol.dispose]();
    });
  });
});
