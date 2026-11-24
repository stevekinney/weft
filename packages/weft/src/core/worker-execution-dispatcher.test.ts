import { describe, expect, it, mock } from 'bun:test';

import { WorkerExecutionDispatcher } from './worker-execution-dispatcher.ts';
import { WorkerExecutionOwnership } from './worker-execution-ownership.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';

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
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

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
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

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

  const resumeParameters = {
    workflowId: 'wf-parked',
    checkpoint: new ArrayBuffer(0),
    operationResult: { status: 'completed', value: 'done' },
  } as const;
  const resumeMessage = { type: 'resume', ...resumeParameters } as const;

  it('sends nothing when the worker never becomes ready for the run', async () => {
    const { dependencies, worker } = createDependencies();
    dependencies.ensureRealmReady = mock(async () => false);
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.acquireAndSend('wf-run', {
      type: 'run',
      workflowId: 'wf-run',
      workflowType: 'demo',
      input: null,
      checkpoint: new ArrayBuffer(0),
    });

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(dependencies.beginTurn).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });

  it('does not send a run to a worker another workflow owns once the ready wait ends', async () => {
    const { dependencies, worker, ownership } = createDependencies();
    // The ready wait spans the worker's boot; a cancel in that window releases the worker.
    dependencies.ensureRealmReady = mock(async () => {
      ownership.releaseActive('wf-cancelled-while-booting');
      return true;
    });
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.acquireAndSend('wf-cancelled-while-booting', {
      type: 'run',
      workflowId: 'wf-cancelled-while-booting',
      workflowType: 'demo',
      input: null,
      checkpoint: new ArrayBuffer(0),
    });

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(dependencies.beginTurn).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });

  it('does not send a run once the engine is disposed during the ready wait', async () => {
    const { dependencies, worker } = createDependencies();
    let disposed = false;
    dependencies.isDisposed = () => disposed;
    dependencies.ensureRealmReady = mock(async () => {
      disposed = true;
      return true;
    });
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.acquireAndSend('wf-disposed-while-booting', {
      type: 'run',
      workflowId: 'wf-disposed-while-booting',
      workflowType: 'demo',
      input: null,
      checkpoint: new ArrayBuffer(0),
    });

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });

  it('fails the run when its checkpoint is a view over memory that cannot be transferred', async () => {
    const { dependencies, worker } = createDependencies();
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.acquireAndSend('wf-shared', {
      type: 'run',
      workflowId: 'wf-shared',
      workflowType: 'demo',
      input: null,
      checkpoint: new Uint8Array(new SharedArrayBuffer(4)) as never,
    });

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(dependencies.emit).toHaveBeenCalledWith({
      type: 'failed',
      workflowId: 'wf-shared',
      error: 'Worker checkpoint must use an ArrayBuffer-backed view',
      failureCategory: 'system',
    });
  });

  it('hands the parked worker back to the pool without resuming when the engine is disposed', async () => {
    const { dependencies, worker, ownership } = createDependencies();
    dependencies.isDisposed = () => true;
    ownership.setActive('wf-parked', worker);
    ownership.parkActive('wf-parked', worker);
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.resumeParkedWorkflow(resumeParameters, worker, resumeMessage);

    expect(dependencies.pool.release).toHaveBeenCalledWith(worker);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });

  it('hands the worker back without resuming when the workflow is no longer parked on it', async () => {
    const { dependencies, worker } = createDependencies();
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.resumeParkedWorkflow(resumeParameters, worker, resumeMessage);

    expect(dependencies.pool.release).toHaveBeenCalledWith(worker);
    expect(dependencies.attachWorkerListeners).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('forgets the parked marker and fails the workflow when the parked worker cannot be reacquired', async () => {
    const { dependencies, worker, ownership } = createDependencies();
    dependencies.pool.acquireSpecificWorker = mock(async () => {
      throw new Error('worker was discarded');
    });
    ownership.setActive('wf-parked', worker);
    ownership.parkActive('wf-parked', worker);
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.resumeParkedWorkflow(resumeParameters, worker, resumeMessage);

    expect(ownership.getParkedWorker('wf-parked')).toBeUndefined();
    expect(dependencies.emit).toHaveBeenCalledWith({
      type: 'failed',
      workflowId: 'wf-parked',
      error: 'worker was discarded',
    });
  });

  it('stays silent when reacquiring the parked worker fails after the workflow moved on', async () => {
    const { dependencies, worker, ownership } = createDependencies();
    dependencies.pool.acquireSpecificWorker = mock(async () => {
      throw new Error('worker was discarded');
    });
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    // No parked marker at all: the workflow was cancelled or resumed elsewhere meanwhile.
    await dispatcher.resumeParkedWorkflow(resumeParameters, worker, resumeMessage);

    expect(ownership.getParkedWorker('wf-parked')).toBeUndefined();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });

  it('posts a cancel to a parked worker, stamping the protocol version only when required', async () => {
    for (const requireVersion of [false, true]) {
      const { dependencies, worker } = createDependencies();
      worker.postMessage = mock(() => {});
      dependencies.requireProtocolVersion = () => requireVersion;
      const dispatcher = new WorkerExecutionDispatcher(dependencies);

      await dispatcher.cancelParkedWorkflow('wf-parked', worker);

      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'cancel',
        workflowId: 'wf-parked',
        ...(requireVersion ? { protocolVersion: WORKER_PROTOCOL_VERSION } : {}),
      });
      expect(dependencies.detachWorkerListenersIfIdle).toHaveBeenCalledWith(worker);
      expect(dependencies.pool.release).toHaveBeenCalledWith(worker);
    }
  });

  it('swallows the failure when the parked worker cannot be reacquired for a cancel', async () => {
    const { dependencies, worker } = createDependencies();
    dependencies.pool.acquireSpecificWorker = mock(async () => {
      throw new Error('worker was discarded');
    });
    const dispatcher = new WorkerExecutionDispatcher(dependencies);

    await dispatcher.cancelParkedWorkflow('wf-parked', worker);

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(dependencies.pool.release).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });
});
