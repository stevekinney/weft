import { describe, expect, it, mock } from 'bun:test';

import { WorkerExecutionDispatcher } from './worker-execution-dispatcher.ts';
import { WorkerExecutionOwnership } from './worker-execution-ownership.ts';

function createDependencies() {
  const worker = {
    postMessage: mock(() => {
      throw new Error('postMessage failed');
    }),
  } as unknown as Worker;
  const ownership = new WorkerExecutionOwnership();

  const dependencies = {
    pool: {
      acquire: mock(async () => worker),
      acquireSpecificWorker: mock(async () => worker),
      release: mock(() => {}),
    } as any,
    ownership,
    isDisposed: () => false,
    requireProtocolVersion: () => false,
    validateHostToWorkerMessage: () => true,
    attachWorkerListeners: mock(() => {}),
    detachWorkerListenersIfIdle: mock(() => {}),
    ensureRealmReady: mock(async () => true),
    beginTurn: mock(() => {}),
    clearTurn: mock(() => {}),
    discardWorkerAndFailWorkflows: mock(() => {}),
    emit: mock(() => {}),
  };

  return { worker, ownership, dependencies };
}

describe('WorkerExecutionDispatcher', () => {
  it('fails a run workflow locally when postMessage throws', async () => {
    const { dependencies } = createDependencies();
    const dispatcher = new WorkerExecutionDispatcher(dependencies as any);

    await dispatcher.acquireAndSend('wf-run', {
      type: 'run',
      workflowId: 'wf-run',
      workflowType: 'demo',
      input: null,
      checkpoint: new ArrayBuffer(0),
    });

    expect(dependencies.clearTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.detachWorkerListenersIfIdle).toHaveBeenCalledTimes(1);
    expect(dependencies.pool.release).toHaveBeenCalledTimes(1);
    expect(dependencies.emit).toHaveBeenCalledWith({
      type: 'failed',
      workflowId: 'wf-run',
      error: 'postMessage failed',
      failureCategory: 'system',
    });
  });

  it('discards the worker when a resume postMessage throws', () => {
    const { dependencies, worker } = createDependencies();
    const dispatcher = new WorkerExecutionDispatcher(dependencies as any);

    dispatcher.postResumeMessage(
      worker,
      {
        workflowId: 'wf-resume',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'done' },
      },
      {
        type: 'resume',
        workflowId: 'wf-resume',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'done' },
      },
    );

    expect(dependencies.clearTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.discardWorkerAndFailWorkflows).toHaveBeenCalledWith(worker, {
      targetWorkflowId: 'wf-resume',
      targetCategory: 'system',
      targetError: 'postMessage failed',
      otherCategory: 'system',
      otherError: 'Worker was discarded after resume postMessage failed',
    });
  });
});
