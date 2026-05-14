import { afterEach, describe, expect, it } from 'bun:test';
import { waitForCondition, withTimeout } from '../testing/fake-timers.ts';

import { encodeStorageKeyComponent } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { Engine, ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING, type WorkflowHandle } from './engine.ts';
import { WorkflowCompletedEvent } from './events.ts';
import type { WorkflowContext } from './types.ts';

const workerUrl = new URL('../workers/test-browser-worker.ts', import.meta.url);

function registerWorkerExecutionTestWorkflows(engine: Engine): void {
  engine.register('wait-signal-then-complete', async function* (_ctx: WorkflowContext) {
    return undefined;
  });
  engine.register('simple', async function* (_ctx: WorkflowContext) {
    return undefined;
  });
}

async function countStoredSignals(
  storage: MemoryStorage,
  workflowId: string,
  signalName: string,
): Promise<number> {
  const prefix = `sig:${encodeStorageKeyComponent(workflowId)}:${signalName}:`;
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
    const workerEngine = new Engine({
      storage,
      workerExecution: { workerUrl, poolSize: 1 },
    });
    registerWorkerExecutionTestWorkflows(workerEngine);
    engine = workerEngine;
    return workerEngine;
  }

  async function waitForSignalWaiter(workerEngine: Engine): Promise<void> {
    await waitForCondition(() => workerEngine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 1, {
      label: 'worker-mode signal waiter',
    });
  }

  it('releases a worker while parked, runs another workflow, then resumes exactly once', async () => {
    const workerEngine = createWorkerEngine();
    const completedWorkflowIds: string[] = [];
    workerEngine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      completedWorkflowIds.push((event as WorkflowCompletedEvent).workflowId);
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
});
