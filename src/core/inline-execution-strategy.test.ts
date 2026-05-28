import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { Context } from './context.ts';
import { InlineExecutionStrategy } from './inline-execution-strategy.ts';
import type { WorkerOutboundMessage, WorkflowFunction } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStrategy(
  registrations: Map<string, { handler: WorkflowFunction; version: string }>,
): InlineExecutionStrategy {
  return new InlineExecutionStrategy({
    getRegistration: (type: string) => registrations.get(type),
    getNow: Date.now,
    maxNestingDepth: 10,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InlineExecutionStrategy', () => {
  let strategy: InlineExecutionStrategy;
  let messages: WorkerOutboundMessage[];
  let registrations: Map<string, { handler: WorkflowFunction; version: string }>;

  afterEach(() => {
    strategy?.[Symbol.dispose]();
  });

  function setup(): void {
    registrations = new Map();
    strategy = createStrategy(registrations);
    messages = [];
    strategy.onMessage((message) => {
      messages.push(message);
    });
  }

  /** Return the first message, asserting it exists. */
  function firstMessage(): WorkerOutboundMessage {
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toBeDefined();
    return message!;
  }

  // -------------------------------------------------------------------------
  // startWorkflow
  // -------------------------------------------------------------------------

  describe('startWorkflow', () => {
    it('emits completed for a workflow that returns immediately', async () => {
      setup();

      registrations.set('immediate', {
        handler: async function* (_context, _input) {
          return 'done';
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'immediate',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      // Allow microtask to complete
      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('done');
      }
    });

    it('emits checkpoint for a workflow that yields', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => 42,
            input: undefined,
          };
          return value;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('checkpoint');
    });

    it('emits failed for unknown workflow types', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'nonexistent',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toContain('No workflow registered');
      }
    });

    it('emits failed when the generator throws', async () => {
      setup();

      registrations.set('failing', {
        handler: async function* () {
          throw new Error('boom');
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'failing',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('boom');
      }
    });

    it('tracks the first generator advance immediately after startWorkflow is called', async () => {
      setup();

      let resolveFirstTurn: (() => void) | undefined;
      registrations.set('delayed-first-turn', {
        handler: async function* () {
          await new Promise<void>((resolve) => {
            resolveFirstTurn = resolve;
          });
          return 'done';
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'delayed-first-turn',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      const pendingAdvance = strategy.waitForWorkflowAdvance('wf-1');
      expect(pendingAdvance).toBeDefined();
      expect(resolveFirstTurn).toBeDefined();

      resolveFirstTurn?.();
      await pendingAdvance;

      const message = firstMessage();
      expect(message.type).toBe('completed');
      expect(strategy.waitForWorkflowAdvance('wf-1')).toBeUndefined();
    });

    it('clears tracked workflow turns after an async message handler settles', async () => {
      setup();

      registrations.set('immediate', {
        handler: async function* () {
          return 'done';
        },
        version: '1',
      });

      let resolveHandler: (() => void) | undefined;
      strategy.onMessage(async (message) => {
        messages.push(message);
        await new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'immediate',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      const pendingTurn = strategy.waitForWorkflowTurn('wf-1');
      expect(pendingTurn).toBeDefined();
      expect(resolveHandler).toBeDefined();

      resolveHandler?.();
      await pendingTurn;

      expect(strategy.waitForWorkflowTurn('wf-1')).toBeUndefined();
    });

    it('does not surface unhandled rejections when an async message handler fails and nobody awaits the tracked turn', async () => {
      const script = String.raw`
        import { InlineExecutionStrategy } from './src/core/inline-execution-strategy.ts';

        const strategy = new InlineExecutionStrategy({
          getRegistration: (type) =>
            type === 'immediate'
              ? {
                  handler: async function* () {
                    return 'done';
                  },
                  version: '1',
                }
              : undefined,
          getNow: Date.now,
          maxNestingDepth: 10,
        });

        process.on('unhandledRejection', (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        });

        strategy.onMessage(async () => {
          throw new Error('handler failed');
        });

        strategy.startWorkflow({
          workflowId: 'wf-1',
          workflowType: 'immediate',
          input: null,
          checkpoint: new ArrayBuffer(0),
        });

        // Let a rejected async-handler promise surface as an unhandledRejection
        // before we dispose and exit, without a wall-clock guess: drain the
        // nextTick + microtask queues, then take one zero-delay macrotask turn —
        // the real event-loop boundary at which the rejection would fire,
        // deterministic regardless of CPU load (the old setTimeout(50) flaked).
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => setTimeout(resolve, 0));
        strategy[Symbol.dispose]();
        process.exit(0);
      `;

      const childProcess = Bun.spawn(['bun', '-e', script], {
        cwd: globalThis.process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await childProcess.exited;
      const stdoutText = await new Response(childProcess.stdout).text();
      const stderrText = await new Response(childProcess.stderr).text();
      const stdout = stdoutText.trim();
      const stderr = stderrText.trim();

      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // continueWorkflow
  // -------------------------------------------------------------------------

  describe('continueWorkflow', () => {
    it('feeds a value into the generator and emits completed', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            input: undefined,
          };
          return `got:${String(value)}`;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);
      messages.length = 0;

      strategy.continueWorkflow('wf-1', 42);

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('got:42');
      }
    });
  });

  // -------------------------------------------------------------------------
  // throwIntoWorkflow
  // -------------------------------------------------------------------------

  describe('throwIntoWorkflow', () => {
    it('propagates an error and emits failed when unhandled', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            input: undefined,
          };
          return value;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);
      messages.length = 0;

      strategy.throwIntoWorkflow('wf-1', new Error('activity failed'));

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('activity failed');
      }
    });

    it('allows the generator to catch and recover', async () => {
      setup();

      registrations.set('resilient', {
        handler: async function* (_context, _input) {
          try {
            yield {
              type: 'activity',
              operationId: 'op-1',
              activityName: 'mayFail',
              fn: () => {},
              input: undefined,
            };
          } catch {
            return 'recovered';
          }
          return 'unreachable';
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'resilient',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);
      messages.length = 0;

      strategy.throwIntoWorkflow('wf-1', new Error('oops'));

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('recovered');
      }
    });
  });

  // -------------------------------------------------------------------------
  // cancelWorkflow
  // -------------------------------------------------------------------------

  describe('cancelWorkflow', () => {
    it('cleans up the generator and context', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            input: undefined,
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      expect(strategy.hasGenerator('wf-1')).toBe(true);
      expect(strategy.getContext('wf-1')).toBeDefined();
      expect(strategy.getAbortController('wf-1')).toBeDefined();

      strategy.cancelWorkflow('wf-1');

      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getContext('wf-1')).toBeUndefined();
      expect(strategy.getAbortController('wf-1')).toBeUndefined();
    });

    it('adopts externally created workflow state for resumed workflows', () => {
      setup();

      const abortController = new AbortController();
      const context = new Context({
        workflowId: 'wf-adopted',
        workflowType: 'yielding',
        startedAt: Date.now(),
        abortController,
        getNow: Date.now,
        nestingDepth: 0,
      });
      const generator = (async function* (): AsyncGenerator {
        yield 'checkpoint';
      })();

      strategy.adoptWorkflow('wf-adopted', generator, context, abortController);

      expect(strategy.hasGenerator('wf-adopted')).toBe(true);
      expect(strategy.getContext('wf-adopted')).toBe(context);
      expect(strategy.getAbortController('wf-adopted')).toBe(abortController);
    });
  });

  // -------------------------------------------------------------------------
  // resumeWorkflow (via the ExecutionStrategy interface)
  // -------------------------------------------------------------------------

  describe('resumeWorkflow', () => {
    it('feeds a completed result into the generator', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            input: undefined,
          };
          return `result:${String(value)}`;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'hello' },
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('result:hello');
      }
    });

    it('throws a failed result into the generator', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            input: undefined,
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'failed', error: 'oops' },
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('oops');
      }
    });

    it('preserves failed operation categories when the workflow wraps the operation error', async () => {
      setup();

      registrations.set('wraps-operation-failure', {
        handler: async function* (_context, _input) {
          try {
            yield {
              type: 'activity',
              operationId: 'op-1',
              activityName: 'mayTimeout',
              fn: () => {},
              input: undefined,
            };
          } catch {
            throw new Error('wrapped timeout');
          }
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'wraps-operation-failure',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: {
          status: 'failed',
          error: 'review timed out',
          errorName: 'ReviewTimeoutError',
          failureCategory: 'timeout',
        },
      });

      await sleepForTesting(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('wrapped timeout');
        expect(message.failureCategory).toBe('timeout');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  describe('disposal', () => {
    it('clears all state on dispose', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            input: undefined,
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await sleepForTesting(10);

      strategy[Symbol.dispose]();

      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getContext('wf-1')).toBeUndefined();
    });

    it('supports explicit async disposal', async () => {
      setup();

      await expect(strategy[Symbol.asyncDispose]()).resolves.toBeUndefined();
      expect(() => strategy[Symbol.dispose]()).not.toThrow();
    });
  });
});
