/**
 * Worker and deployment drain operations.
 *
 * Draining is an operator action: it keeps existing in-flight assignments
 * visible while excluding matching workers from new routing decisions. Worker
 * drains apply to one connected worker; deployment drains apply to every
 * current and future worker that registers the same deployment name.
 *
 * @module server/operations/worker-drain
 */

import { z } from 'zod';

import type { WorkerDrainMutationResult, WorkerRegistry } from '../../worker/registry.ts';
import type { AccessPolicy } from '../authorization.ts';
import { shapeOperationFaultAsJson, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const drainReasonSchema = z.string().min(1).max(256).optional();

const workerDrainInput = z.object({
  workerId: z.string().min(1),
  reason: drainReasonSchema,
});

const workerDrainClearInput = z.object({
  workerId: z.string().min(1),
});

const deploymentDrainInput = z.object({
  deploymentName: z.string().min(1),
  reason: drainReasonSchema,
});

const deploymentDrainClearInput = z.object({
  deploymentName: z.string().min(1),
});

const workerDrainResultSchema = z.object({
  target: z.literal('worker'),
  workerId: z.string(),
  affectedWorkers: z.number(),
  inFlight: z.number(),
  health: z.enum(['active', 'draining', 'drained']),
});

const deploymentDrainResultSchema = z.object({
  target: z.literal('deployment'),
  deploymentName: z.string(),
  affectedWorkers: z.number(),
  inFlight: z.number(),
  health: z.enum(['active', 'draining', 'drained']),
});

const workerDrainOutput = z.discriminatedUnion('target', [
  workerDrainResultSchema,
  deploymentDrainResultSchema,
]) satisfies z.ZodType<WorkerDrainMutationResult>;

export type WorkerDrainInput = z.infer<typeof workerDrainInput>;
export type WorkerDrainClearInput = z.infer<typeof workerDrainClearInput>;
export type DeploymentDrainInput = z.infer<typeof deploymentDrainInput>;
export type DeploymentDrainClearInput = z.infer<typeof deploymentDrainClearInput>;
export type WorkerDrainOutput = WorkerDrainMutationResult;

type WorkerDrainOperationOptions = {
  workerRegistry?: WorkerRegistry;
  clock?: () => number;
};

const adminAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['system:admin'] },
};

