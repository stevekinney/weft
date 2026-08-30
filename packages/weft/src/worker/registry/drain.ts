// ---------------------------------------------------------------------------
// Worker and deployment drain-state helpers
// ---------------------------------------------------------------------------

import type { WorkerDrainOptions, WorkerHealth, WorkerInfo } from './types.ts';

/** A drain marker: when it started and an optional operator-supplied reason. */
export type DrainRecord = {
  reason?: string;
  startedAt: number;
};

export function createDrainRecord(options?: WorkerDrainOptions): DrainRecord {
  return {
    startedAt: options?.updatedAt ?? Date.now(),
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
  };
}

/**
 * The drain record covering `worker`: its own explicit marker if set,
 * otherwise its deployment's marker (when the worker declares a deployment).
 */
export function drainRecordForWorker(
  worker: WorkerInfo,
  deploymentDrainStates: ReadonlyMap<string, DrainRecord>,
): DrainRecord | undefined {
  if (worker.drainStartedAt !== undefined) {
    return {
      startedAt: worker.drainStartedAt,
      ...(worker.drainReason !== undefined ? { reason: worker.drainReason } : {}),
    };
  }
  if (worker.deploymentName === undefined) return undefined;
  return deploymentDrainStates.get(worker.deploymentName);
}

export function isWorkerDraining(
  worker: WorkerInfo,
  deploymentDrainStates: ReadonlyMap<string, DrainRecord>,
): boolean {
  return drainRecordForWorker(worker, deploymentDrainStates) !== undefined;
}

export function workerHealth(
  worker: WorkerInfo,
  deploymentDrainStates: ReadonlyMap<string, DrainRecord>,
): WorkerHealth {
  if (!isWorkerDraining(worker, deploymentDrainStates)) return 'active';
  return worker.inFlight > 0 ? 'draining' : 'drained';
}
