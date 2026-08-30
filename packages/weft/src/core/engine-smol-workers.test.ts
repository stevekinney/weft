import { describe, expect, it } from 'bun:test';

import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { activity, workflow } from './types.ts';

// ---------------------------------------------------------------------------
// Worker URLs for integration tests
// ---------------------------------------------------------------------------

const activityWorkerUrl = new URL('../workers/test-activity-worker.ts', import.meta.url);

// ---------------------------------------------------------------------------
// Tests: smol: true option through Engine configuration
// ---------------------------------------------------------------------------

describe('Engine with smol: true workers', () => {
  // -------------------------------------------------------------------------
  // Activity execution with smol
  // -------------------------------------------------------------------------

  describe('activityExecution with smol: true', () => {
    it('executes an activity in a smol worker', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
          smol: true,
        },
      });

      const greet = activity({
        name: 'greet',
        execute: async (input: unknown) => `hello ${String(input)}`,
      });

      const smolGreetWorkflow = workflow({ name: 'smol-greet' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(greet, input);
        return result;
      });
      engine.register(smolGreetWorkflow);

      const handle = await engine.start('smol-greet', 'world');
      const result = await handle.result();
      expect(result).toBe('hello world');

      engine[Symbol.dispose]();
    });

    it('handles concurrent workflows with smol activity workers', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 2,
          smol: true,
        },
      });

      const double = activity({
        name: 'double',
        execute: async (input: unknown) => (input as number) * 2,
      });

      const smolDoubleWorkflow = workflow({ name: 'smol-double' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(double, input);
        return result;
      });
      engine.register(smolDoubleWorkflow);

      const handles = await Promise.all([
        engine.start('smol-double', 1),
        engine.start('smol-double', 2),
        engine.start('smol-double', 3),
      ]);

      const results = await Promise.all(handles.map((handle) => handle.result()));
      expect(results).toEqual([2, 4, 6]);

      engine[Symbol.dispose]();
    });

    it('propagates errors from smol activity workers', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 1,
          smol: true,
        },
      });

      const failing = activity({
        name: 'failingActivity',
        execute: async () => {
          throw new Error('boom');
        },
      });

      const smolFailingWorkflow = workflow({ name: 'smol-failing' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const result = yield* ctx.run(failing);
        return result;
      });
      engine.register(smolFailingWorkflow);

      const handle = await engine.start('smol-failing', null);

      await expect(handle.result()).rejects.toThrow();

      engine[Symbol.dispose]();
    });
  });

  // -------------------------------------------------------------------------
  // smol defaults to false when omitted
  // -------------------------------------------------------------------------

  describe('smol defaults', () => {
    it('works without smol option (defaults to false)', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 1,
        },
      });

      const greet = activity({
        name: 'greet',
        execute: async (input: unknown) => `hello ${String(input)}`,
      });

      const noSmolGreetWorkflow = workflow({ name: 'no-smol-greet' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const result = yield* ctx.run(greet, input);
        return result;
      });
      engine.register(noSmolGreetWorkflow);

      const handle = await engine.start('no-smol-greet', 'default');
      const result = await handle.result();
      expect(result).toBe('hello default');

      engine[Symbol.dispose]();
    });

    it('works with smol explicitly set to false', async () => {
      const engine = new Engine({
        activityExecution: {
          workerUrl: activityWorkerUrl,
          poolSize: 1,
          smol: false,
        },
      });

      const greet = activity({
        name: 'greet',
        execute: async (input: unknown) => `hello ${String(input)}`,
      });

      const explicitNoSmolWorkflow = workflow({ name: 'explicit-no-smol' }).execute(
        async function* (ctx: WorkflowContext, input: unknown) {
          const result = yield* ctx.run(greet, input);
          return result;
        },
      );
      engine.register(explicitNoSmolWorkflow);

      const handle = await engine.start('explicit-no-smol', 'explicit');
      const result = await handle.result();
      expect(result).toBe('hello explicit');

      engine[Symbol.dispose]();
    });
  });
});
