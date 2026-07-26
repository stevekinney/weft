import { afterEach, describe, expect, it } from 'bun:test';
import { waitForCondition, withTimeout } from '../testing/fake-timers.test-support.ts';

import { encodeStorageKeyComponent, KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { deserializeCheckpoint } from './checkpoint/serialization.ts';
import {
  Engine,
  ENGINE_SET_WORKER_TURN_TIMEOUT_RESOLVER_FOR_TESTING,
  ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING,
  type WorkflowHandle,
} from './engine.ts';
import { hydrateCheckpointReplayState } from './engine/checkpoint-replay.ts';
import { WorkflowCompletedEvent } from './events.ts';
import type { WorkflowContext } from './types.ts';
import { activity } from './types/activity.ts';
import { workflow } from './types/workflow-function.ts';

const workerUrl = new URL('../workers/test-browser-worker.ts', import.meta.url);
const LOAD_TOLERANT_WORKER_TIMEOUT_ASSERTION_MS = 5_000;

const waitSignalThenCompleteWorkflow = workflow({ name: 'wait-signal-then-complete' }).execute(
  async function* (_ctx: WorkflowContext) {
    return undefined;
  },
);
const simpleWorkflow = workflow({ name: 'simple' }).execute(async function* (
  _ctx: WorkflowContext,
) {
  return undefined;
});
const infiniteLoopWorkflow = workflow({ name: 'infinite-loop' }).execute(async function* (
  _ctx: WorkflowContext,
) {
  return undefined;
});
const infiniteLoopAfterResumeWorkflow = workflow({ name: 'infinite-loop-after-resume' }).execute(
  async function* (_ctx: WorkflowContext) {
    return undefined;
  },
);
const catchFailedActivityThenWaitWorkflow = workflow({
  name: 'catch-failed-activity-then-wait',
}).execute(async function* (_ctx: WorkflowContext) {
  return undefined;
});

function registerWorkerExecutionTestWorkflows(engine: Engine): void {
  engine.register(waitSignalThenCompleteWorkflow);
  engine.register(simpleWorkflow);
  engine.register(infiniteLoopWorkflow);
  engine.register(infiniteLoopAfterResumeWorkflow);
  engine.register(catchFailedActivityThenWaitWorkflow);
}

async function countStoredSignals(
  storage: MemoryStorage,
  workflowId: string,
  signalName: string,
): Promise<number> {
  const prefix = `sig:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(signalName)}:`;
  let count = 0;
  for await (const _entry of storage.scan(prefix)) {
    count++;
  }
  return count;
}

describe('worker execution signal suspension', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  function createWorkerEngine(storage = new MemoryStorage()): Engine {
    // These suspension/recovery tests are not about turn-timeout enforcement, so
    // use a generous per-turn budget that no individual run/resume turn here
    // approaches. (Turn-timeout behavior is covered by createHardenedWorkerEngine.)
    const workerEngine = new Engine({
      storage,
      workflowExecutionMode: 'worker',
      workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
    });
    registerWorkerExecutionTestWorkflows(workerEngine);
    engine = workerEngine;
    return workerEngine;
  }

  it('rejects the Worker timeout test seam in inline execution mode', () => {
    const inlineEngine = new Engine({ storage: new MemoryStorage() });
    engine = inlineEngine;

    expect(() =>
      inlineEngine[ENGINE_SET_WORKER_TURN_TIMEOUT_RESOLVER_FOR_TESTING](() => 100),
    ).toThrow('Worker turn timeout resolver is only available in Worker execution mode');
  });

  async function waitForSignalWaiter(workerEngine: Engine): Promise<void> {
    await waitForCondition(() => workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 1, {
      label: 'worker-mode signal waiter',
    });
  }

  it('releases a worker while parked, runs another workflow, then resumes exactly once', async () => {
    const workerEngine = createWorkerEngine();
    const completedWorkflowIds: string[] = [];
    workerEngine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      completedWorkflowIds.push(event.workflowId);
    });

    const parkedHandle = await workerEngine.start(
      'wait-signal-then-complete',
      { signalName: 'resume', label: 'first' },
      { id: 'worker-parked' },
    );
    const parkedResult = parkedHandle.result();

    await waitForSignalWaiter(workerEngine);

    const secondHandle = await workerEngine.start(
      'simple',
      { label: 'second' },
      { id: 'worker-second' },
    );
    await expect(withTimeout(secondHandle.result(), 1000, 'second workflow')).resolves.toEqual({
      input: { label: 'second' },
      computed: 42,
    });
    expect(completedWorkflowIds).toContain('worker-second');
    expect(completedWorkflowIds).not.toContain('worker-parked');

    await workerEngine.signal('worker-parked', 'resume', { status: 'ready' });

    await expect(withTimeout(parkedResult, 1000, 'parked workflow')).resolves.toEqual({
      input: { signalName: 'resume', label: 'first' },
      payload: { status: 'ready' },
      workflowId: 'worker-parked',
    });
    expect(
      completedWorkflowIds.filter((workflowId) => workflowId === 'worker-parked'),
    ).toHaveLength(1);
  });

  it('cleans signal waiters when a parked worker-mode workflow is cancelled', async () => {
    const storage = new MemoryStorage();
    const workerEngine = createWorkerEngine(storage);

    const handle: WorkflowHandle = await workerEngine.start(
      'wait-signal-then-complete',
      { signalName: 'resume' },
      { id: 'worker-cancelled' },
    );
    const result = handle.result();

    await waitForSignalWaiter(workerEngine);
    await handle.cancel();

    await waitForCondition(() => workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 0, {
      label: 'cancelled worker-mode signal waiter cleanup',
    });
    await expect(result).rejects.toThrow('Workflow cancelled');

    await workerEngine.signal('worker-cancelled', 'resume', { status: 'late' });
    expect(await countStoredSignals(storage, 'worker-cancelled', 'resume')).toBe(0);
  });

  it('cleans signal waiters when a parked worker-mode engine is disposed', async () => {
    const workerEngine = createWorkerEngine();

    await workerEngine.start(
      'wait-signal-then-complete',
      { signalName: 'resume' },
      { id: 'worker-disposed' },
    );
    await waitForSignalWaiter(workerEngine);

    workerEngine[Symbol.dispose]();

    expect(workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(0);
  });

  it('times out a real infinite-loop Worker workflow and runs a later workflow', async () => {
    const workerEngine = createWorkerEngine();
    workerEngine[ENGINE_SET_WORKER_TURN_TIMEOUT_RESOLVER_FOR_TESTING](({ workflowId }) =>
      workflowId === 'worker-infinite-loop' ? 100 : 30_000,
    );

    const loopingHandle = await workerEngine.start('infinite-loop', null, {
      id: 'worker-infinite-loop',
    });

    await expect(
      withTimeout(
        loopingHandle.result(),
        LOAD_TOLERANT_WORKER_TIMEOUT_ASSERTION_MS,
        'infinite-loop timeout',
      ),
    ).rejects.toThrow('Worker workflow turn timed out');

    const simpleHandle = await workerEngine.start(
      'simple',
      { label: 'after-loop' },
      { id: 'worker-after-loop' },
    );
    await expect(simpleHandle.result()).resolves.toEqual({
      input: { label: 'after-loop' },
      computed: 42,
    });
  });

  it('times out a real Worker workflow that loops after resume', async () => {
    const workerEngine = createWorkerEngine();
    workerEngine[ENGINE_SET_WORKER_TURN_TIMEOUT_RESOLVER_FOR_TESTING](({ workflowId, kind }) =>
      workflowId === 'worker-infinite-loop-after-resume' && kind === 'resume' ? 100 : 30_000,
    );

    const loopingHandle = await workerEngine.start(
      'infinite-loop-after-resume',
      { signalName: 'resume' },
      {
        id: 'worker-infinite-loop-after-resume',
      },
    );
    const loopingOutcome = loopingHandle.result().then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await workerEngine.signal('worker-infinite-loop-after-resume', 'resume', { status: 'go' });

    const outcome = await withTimeout(
      loopingOutcome,
      LOAD_TOLERANT_WORKER_TIMEOUT_ASSERTION_MS,
      'infinite-loop-after-resume timeout',
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'fulfilled') {
      throw new Error('Expected the resumed Worker turn to time out, but it fulfilled');
    }
    expect(outcome.error).toBeInstanceOf(Error);
    if (!(outcome.error instanceof Error)) {
      throw new Error('Expected the resumed Worker timeout to reject with an Error');
    }
    expect(outcome.error.message).toBe('Worker workflow turn timed out after 100ms');
  });

  it('recovers a parked Worker workflow without re-running a cached failed activity', async () => {
    const storage = new MemoryStorage();
    let activityCalls = 0;
    const failingActivity = activity({
      name: 'failsBeforeSignal',
      execute: async () => {
        activityCalls++;
        throw new Error('planned activity failure');
      },
    });

    const firstEngine = createWorkerEngine(storage);
    firstEngine.register(failingActivity);
    const firstHandle = await firstEngine.start(
      'catch-failed-activity-then-wait',
      { signalName: 'continue' },
      { id: 'worker-failed-activity-replay' },
    );
    firstHandle.result().catch(() => {});

    await waitForCondition(
      async () => {
        const checkpointBytes = await storage.get(KEYS.checkpoint('worker-failed-activity-replay'));
        if (checkpointBytes === null) return false;
        const checkpoint = await hydrateCheckpointReplayState(
          storage,
          'worker-failed-activity-replay',
          deserializeCheckpoint(checkpointBytes),
        );
        return checkpoint.workerReplayFailures?.length === 1;
      },
      {
        label: 'worker failed activity checkpoint side table',
      },
    );
    await waitForSignalWaiter(firstEngine);
    expect(activityCalls).toBe(1);

    firstEngine[Symbol.dispose]();
    engine = undefined;

    const recoveredEngine = createWorkerEngine(storage);
    recoveredEngine.register(failingActivity);
    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles).toHaveLength(1);

    await recoveredEngine.signal('worker-failed-activity-replay', 'continue', { status: 'ready' });

    await expect(
      withTimeout(recoveredHandles[0]!.result(), 1000, 'recovered worker failed activity replay'),
    ).resolves.toEqual({
      caughtError: 'planned activity failure',
      payload: { status: 'ready' },
      workflowId: 'worker-failed-activity-replay',
    });
    expect(activityCalls).toBe(1);
  });
});

