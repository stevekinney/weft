import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { decode } from '../codec.ts';
import { WorkflowCompletedEvent, WorkflowStartedEvent } from '../events.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';

async function waitForCheckpointStep(
  engine: TestEngine,
  workflowId: string,
  step: number,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const checkpoints = await engine.listCheckpoints(workflowId);
    if (checkpoints.some((checkpoint) => checkpoint.step === step)) {
      return;
    }
    await sleepForTesting(10);
  }

  throw new Error(`Checkpoint step ${step} was not recorded for workflow "${workflowId}"`);
}

describe('workflow forking', () => {
  it('forks a running workflow and lets the two workflows diverge independently', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'choose-branch' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const durableContext = ctx;
        const branch = yield* durableContext.waitForSignal('branch');
        const typedInput = input as { label: string };
        return `${typedInput.label}:${String(branch)}`;
      }),
    );

    const original = await engine.start('choose-branch', { label: 'base' }, { id: 'wf-original' });
    const forked = await engine.fork(original.id);

    await engine.signal(original.id, 'branch', 'left');
    await engine.signal(forked.id, 'branch', 'right');

    await expect(original.result()).resolves.toBe('base:left');
    await expect(forked.result()).resolves.toBe('base:right');

    const forkedState = await engine.get(forked.id);
    expect(forkedState).not.toBeNull();
    expect(forkedState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
      },
    });
    expect(typeof forkedState?.forkedFrom?.step).toBe('number');

    const descendants = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(descendants.items.map((item) => item.id)).toContain(forked.id);

    engine[Symbol.dispose]();
  });

  it('forks from a historical checkpoint without rerunning already completed work', async () => {
    const engine = new TestEngine();
    const executedStages: string[] = [];

    const recordStage = activity({
      name: 'recordStage',
      execute: async (stage: unknown) => {
        const typedStage = String(stage);
        executedStages.push(typedStage);
        return typedStage;
      },
    });

    engine.register(
      workflow({ name: 'historical-fork' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        const first = yield* durableContext.run(recordStage, 'first');
        const second = yield* durableContext.run(recordStage, 'second');
        yield* durableContext.waitForSignal('hold');
        yield* durableContext.waitForSignal('continue');
        return `${String(first)}:${String(second)}`;
      }),
    );

    const original = await engine.start('historical-fork', null, { id: 'wf-historical' });
    await engine.signal(original.id, 'hold');
    await waitForCheckpointStep(engine, original.id, 4);

    const forked = await engine.fork(original.id, { fromStep: 3 });
    await engine.signal(forked.id, 'hold');
    await engine.signal(forked.id, 'continue');

    await expect(forked.result()).resolves.toBe('first:second');
    expect(executedStages).toEqual(['first', 'second']);

    const forkedState = await engine.get(forked.id);
    expect(forkedState).not.toBeNull();
    expect(forkedState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
        step: 3,
      },
    });

    await engine.signal(original.id, 'continue');
    await expect(original.result()).resolves.toBe('first:second');

    engine[Symbol.dispose]();
  });

  it('refreshes fork checkpoint timestamps so resumed sleeps use the fork time', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register(
      workflow({ name: 'fork-sleep-reference' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        yield* durableContext.waitForSignal('continue');
        yield* durableContext.sleep('1 hour');
        return 'done';
      }),
    );

    const original = await engine.start('fork-sleep-reference', null, { id: 'wf-sleep-root' });
    const originalResult = original.result();
    const sourceCheckpointBytes = await engine.storage.get(KEYS.checkpoint(original.id));
    expect(sourceCheckpointBytes).not.toBeNull();
    const sourceCheckpoint = deserializeCheckpoint(sourceCheckpointBytes!);

    await engine.advanceTime('2 hours');

    const forked = await engine.fork(original.id);
    const forkCheckpointBytes = await engine.storage.get(KEYS.checkpoint(forked.id));
    expect(forkCheckpointBytes).not.toBeNull();
    const forkCheckpoint = deserializeCheckpoint(forkCheckpointBytes!);

    expect(forkCheckpoint.createdAt).toBe(engine.now);
    expect(forkCheckpoint.createdAt).toBeGreaterThan(sourceCheckpoint.createdAt);

    await engine.signal(forked.id, 'continue');
    await sleepForTesting(0);

    const forkedStateBeforeFinalAdvance = await engine.get(forked.id);
    expect(forkedStateBeforeFinalAdvance?.status).toBe('running');

    await engine.advanceTime('59 minutes');
    const forkedStateBeforeTimerFires = await engine.get(forked.id);
    expect(forkedStateBeforeTimerFires?.status).toBe('running');

    await engine.advanceTime('1 minute');
    await expect(forked.result()).resolves.toBe('done');

    await engine.cancel(original.id);
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('forks a completed workflow from its latest checkpoint and reruns only the terminal step', async () => {
    const engine = new TestEngine();
    const executedStages: string[] = [];
    const terminalSummaries: string[] = [];

    const recordStage = activity({
      name: 'recordTerminalStage',
      execute: async (stage: unknown) => {
        const typedStage = String(stage);
        executedStages.push(typedStage);
        return `${typedStage}-done`;
      },
    });

    engine.register(
      workflow({ name: 'completed-fork' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const durableContext = ctx;
        const stage = yield* durableContext.run(recordStage, 'prepare');
        const typedInput = String(input);
        return yield* durableContext.memo('terminal-summary', () => {
          terminalSummaries.push(typedInput);
          return `${typedInput}:${String(stage)}`;
        });
      }),
    );

    const original = await engine.start('completed-fork', 'original', { id: 'wf-completed' });
    await expect(original.result()).resolves.toBe('original:prepare-done');
    expect(executedStages).toEqual(['prepare']);
    expect(terminalSummaries).toEqual(['original']);

    const forked = await engine.fork(original.id);
    await expect(forked.result()).resolves.toBe('original:prepare-done');
    expect(executedStages).toEqual(['prepare']);
    expect(terminalSummaries).toEqual(['original', 'original']);

    engine[Symbol.dispose]();
  });

  it('dispatches workflow started before workflow completed for completed workflow forks', async () => {
    const engine = new TestEngine();
    const observedEvents: Array<{ type: string; workflowId: string }> = [];

    engine.addEventListener(WorkflowStartedEvent.type, (event) => {
      observedEvents.push({
        type: event.type,
        workflowId: (event as WorkflowStartedEvent).workflowId,
      });
    });
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      observedEvents.push({
        type: event.type,
        workflowId: (event as WorkflowCompletedEvent).workflowId,
      });
    });

    engine.register(
      workflow({ name: 'completed-ordering' }).execute(async function* () {
        return 'done';
      }),
    );

    const original = await engine.start('completed-ordering', null, { id: 'wf-order-root' });
    await expect(original.result()).resolves.toBe('done');

    const forked = await engine.fork(original.id);
    await expect(forked.result()).resolves.toBe('done');

    const forkedEvents = observedEvents
      .filter((event) => event.workflowId === forked.id)
      .map((event) => event.type);
    expect(forkedEvents).toEqual(['workflow:started', 'workflow:completed']);

    engine[Symbol.dispose]();
  });

  it('records lineage chains across multiple forks', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'lineage-fork' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return String(input);
      }),
    );

    const original = await engine.start('lineage-fork', 'root', { id: 'wf-root' });
    await original.result();

    const firstFork = await engine.fork(original.id);
    await firstFork.result();

    const secondFork = await engine.fork(firstFork.id);
    await secondFork.result();

    const firstForkState = await engine.get(firstFork.id);
    const secondForkState = await engine.get(secondFork.id);

    expect(firstForkState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
      },
    });
    expect(secondForkState).toMatchObject({
      forkedFrom: {
        workflowId: firstFork.id,
      },
    });

    const firstGeneration = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(firstGeneration.items.map((item) => item.id)).toContain(firstFork.id);

    const secondGeneration = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: firstFork.id }],
    });
    expect(secondGeneration.items.map((item) => item.id)).toContain(secondFork.id);

    engine[Symbol.dispose]();
  });

  it('keeps fork lineage queryable after cancellation', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'cancelled-fork' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    const original = await engine.start('cancelled-fork', null, { id: 'wf-cancel-root' });
    const forked = await engine.fork(original.id);
    const forkedResult = forked.result();
    const originalResult = original.result();

    await engine.cancel(forked.id);

    const descendants = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(descendants.items.map((item) => item.id)).toContain(forked.id);

    await engine.cancel(original.id);
    await expect(forkedResult).rejects.toThrow('Workflow cancelled');
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('preserves persisted workflow start headers on forked workflows', async () => {
    const engine = new TestEngine();
    const capturedParentHeaders: Map<string, string>[] = [];

    engine.addInterceptor({
      workflowStart(interception, next) {
        interception.headers.set(
          'traceparent',
          '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
        );
        interception.headers.set('tracestate', 'vendor=value');
        interception.headers.set('x-auth', 'secret-token');
        next(interception);
      },
      async childWorkflow(interception, next) {
        capturedParentHeaders.push(new Map(interception.parentHeaders));
        return next(interception);
      },
    });

    engine.register(
      workflow({ name: 'child' }).execute(async function* () {
        return 'child-complete';
      }),
    );

    engine.register(
      workflow({ name: 'parent-with-headers' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        yield* durableContext.waitForSignal('continue');
        return yield* durableContext.startChild<string>('child', null);
      }),
    );

    const original = await engine.start('parent-with-headers', null, { id: 'wf-header-root' });
    const forked = await engine.fork(original.id);
    const originalResult = original.result();

    const headerBytes = await engine.storage.get(KEYS.workflowHeaders(forked.id));
    expect(headerBytes).not.toBeNull();
    const persistedHeaders = new Map(decode(headerBytes!) as Array<[string, string]>);
    expect(persistedHeaders.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
    expect(persistedHeaders.get('tracestate')).toBe('vendor=value');
    expect(persistedHeaders.has('x-auth')).toBe(false);

    await engine.signal(forked.id, 'continue');
    await expect(forked.result()).resolves.toBe('child-complete');
    expect(capturedParentHeaders).toHaveLength(1);
    expect(capturedParentHeaders[0]?.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
    expect(capturedParentHeaders[0]?.get('tracestate')).toBe('vendor=value');
    expect(capturedParentHeaders[0]?.has('x-auth')).toBe(false);

    await engine.cancel(original.id);
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('preserves workflow function resolution for composition operators after a fork', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'fork-child-function' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return Number(input) * 2;
      }),
    );
    engine.register(
      workflow({ name: 'fork-parent-composition' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        yield* durableContext.waitForSignal('continue');
        return yield* durableContext.map([1, 2], 'fork-child-function');
      }),
    );

    const original = await engine.start('fork-parent-composition', null, {
      id: 'wf-fork-composition-root',
    });
    const forked = await engine.fork(original.id);
    const originalResult = original.result();

    await engine.signal(forked.id, 'continue');
    await expect(forked.result()).resolves.toEqual([2, 4]);

    await engine.cancel(original.id);
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });
});
