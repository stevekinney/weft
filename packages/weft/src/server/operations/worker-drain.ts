/**
 * Worker and deployment drain operations.
 *
 * Draining is an operator action: it keeps existing in-flight assignments
 * visible while excluding matching workers from new routing decisions. Worker
 * drains apply to one connected worker; deployment drains apply to every
 * current and future worker that registers the same deployment name. A
 * deployment drain that names a `buildId` narrows to that one build, so a
 * version can be drained and resumed without touching its siblings.
 *
 * @module server/operations/worker-drain
 */

import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import {
  type AccessPolicy,
  type UnknownRestBinding,
  invalidParamsFault,
  isOperationFault,
  readRestTextBody,
} from "../../embedded/backchannel/src/internals.ts";
import type { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerDrainMutationResult, WorkerRegistry } from '../../worker/registry.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import { announceWorkerDeploymentChanged } from './worker-deployment-events.ts';

const drainReasonSchema = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe('Operator-facing reason for the drain, recorded with it; at most 256 characters.');

const workerDrainInput = z.object({
  workerId: z.string().min(1).describe('Id of the connected worker to drain.'),
  reason: drainReasonSchema,
});

const workerDrainClearInput = z.object({
  workerId: z.string().min(1).describe('Id of the drained worker to return to routing.'),
});

// Omitted means the whole deployment; present narrows to that build.
const buildIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Narrow to this build of the deployment. Omit it to cover the whole deployment.');

const deploymentDrainInput = z.object({
  deploymentName: z.string().min(1).describe('Name of the worker deployment to drain.'),
  buildId: buildIdSchema,
  reason: drainReasonSchema,
});

const deploymentDrainClearInput = z.object({
  deploymentName: z
    .string()
    .min(1)
    .describe('Name of the drained worker deployment to return to routing.'),
  buildId: buildIdSchema,
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
  buildId: z.string().optional(),
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
  /** Lets a build-scoped drain refuse a build the server has never accepted. */
  catalog?: WorkerDeploymentCatalog;
  /** Receives `worker:deployment-changed` after each deployment or build drain and resume. */
  dispatchEvent?: (event: Event) => void;
};

const adminAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['system:admin'] },
};