// Regression guard for the untrusted-workflow isolation boundary: under the
// worker execution strategy, no workflow generator may step in the engine
// isolate. The engine still *registers* a handler for each workflow type, but
// it must never *invoke* that registered handler — the Worker runs its own
// copy. We prove this with engine-only sentinels that the engine-side handlers
// would flip if they ever ran. The Worker's copy of `simple`
// (`test-browser-worker.ts`) returns `{ input, computed: 42 }`, while the
// engine-side copies below return a marker value and flip a sentinel; observing
// the Worker's result with the sentinels untouched proves the boundary held.
//
// The sentinels live only in this engine-side closure and are asserted in the
// engine isolate. We deliberately do not rely on a sentinel surviving the
// `Function.prototype.toString` worker-bundle boundary (a closure sentinel would
// not survive it; a module-level sentinel could be duplicated per isolate), which
// is exactly the leak this test must not depend on.
describe('worker execution isolation boundary', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('never invokes the engine-isolate workflow handler across start, resume, and cancel', async () => {
    let engineSimpleHandlerRan = false;
    let engineWaitHandlerRan = false;

    // Engine-side registrations whose bodies flip a sentinel if they are ever
    // stepped in the engine isolate. Under the worker strategy these must never
    // run; the Worker executes its own copies of the same workflow types.
    const engineSimpleWorkflow = workflow({ name: 'simple' }).execute(async function* (
      _ctx: WorkflowContext,
    ) {
      engineSimpleHandlerRan = true;
      return { ranIn: 'engine-isolate' };
    });
    const engineWaitWorkflow = workflow({ name: 'wait-signal-then-complete' }).execute(
      async function* (_ctx: WorkflowContext) {
        engineWaitHandlerRan = true;
        return { ranIn: 'engine-isolate' };
      },
    );

    const workerEngine = new Engine({
      storage: new MemoryStorage(),
      workflowExecutionMode: 'worker',
      workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
    });
    workerEngine.register(engineSimpleWorkflow);
    workerEngine.register(engineWaitWorkflow);
    engine = workerEngine;

    // start -> resume: the Worker's `wait-signal-then-complete` parks on a
    // signal, then resumes when the engine delivers it. The engine drives the
    // run/resume lifecycle through the strategy without stepping its generator.
    const parkedHandle = await workerEngine.start(
      'wait-signal-then-complete',
      { signalName: 'resume', label: 'boundary' },
      { id: 'boundary-resume' },
    );
    const parkedResult = parkedHandle.result();
    await waitForCondition(() => workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 1, {
      label: 'boundary signal waiter',
    });
    await workerEngine.signal('boundary-resume', 'resume', { status: 'ready' });
    await expect(withTimeout(parkedResult, 1000, 'boundary resume workflow')).resolves.toEqual({
      input: { signalName: 'resume', label: 'boundary' },
      payload: { status: 'ready' },
      workflowId: 'boundary-resume',
    });

    // start -> complete: the Worker's `simple` returns `computed: 42`. If the
    // engine-side handler had run instead, the result would be the engine
    // marker and the sentinel would be set.
    const simpleHandle = await workerEngine.start(
      'simple',
      { label: 'boundary' },
      { id: 'boundary-simple' },
    );
    await expect(
      withTimeout(simpleHandle.result(), 1000, 'boundary simple workflow'),
    ).resolves.toEqual({ input: { label: 'boundary' }, computed: 42 });

    // start -> cancel: cancellation must reach the engine's terminal cancelled
    // state (not "completed"), again without stepping the workflow generator in
    // the engine isolate.
    const cancelHandle = await workerEngine.start(
      'wait-signal-then-complete',
      { signalName: 'resume', label: 'cancel' },
      { id: 'boundary-cancel' },
    );
    const cancelResult = cancelHandle.result();
    await waitForCondition(() => workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 1, {
      label: 'boundary cancel signal waiter',
    });
    await cancelHandle.cancel();
    // Wait for the signal waiter to be torn down before asserting rejection, so
    // a left-alive waiter cannot be silently cleaned up by the afterEach dispose
    // and mask a stuck workflow (mirrors the existing cancel test above).
    await waitForCondition(() => workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 0, {
      label: 'boundary cancel waiter cleanup',
    });
    await expect(cancelResult).rejects.toThrow('Workflow cancelled');

    // The invariant: across start, resume, and cancel, neither engine-side
    // handler ever stepped in the engine isolate.
    expect(engineSimpleHandlerRan).toBe(false);
    expect(engineWaitHandlerRan).toBe(false);
  });
});
