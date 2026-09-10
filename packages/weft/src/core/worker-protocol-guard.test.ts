import { describe, expect, it } from 'bun:test';

import { WorkerProtocolGuard } from './worker-protocol-guard.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';
import { WorkerTurnWatchdog } from './worker-turn-watchdog.ts';

function fakeWorker(): Worker {
  return {} as Worker;
}

function buildGuard(): { guard: WorkerProtocolGuard; watchdog: WorkerTurnWatchdog } {
  const watchdog = new WorkerTurnWatchdog(undefined, () => {});
  const guard = new WorkerProtocolGuard(undefined, true, watchdog);
  return { guard, watchdog };
}

describe('WorkerProtocolGuard revision validation (WFT-20)', () => {
  it('accepts a completed message whose workflowRevision matches the active turn', () => {
    const { guard, watchdog } = buildGuard();
    const worker = fakeWorker();
    watchdog.begin(worker, 'wf-1', 1, 'run', undefined, 'revision-1');

    const result = guard.acceptWorkerMessage(worker, {
      type: 'completed',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      turnId: 1,
      workflowId: 'wf-1',
      result: null,
      workflowRevision: 'revision-1',
    });

    expect(result.accepted).toBe(true);
  });

  it('rejects a completed message whose workflowRevision disagrees with the active turn', () => {
    const { guard, watchdog } = buildGuard();
    const worker = fakeWorker();
    watchdog.begin(worker, 'wf-1', 1, 'run', undefined, 'revision-1');

    const result = guard.acceptWorkerMessage(worker, {
      type: 'completed',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      turnId: 1,
      workflowId: 'wf-1',
      result: null,
      workflowRevision: 'revision-wrong',
    });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.failure.error).toContain('revision');
    }
  });

  it('rejects a completed message with a MISSING workflowRevision when the active turn expects one', () => {
    const { guard, watchdog } = buildGuard();
    const worker = fakeWorker();
    watchdog.begin(worker, 'wf-1', 1, 'run', undefined, 'revision-1');

    const result = guard.acceptWorkerMessage(worker, {
      type: 'completed',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      turnId: 1,
      workflowId: 'wf-1',
      result: null,
    });

    expect(result.accepted).toBe(false);
  });

  it('never fails on the revision axis when the active turn carries no revision (back-compat)', () => {
    const { guard, watchdog } = buildGuard();
    const worker = fakeWorker();
    // No revision argument — pre-WFT-20 (or eager-type) turn.
    watchdog.begin(worker, 'wf-1', 1, 'run');

    const result = guard.acceptWorkerMessage(worker, {
      type: 'completed',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      turnId: 1,
      workflowId: 'wf-1',
      result: null,
    });

    expect(result.accepted).toBe(true);
  });

  it('validates revision on failed and checkpoint variants too', () => {
    const { guard, watchdog } = buildGuard();
    const worker = fakeWorker();
    watchdog.begin(worker, 'wf-1', 1, 'run', undefined, 'revision-1');

    const failedResult = guard.acceptWorkerMessage(worker, {
      type: 'failed',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      turnId: 1,
      workflowId: 'wf-1',
      error: 'boom',
      workflowRevision: 'revision-wrong',
    });
    expect(failedResult.accepted).toBe(false);

    watchdog.begin(worker, 'wf-1', 2, 'resume', undefined, 'revision-1');
    const checkpointResult = guard.acceptWorkerMessage(worker, {
      type: 'checkpoint',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      turnId: 2,
      workflowId: 'wf-1',
      checkpoint: new ArrayBuffer(0),
      operationRequest: { type: 'sleep', operationId: 'op-1', durationMs: 10 },
      workflowRevision: 'revision-1',
    });
    expect(checkpointResult.accepted).toBe(true);
  });
});