export function createDrainWorkerOperation(options?: WorkerDrainOperationOptions) {
  const registry = options?.workerRegistry;
  const clock = options?.clock ?? Date.now;
  return defineOperation({
    name: 'weft.workers.drain',
    mcpExposable: false,
    summary: 'Mark a connected worker as draining',
    description:
      'Mark a connected worker as draining by `workerId` so the engine stops dispatching new ' +
      'tasks to it while in-flight tasks finish, with an optional `reason`. Used for graceful ' +
      'shutdown and rolling deploys; clear the marker with the worker-resume operation. Faults ' +
      'with NotFound when no worker with the given id is connected.',
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
  return defineOperation({
    name: 'weft.workers.resume',
    mcpExposable: false,
    summary: 'Clear a connected worker drain marker',
    description:
      'Clear the drain marker on a connected worker so it is routed new tasks again. ' +
      "Returns the worker's resulting health and in-flight count. Faults with NotFound " +
      'when no worker with that id is connected.',
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
  const catalog = options?.catalog;
  const clock = options?.clock ?? Date.now;
  return defineOperation({
    name: 'weft.worker.deployments.drain',
    mcpExposable: false,
    summary: 'Mark a worker deployment, or one of its builds, as draining',
    description:
      'Mark every current and future worker of a deployment as draining so the engine stops ' +
      'dispatching new tasks to them while in-flight tasks finish, with an optional `reason`. ' +
      'Pass `buildId` to drain only that build of the deployment and leave its other builds ' +
      'routable; omit it to drain the whole deployment. A build the deployment catalog has not ' +
      'accepted, or has removed, faults with NotFound. A build drain is also recorded as the ' +
      "build's `draining` state in the deployment catalog, so it survives a restart and a " +
      'worker that registers on the build afterwards joins drained.',
    destructive: true,
    tags: ['System'],
    inputSchema: deploymentDrainInput,
    outputSchema: workerDrainOutput,
    access: adminAccess,
    producibleFaults: ['NotFound'],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<WorkerDrainOutput> => {
      if (registry === undefined) throw discoveryOnlyError('weft.worker.deployments.drain');
      const updated = {
        updatedAt: clock(),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      };
      const source = { dispatchEvent: options?.dispatchEvent, workerRegistry: registry, catalog };
      if (input.buildId === undefined) {
        const result = registry.markDeploymentDraining(input.deploymentName, updated);
        await announceWorkerDeploymentChanged(source, input.deploymentName, undefined, {
          drainState: result.health,
        });
        return result;
      }
      if (catalog === undefined) throw discoveryOnlyError('weft.worker.deployments.drain');
      const version = await catalog.getVersion(input.deploymentName, input.buildId);
      if (version === null || version.state === 'removed') {
        throw buildNotFoundFault(input.deploymentName, input.buildId);
      }
      // The catalog is the durable record of the drain; the registry marker is what routing reads
      // in this process. Writing the catalog first means a failed write drains nothing.
      await catalog.setVersionState(input.deploymentName, input.buildId, 'draining');
      const result = registry.markBuildDraining(input.deploymentName, input.buildId, updated);
      await announceWorkerDeploymentChanged(source, input.deploymentName, input.buildId, {
        drainState: result.health,
      });
      return result;
    },
  });
}

export function createClearDeploymentDrainOperation(options?: WorkerDrainOperationOptions) {
  const registry = options?.workerRegistry;
  const catalog = options?.catalog;
  return defineOperation({
    name: 'weft.worker.deployments.resume',
    mcpExposable: false,
    summary: "Clear a worker deployment drain marker, or one build's",
    description:
      'Clear the drain marker of a deployment, or of one build when `buildId` is given, so its ' +
      'workers are routable again. Clearing a marker that is not set succeeds and changes ' +
      'nothing. A wider marker still applies: resuming a build does not lift a deployment-wide ' +
      'drain or a drain on one worker. A build the catalog has removed faults with NotFound and ' +
      'stays drained.',
    destructive: false,
    tags: ['System'],
    inputSchema: deploymentDrainClearInput,
    outputSchema: workerDrainOutput,
    access: adminAccess,
    producibleFaults: ['NotFound'],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<WorkerDrainOutput> => {
      if (registry === undefined) throw discoveryOnlyError('weft.worker.deployments.resume');
      const source = { dispatchEvent: options?.dispatchEvent, workerRegistry: registry, catalog };
      if (input.buildId === undefined) {
        const result = registry.clearDeploymentDrain(input.deploymentName);
        await announceWorkerDeploymentChanged(source, input.deploymentName, undefined, {
          drainState: result.health,
        });
        return result;
      }
      // A removed build stays out of service: lifting its marker would route to workers an
      // operator took out. An unknown build has no catalog record, so there is nothing to refuse.
      if (catalog !== undefined) {
        const version = await catalog.getVersion(input.deploymentName, input.buildId);
        if (version?.state === 'removed') {
          throw buildNotFoundFault(input.deploymentName, input.buildId);
        }
        await catalog.setVersionState(input.deploymentName, input.buildId, 'ready');
      }
      const result = registry.clearBuildDrain(input.deploymentName, input.buildId);
      await announceWorkerDeploymentChanged(source, input.deploymentName, input.buildId, {
        drainState: result.health,
      });
      return result;
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
    extractInput: async (request: Request, pathParams: Record<string, string>, context) => ({
      workerId: pathParams['workerId'] ?? '',
      ...(method === 'POST' ? await readDrainBody(request, context) : {}),
    }),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeWeftOperationFaultAsJson,
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
      // A build narrows the drain to one version: a body field to drain, a query parameter to resume.
      ...(method === 'POST'
        ? {
            reason: { kind: 'body-field', bodyField: 'reason' },
            buildId: { kind: 'body-field', bodyField: 'buildId' },
          }
        : { buildId: { kind: 'query', queryParam: 'buildId' } }),
    },
    extractInput: async (request: Request, pathParams: Record<string, string>, context) => ({
      deploymentName: pathParams['deploymentName'] ?? '',
      ...(method === 'POST'
        ? await readDrainBody(request, context)
        : readBuildQuery(new URL(request.url))),
    }),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeWeftOperationFaultAsJson,
  } satisfies UnknownRestBinding;
}

function readBuildQuery(url: URL): { buildId?: string } {
  const buildId = url.searchParams.get('buildId');
  return buildId === null ? {} : { buildId };
}

async function readDrainBody(
  request: Request,
  context: Parameters<UnknownRestBinding['extractInput']>[2],
): Promise<{ reason?: unknown; buildId?: unknown }> {
  const text = await readRestTextBody(request, context);
  if (text.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (isOperationFault(error)) throw error;
    throw invalidParamsFault('Drain request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidParamsFault('Drain request body must be a JSON object');
  }

  const { reason, buildId } = parsed as Record<string, unknown>;
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(buildId === undefined ? {} : { buildId }),
  };
}

function discoveryOnlyError(operationName: string): Error {
  return new Error(
    `${operationName} invoked from a discovery-only operation registry; no WorkerRegistry was wired in`,
  );
}

function buildNotFoundFault(deploymentName: string, buildId: string): OperationFault {
  return {
    code: 'NotFound',
    message: `Deployment build not found: ${deploymentName}/${buildId}`,
    data: { resource: 'workerDeploymentVersion', identifier: `${deploymentName}/${buildId}` },
  };
}

function workerNotFoundFault(workerId: string): OperationFault {
  return {
    code: 'NotFound',
    message: `Worker not found: ${workerId}`,
    data: { resource: 'worker', identifier: workerId },
  };
}
