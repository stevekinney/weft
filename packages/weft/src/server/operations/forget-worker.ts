/**
 * `weft.workers.forget` operation + REST binding.
 *
 * Stops listing one worker. A worker that went away stays in `weft.workers.list` with
 * `disconnectedAt` set until an operator forgets it or it registers again; forgetting drops it.
 * A connected worker that finished draining is hidden until it registers again or is resumed. A
 * connected worker still taking work is refused with a `Conflict`: forgetting it would not stop it,
 * and it would reappear at once. Nothing the worker held is touched: the tasks waiting for its
 * queue, and the ones that failed for good, stay where they are.
 *
 * @module server/operations/forget-worker
 */

import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { AccessPolicy, UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import type { WorkerRegistry } from '../../worker/registry.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import { WORKER_CONFLICT_REASONS } from './worker-conflict-reasons.ts';

const forgetWorkerInput = z.object({
  workerId: z.string().min(1).describe('Id of the listed worker to stop listing.'),
});

const forgetWorkerOutput = z.object({
  workerId: z.string(),
  forgotten: z.literal(true),
});

export type ForgetWorkerInput = z.infer<typeof forgetWorkerInput>;
export type ForgetWorkerOutput = z.infer<typeof forgetWorkerOutput>;

type ForgetWorkerOptions = {
  workerRegistry?: WorkerRegistry;
};

const adminAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['system:admin'] },
};

/**
 * Build the `weft.workers.forget` operation, optionally bound to a live `WorkerRegistry`. Without
 * one the operation is registered with full metadata for discovery and its `invoke` throws.
 */
export function createForgetWorkerOperation(options?: ForgetWorkerOptions) {
  const registry = options?.workerRegistry;
  return defineOperation({
    name: 'weft.workers.forget',
    mcpExposable: false,
    summary: 'Stop listing a worker that went away or finished draining',
    description:
      'Stop listing a worker by `workerId`. A worker that went away is dropped from the list; a ' +
      'connected worker that finished draining is hidden until it registers again or is resumed. ' +
      'The tasks waiting for its queue and the ones that failed for good are untouched. Faults ' +
      'with Conflict (`worker-still-connected`) for a worker that still takes work, and with ' +
      'NotFound when no listed worker has the given id.',
    destructive: false,
    tags: ['System'],
    inputSchema: forgetWorkerInput,
    outputSchema: forgetWorkerOutput,
    access: adminAccess,
    producibleFaults: ['Conflict', 'NotFound'],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<ForgetWorkerOutput> => {
      if (registry === undefined) {
        throw new Error(
          'weft.workers.forget invoked from a discovery-only operation registry; no WorkerRegistry was wired in',
        );
      }
      const outcome = registry.forgetWorker(input.workerId);
      if (outcome === undefined) throw workerNotFoundFault(input.workerId);
      if (outcome === 'connected') throw workerStillConnectedFault(input.workerId);
      return { workerId: input.workerId, forgotten: true };
    },
  });
}

/** Default discovery-only operation; live servers use `createForgetWorkerOperation(...)`. */
export const forgetWorkerOperation = createForgetWorkerOperation();

/** Build the REST binding for `weft.workers.forget`: `POST /v1/workers/:workerId/forget`. */
export function createForgetWorkerRestBinding(): UnknownRestBinding {
  return {
    method: 'POST',
    path: '/v1/workers/:workerId/forget',
    pathParamNames: ['workerId'],
    operationName: 'weft.workers.forget',
    inputSources: { workerId: { kind: 'path', pathParam: 'workerId' } },
    extractInput: async (_request, pathParams) => ({ workerId: pathParams['workerId'] ?? '' }),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeWeftOperationFaultAsJson,
  };
}

function workerNotFoundFault(workerId: string): OperationFault {
  return {
    code: 'NotFound',
    message: `Worker not found: ${workerId}`,
    data: { resource: 'worker', identifier: workerId },
  };
}

function workerStillConnectedFault(workerId: string): OperationFault {
  return {
    code: 'Conflict',
    message: `Worker ${workerId} is still connected and taking work, so it cannot be forgotten. Drain it first.`,
    data: { reason: WORKER_CONFLICT_REASONS.workerStillConnected },
  };
}
