import { sleepForTesting, waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { spawnWithHangGuard } from "../../test-support/embedded/testing/src/hang-guard.ts";
import { afterEach, describe, expect, it } from 'bun:test';

import { outcomeOf, rethrow } from "../../test-support/embedded/testing/src/module-scope-scenario.ts";
import { Context } from './context.ts';
import { InlineExecutionStrategy } from './inline-execution-strategy.ts';
import type { WorkerOutboundMessage, WorkflowFunction } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Let the strategy's queued continuations run before a test reads its messages. */
// load-proof: the strategy runs generator workflows in-process, so only microtasks are pending and no timer, socket or process is awaited
async function settleStrategy(): Promise<void> {
  await sleepForTesting(10);
}

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

// Each scenario below runs a script in a fresh `bun -e` process, which takes seconds on a loaded
// host, so it runs here at module scope, off Bun's five-second per-test clock; its test rethrows
// the scenario's outcome.

const scenario1 = await outcomeOf(async () => {
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

  const childProcess = spawnWithHangGuard(['bun', '-e', script], {
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
      await settleStrategy();

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

      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('checkpoint');
    });

    it('reports the step index the yielded operation occupies as pendingStepIndex', async () => {
      setup();

      registrations.set('stepped', {
        handler: async function* (context, _input) {
          // A session state write takes step 0 and yields nothing; the activity takes step 1.
          context.state.session<number>('counter').set(1);
          return yield* context.run('doWork', 'input');
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'stepped',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('checkpoint');
      if (message.type === 'checkpoint') {
        expect(message.pendingStepIndex).toBe(1);
      }
    });

    it('reports the step of a group, not the step after its primed branches', async () => {
      setup();

      registrations.set('grouped', {
        handler: async function* (context, _input) {
          // The group takes step 0 and its two primed branches take 1 and 2 before it yields.
          return yield* context.all([context.run('doWork', 'a'), context.run('doWork', 'b')]);
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'grouped',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('checkpoint');
      if (message.type === 'checkpoint') {
        expect(message.pendingStepIndex).toBe(0);
      }
    });

    it('emits failed for unknown workflow types', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'nonexistent',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await settleStrategy();

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

      await settleStrategy();

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

    it('suppresses an operation yielded after a shutdown abort', async () => {
      setup();

      const bodyEntered = Promise.withResolvers<void>();
      const releaseBody = Promise.withResolvers<void>();
      registrations.set('shutdown-yield', {
        handler: async function* () {
          bodyEntered.resolve();
          await releaseBody.promise;
          yield {
            type: 'activity',
            operationId: 'suppressed-operation',
            activityName: 'doWork',
            input: null,
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'shutdown-yield',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      const pendingAdvance = strategy.waitForWorkflowAdvance('wf-1');
      expect(pendingAdvance).toBeDefined();
      await bodyEntered.promise;

      strategy.abortWorkflowAdvanceForShutdown('wf-1');
      releaseBody.resolve();
      await pendingAdvance;

      expect(messages).toEqual([]);
      expect(strategy.hasGenerator('wf-1')).toBe(true);
      expect(strategy.waitForWorkflowTurn('wf-1')).toBeUndefined();
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

      await waitForCondition(() => resolveHandler !== undefined, {
        label: 'the message handler to be waiting',
      });

      const pendingTurn = strategy.waitForWorkflowTurn('wf-1');
      expect(pendingTurn).toBeDefined();
      expect(resolveHandler).toBeDefined();

      resolveHandler?.();
      await pendingTurn;

      expect(strategy.waitForWorkflowTurn('wf-1')).toBeUndefined();
    });

    it('does not surface unhandled rejections when an async message handler fails and nobody awaits the tracked turn', () =>
      rethrow(scenario1));
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

      await settleStrategy();
      messages.length = 0;

      strategy.continueWorkflow('wf-1', 42);

      await settleStrategy();

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

      await settleStrategy();
      messages.length = 0;

      strategy.throwIntoWorkflow('wf-1', new Error('activity failed'));

      await settleStrategy();

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

      await settleStrategy();
      messages.length = 0;

      strategy.throwIntoWorkflow('wf-1', new Error('oops'));

      await settleStrategy();

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

      await waitForCondition(() => strategy.getContext('wf-1') !== undefined, {
        label: 'the workflow to start',
      });

      expect(strategy.hasGenerator('wf-1')).toBe(true);
      expect(strategy.getContext('wf-1')).toBeDefined();
      expect(strategy.getAbortController('wf-1')).toBeDefined();

      strategy.cancelWorkflow('wf-1');

      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getContext('wf-1')).toBeUndefined();
      expect(strategy.getAbortController('wf-1')).toBeUndefined();
    });

    it('retireWorkflow evicts the generator, context, and abort controller like cancellation', async () => {
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
        workflowId: 'wf-retire',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await waitForCondition(() => strategy.hasGenerator('wf-retire'), {
        label: 'generator installed',
      });
      const abortController = strategy.getAbortController('wf-retire');

      strategy.retireWorkflow('wf-retire');

      expect(abortController?.signal.aborted).toBe(true);
      expect(strategy.hasGenerator('wf-retire')).toBe(false);
      expect(strategy.getContext('wf-retire')).toBeUndefined();
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
  // A relaunched run replays up to the operation it was parked on (COR-1811)
  // -------------------------------------------------------------------------

  describe('replay of a relaunched run', () => {
    function relaunchedContext(workflowId: string, logged: string[]): Context {
      const abortController = new AbortController();
      return new Context({
        workflowId,
        workflowType: 'relaunched',
        startedAt: Date.now(),
        abortController,
        getNow: Date.now,
        resumed: true,
        logSink: (record) =>
          logged.push(`${record.message}${record.replayed === true ? ' (replayed)' : ''}`),
      });
    }

    it('marks what it logs in front of the first operation it yields, and nothing that follows it', async () => {
      setup();
      const logged: string[] = [];
      const context = relaunchedContext('wf-relaunched', logged);
      const generator = (async function* (): AsyncGenerator<unknown, void, unknown> {
        context.log.info('in front of the park');
        yield { type: 'activity', operationId: 'op-1' };
        context.log.info('past the park');
      })();
      strategy.adoptWorkflow('wf-relaunched', generator, context, new AbortController());

      strategy.continueWorkflow('wf-relaunched', undefined);
      await waitForCondition(() => messages.length === 1, { label: 'the park was yielded' });
      expect(logged).toEqual(['in front of the park (replayed)']);

      strategy.continueWorkflow('wf-relaunched', undefined);
      await waitForCondition(() => messages.length === 2, { label: 'the run completed' });
      expect(logged).toEqual(['in front of the park (replayed)', 'past the park']);
    });

    it('is not ended by a superseded generation that settles after the context was replaced', async () => {
      setup();
      const logged: string[] = [];
      const staleContext = relaunchedContext('wf-reclaimed', logged);
      const { promise: staleMayYield, resolve: releaseStale } = Promise.withResolvers<void>();
      const staleGenerator = (async function* (): AsyncGenerator<unknown, void, unknown> {
        await staleMayYield;
        yield { type: 'activity', operationId: 'stale-op' };
      })();
      strategy.adoptWorkflow('wf-reclaimed', staleGenerator, staleContext, new AbortController());
      strategy.continueWorkflow('wf-reclaimed', undefined);

      // A reclaim installs a fresh generation while the old one's advance is still in flight.
      const freshContext = relaunchedContext('wf-reclaimed', logged);
      const freshGenerator = (async function* (): AsyncGenerator<unknown, void, unknown> {
        yield { type: 'activity', operationId: 'fresh-op' };
      })();
      strategy.adoptWorkflow('wf-reclaimed', freshGenerator, freshContext, new AbortController());

      // The old generation settles now, with the fresh context still replaying to its park.
      releaseStale();
      await settleStrategy();
      freshContext.log.info('in front of the fresh park');
      expect(logged).toEqual(['in front of the fresh park (replayed)']);
    });
  });

  // -------------------------------------------------------------------------
  // parkWorkflow: retained parked context for query handlers
  // -------------------------------------------------------------------------

  describe('parkWorkflow', () => {
    async function startParkableWorkflowAndCaptureContext(): Promise<Context> {
      setup();

      registrations.set('parkable', {
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
        workflowType: 'parkable',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await settleStrategy();

      const contextBeforePark = strategy.getContext('wf-1');
      expect(contextBeforePark).toBeDefined();
      return contextBeforePark!;
    }

    it('retains the context in parkedContexts after parking with retainContext', async () => {
      const contextBeforePark = await startParkableWorkflowAndCaptureContext();
      strategy.parkWorkflow('wf-1', { retainContext: true });

      // Live context is gone; parked context is retained
      expect(strategy.getContext('wf-1')).toBeUndefined();
      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getParkedContext('wf-1')).toBe(contextBeforePark);
    });

    it('keeps the retained context across a second retaining park (idempotent retain)', async () => {
      const contextBeforePark = await startParkableWorkflowAndCaptureContext();

      // First retaining park moves the context into #parkedContexts.
      strategy.parkWorkflow('wf-1', { retainContext: true });
      expect(strategy.getParkedContext('wf-1')).toBe(contextBeforePark);

      // A second retaining park with no live context must not drop the retained
      // entry — the retain path falls back to #parkedContexts.
      strategy.parkWorkflow('wf-1', { retainContext: true });
      expect(strategy.getParkedContext('wf-1')).toBe(contextBeforePark);
    });

    it('evicts the context by default (no retainContext) so suspend leaves nothing queryable', async () => {
      setup();

      registrations.set('parkable', {
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
        workflowType: 'parkable',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => strategy.getContext('wf-1') !== undefined, {
        label: 'the workflow to start',
      });
      expect(strategy.getContext('wf-1')).toBeDefined();

      // The default (suspend/terminate) form hard-evicts: no parked Context.
      strategy.parkWorkflow('wf-1');
      expect(strategy.getContext('wf-1')).toBeUndefined();
      expect(strategy.getParkedContext('wf-1')).toBeUndefined();
    });

    it('drops the retained context when a signal-parked workflow is later evicted (suspend)', async () => {
      setup();

      registrations.set('parkable', {
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
        workflowType: 'parkable',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => strategy.getContext('wf-1') !== undefined, {
        label: 'the workflow to start',
      });

      // Signal-park retains the context.
      strategy.parkWorkflow('wf-1', { retainContext: true });
      expect(strategy.getParkedContext('wf-1')).toBeDefined();

      // A later default park (e.g. suspend landing on a signal-parked run) must
      // tear the retained context down — query handlers must not survive suspend.
      strategy.parkWorkflow('wf-1');
      expect(strategy.getParkedContext('wf-1')).toBeUndefined();
    });

    it('clears the parked context when cancelWorkflow is called', async () => {
      setup();

      registrations.set('parkable-cancel', {
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
        workflowType: 'parkable-cancel',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => strategy.getContext('wf-1') !== undefined, {
        label: 'the workflow to start',
      });
      strategy.parkWorkflow('wf-1', { retainContext: true });
      expect(strategy.getParkedContext('wf-1')).toBeDefined();

      strategy.cancelWorkflow('wf-1');
      expect(strategy.getParkedContext('wf-1')).toBeUndefined();
    });

    it('clears the parked context when adoptWorkflow is called (resume path)', async () => {
      setup();

      registrations.set('parkable-resume', {
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
        workflowType: 'parkable-resume',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => strategy.getContext('wf-1') !== undefined, {
        label: 'the workflow to start',
      });
      strategy.parkWorkflow('wf-1', { retainContext: true });
      expect(strategy.getParkedContext('wf-1')).toBeDefined();

      const newAbortController = new AbortController();
      const newContext = new Context({
        workflowId: 'wf-1',
        workflowType: 'parkable-resume',
        startedAt: Date.now(),
        abortController: newAbortController,
        getNow: Date.now,
        nestingDepth: 0,
      });
      const newGenerator = (async function* (): AsyncGenerator {
        return 'done';
      })();

      strategy.adoptWorkflow('wf-1', newGenerator, newContext, newAbortController);

      // Parked context is gone; new live context is installed
      expect(strategy.getParkedContext('wf-1')).toBeUndefined();
      expect(strategy.getContext('wf-1')).toBe(newContext);
    });

    it('clears the parked context on dispose', async () => {
      setup();

      registrations.set('parkable-dispose', {
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
        workflowType: 'parkable-dispose',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => strategy.getContext('wf-1') !== undefined, {
        label: 'the workflow to start',
      });
      strategy.parkWorkflow('wf-1', { retainContext: true });
      expect(strategy.getParkedContext('wf-1')).toBeDefined();

      strategy[Symbol.dispose]();
      expect(strategy.getParkedContext('wf-1')).toBeUndefined();
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

      await settleStrategy();
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'hello' },
      });

      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('result:hello');
      }
    });

    it('emits failed when no generator is active for the workflow', async () => {
      setup();

      strategy.resumeWorkflow({
        workflowId: 'wf-never-started',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'ignored' },
      });

      await settleStrategy();

      expect(messages).toEqual([
        {
          type: 'failed',
          workflowId: 'wf-never-started',
          error: 'No active generator for workflow: wf-never-started',
        },
      ]);
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

      await settleStrategy();
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'failed', error: 'oops' },
      });

      await settleStrategy();

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

      await settleStrategy();
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

      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('wrapped timeout');
        expect(message.failureCategory).toBe('timeout');
      }
    });

    it('emits a checkpoint when a thrown operation is caught and the workflow resumes', async () => {
      setup();

      registrations.set('resilient-checkpoint', {
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
            yield {
              type: 'activity',
              operationId: 'op-2',
              activityName: 'recover',
              fn: () => {},
              input: undefined,
            };
          }
          return 'done';
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'resilient-checkpoint',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await settleStrategy();
      messages.length = 0;
      strategy.throwIntoWorkflow('wf-1', new Error('activity failed'));
      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('checkpoint');
      if (message.type === 'checkpoint') {
        expect(message.checkpoint.byteLength).toBe(0);
        expect(message.operationRequest).toMatchObject({ operationId: 'op-2' });
      }
    });

    it('preserves the original stack and caller-provided failure category for thrown errors', async () => {
      setup();

      const error = new Error('operation failed');
      registrations.set('unhandled-throw', {
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
        workflowType: 'unhandled-throw',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });
      await settleStrategy();
      messages.length = 0;
      strategy.throwIntoWorkflow('wf-1', error, 'timeout');
      await settleStrategy();

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('operation failed');
        expect(message.errorStack).toBe(error.stack);
        expect(message.failureCategory).toBe('timeout');
      }
    });

    it('does not advance an already-aborted workflow', async () => {
      setup();

      let advanced = false;
      const generator = (async function* (): AsyncGenerator {
        advanced = true;
        return 'done';
      })();
      const context = new Context({
        workflowId: 'wf-aborted',
        workflowType: 'aborted',
        startedAt: Date.now(),
        abortController: new AbortController(),
        getNow: Date.now,
        nestingDepth: 0,
      });
      const abortController = new AbortController();
      abortController.abort();
      strategy.adoptWorkflow('wf-aborted', generator, context, abortController);

      strategy.continueWorkflow('wf-aborted', undefined);
      await settleStrategy();

      expect(advanced).toBe(false);
      expect(messages).toHaveLength(0);
      expect(strategy.hasGenerator('wf-aborted')).toBe(true);
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

      await settleStrategy();

      strategy[Symbol.dispose]();

      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getContext('wf-1')).toBeUndefined();
    });

    it('supports explicit async disposal', async () => {
      setup();

      expect(await strategy[Symbol.asyncDispose]()).toBeUndefined();
      expect(() => strategy[Symbol.dispose]()).not.toThrow();
    });
  });
});
