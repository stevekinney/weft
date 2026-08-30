import { describe, expect, it } from 'bun:test';

import { WorkerExecutionOwnership } from './worker-execution-ownership.ts';

describe('WorkerExecutionOwnership', () => {
  it('tracks cancellation state and active or parked lookups', () => {
    const ownership = new WorkerExecutionOwnership();
    const worker = {} as Worker;

    ownership.markCancelled('wf-cancelled');
    expect(ownership.consumeCancelled('wf-cancelled')).toBe(true);
    expect(ownership.consumeCancelled('wf-cancelled')).toBe(false);

    ownership.setActive('wf-active', worker);
    expect(ownership.getActiveWorker('wf-active')).toBe(worker);
    expect(ownership.getTargetWorker('wf-active')).toBe(worker);
    expect(ownership.activeWorkflowIds()).toEqual(['wf-active']);
    expect(ownership.isWorkflowClosed('wf-active')).toBe(false);

    expect(ownership.releaseActive('wf-active')).toBe(worker);
    expect(ownership.isWorkflowClosed('wf-active')).toBe(true);
    expect(ownership.releaseActive('wf-active')).toBeUndefined();
  });

  it('reports worker ids and idleness across active and parked workflows', () => {
    const ownership = new WorkerExecutionOwnership();
    const activeWorker = {} as Worker;
    const parkedWorker = {} as Worker;

    ownership.setActive('wf-active', activeWorker);
    ownership.setActive('wf-parked', parkedWorker);
    expect(ownership.workflowIdsForWorker(activeWorker)).toEqual(['wf-active']);
    expect(ownership.workerIsIdle(activeWorker)).toBe(false);

    expect(ownership.parkActive('wf-parked', parkedWorker)).toBe(true);
    expect(ownership.getParkedWorker('wf-parked')).toBe(parkedWorker);
    expect(ownership.getTargetWorker('wf-parked')).toBe(parkedWorker);
    expect(ownership.workflowIdsForWorker(parkedWorker)).toEqual(['wf-parked']);
    expect(ownership.workerIsIdle(parkedWorker)).toBe(false);

    expect(ownership.activateParked('wf-parked', parkedWorker)).toBe(true);
    ownership.deleteParked('wf-parked');
    ownership.forgetWorkflow('wf-active');
    ownership.forgetWorkflow('wf-parked');
    expect(ownership.workflowIdsForWorker(activeWorker)).toEqual([]);
    expect(ownership.workerIsIdle(activeWorker)).toBe(true);
    expect(ownership.workerIsIdle(parkedWorker)).toBe(true);

    ownership.clear();
  });
});