export function createDrainWorkerOperation(options?: WorkerDrainOperationOptions) {
  const registry = options?.workerRegistry;
  const clock = options?.clock ?? Date.now;
  return defineOperation<WorkerDrainInput, WorkerDrainOutput>({
    name: 'weft.workers.drain',
    mcpExposable: false,
    summary: 'Mark a connected worker as draining',
    destructive: true,
    tags: ['System'],
    inputSchema: workerDrainInput,
    outputSchema: workerDrainOutput,
    access: adminAccess,
    producibleFaults: ['NotFound'],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<WorkerDrainOutput> => {
      if (registry === undefined) throw discoveryOnlyError('weft.workers.drain');
      const result = registry.markWorkerDraining(input.workerId, {
        updatedAt: clock(),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      if (result === undefined) throw workerNotFoundFault(input.workerId);
      return result;
    },
  });
}

export function createClearWorkerDrainOperation(options?: WorkerDrainOperationOptions) {
  const registry = options?.workerRegistry;
  return defineOperation<WorkerDrainClearInput, WorkerDrainOutput>({
    name: 'weft.workers.resume',
    mcpExposable: false,
    summary: 'Clear a connected worker drain marker',
    destructive: false,
    tags: ['System'],
    inputSchema: workerDrainClearInput,
    outputSchema: workerDrainOutput,
    access: adminAccess,
    producibleFaults: ['NotFound'],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<WorkerDrainOutput> => {
      if (registry === undefined) throw discoveryOnlyError('weft.workers.resume');
      const result = registry.clearWorkerDrain(input.workerId);
      if (result === undefined) throw workerNotFoundFault(input.workerId);
      return result;
    },
  });
}

export function createDrainDeploymentOperation(options?: WorkerDrainOperationOptions) {
  const registry = options?.workerRegistry;
  const clock = options?.clock ?? Date.now;
  return defineOperation<DeploymentDrainInput, WorkerDrainOutput>({
    name: 'weft.worker.deployments.drain',
    mcpExposable: false,
    summary: 'Mark a worker deployment as draining',
    destructive: true,
    tags: ['System'],
    inputSchema: deploymentDrainInput,
    outputSchema: workerDrainOutput,
    access: adminAccess,
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<WorkerDrainOutput> => {
      if (registry === undefined) throw discoveryOnlyError('weft.worker.deployments.drain');
      return registry.markDeploymentDraining(input.deploymentName, {
        updatedAt: clock(),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    },
  });
}

export function createClearDeploymentDrainOperation(options?: WorkerDrainOperationOptions) {
  const registry = options?.workerRegistry;
  return defineOperation<DeploymentDrainClearInput, WorkerDrainOutput>({
    name: 'weft.worker.deployments.resume',
    mcpExposable: false,
    summary: 'Clear a worker deployment drain marker',
    destructive: false,
    tags: ['System'],
    inputSchema: deploymentDrainClearInput,
    outputSchema: workerDrainOutput,
    access: adminAccess,
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<WorkerDrainOutput> => {
      if (registry === undefined) throw discoveryOnlyError('weft.worker.deployments.resume');
      return registry.clearDeploymentDrain(input.deploymentName);
    },
  });
}

export const drainWorkerOperation = createDrainWorkerOperation();
export const clearWorkerDrainOperation = createClearWorkerDrainOperation();
export const drainDeploymentOperation = createDrainDeploymentOperation();
export const clearDeploymentDrainOperation = createClearDeploymentDrainOperation();

export function createDrainWorkerRestBinding(): UnknownRestBinding {
  return createWorkerDrainRestBinding('POST', 'weft.workers.drain');
}

export function createClearWorkerDrainRestBinding(): UnknownRestBinding {
  return createWorkerDrainRestBinding('DELETE', 'weft.workers.resume');
}

export function createDrainDeploymentRestBinding(): UnknownRestBinding {
  return createDeploymentDrainRestBinding('POST', 'weft.worker.deployments.drain');
}

export function createClearDeploymentDrainRestBinding(): UnknownRestBinding {
  return createDeploymentDrainRestBinding('DELETE', 'weft.worker.deployments.resume');
}

function createWorkerDrainRestBinding(method: 'POST' | 'DELETE', operationName: string) {
  return {
    method,
    path: '/v1/workers/:workerId/drain',
    pathParamNames: ['workerId'],
    operationName,
    inputSources: {
      workerId: { kind: 'path', pathParam: 'workerId' },
      ...(method === 'POST' ? { reason: { kind: 'body-field', bodyField: 'reason' } } : {}),
    },
    extractInput: async (request: Request, pathParams: Record<string, string>) => ({
      workerId: pathParams['workerId'] ?? '',
      ...(method === 'POST' ? await readDrainBody(request) : {}),
    }),
    success: { kind: 'json', status: 200 },
    shapeSuccess: shapeDrainSuccess,
    shapeFault: shapeOperationFaultAsJson,
  } satisfies UnknownRestBinding;
}

function createDeploymentDrainRestBinding(method: 'POST' | 'DELETE', operationName: string) {
  return {
    method,
    path: '/v1/worker-deployments/:deploymentName/drain',
    pathParamNames: ['deploymentName'],
    operationName,
    inputSources: {
      deploymentName: { kind: 'path', pathParam: 'deploymentName' },
      ...(method === 'POST' ? { reason: { kind: 'body-field', bodyField: 'reason' } } : {}),
    },
    extractInput: async (request: Request, pathParams: Record<string, string>) => ({
      deploymentName: pathParams['deploymentName'] ?? '',
      ...(method === 'POST' ? await readDrainBody(request) : {}),
    }),
    success: { kind: 'json', status: 200 },
    shapeSuccess: shapeDrainSuccess,
    shapeFault: shapeOperationFaultAsJson,
  } satisfies UnknownRestBinding;
}

function shapeDrainSuccess(output: WorkerDrainOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readDrainBody(request: Request): Promise<{ reason?: unknown }> {
  const text = await request.text();
  if (text.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidParamsFault('Drain request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidParamsFault('Drain request body must be a JSON object');
  }

  const reason = (parsed as Record<string, unknown>)['reason'];
  return reason === undefined ? {} : { reason };
}

function discoveryOnlyError(operationName: string): Error {
  return new Error(
    `${operationName} invoked from a discovery-only operation registry; no WorkerRegistry was wired in`,
  );
}

function workerNotFoundFault(workerId: string): OperationFault {
  return {
    code: 'NotFound',
    message: `Worker not found: ${workerId}`,
    data: { resource: 'worker', identifier: workerId },
  };
}
