import { z } from 'zod';
import type {
  WorkerDeploymentCatalog,
  WorkerDeploymentRouting,
} from '../../worker/deployment-routing.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestTextBody } from '../rest-body.ts';

const routingInput = z.object({
  deploymentName: z.string().min(1),
  currentBuildId: z.string().min(1),
  rampingBuildId: z.string().min(1).optional(),
  rampBasisPoints: z.number().int().min(0).max(10_000),
  expectedGeneration: z.number().int().min(0).optional(),
});
const deploymentInput = z.object({ deploymentName: z.string().min(1), buildId: z.string().min(1) });
const diagnosticsInput = z.object({ deploymentName: z.string().min(1).optional() });
const access = {
  kind: 'scoped' as const,
  scopes: { kind: 'anyOf' as const, scopes: ['system:admin'] as const },
};
type Options = { catalog?: WorkerDeploymentCatalog };
type RoutingInput = z.infer<typeof routingInput>;

function unavailable(name: string): Error {
  return new Error(`${name} requires a live worker deployment catalog.`);
}

export function createSetWorkerDeploymentRoutingOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.setrouting',
    mcpExposable: false,
    summary: 'Set a deployment routing pointer',
    destructive: true,
    tags: ['System'],
    inputSchema: routingInput,
    outputSchema: z.object({
      deploymentName: z.string(),
      currentBuildId: z.string(),
      rampingBuildId: z.string().optional(),
      rampBasisPoints: z.number(),
      generation: z.number(),
      updatedAt: z.number(),
    }),
    access,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('setRouting');
      const target = await validateRoutingTargets(options.catalog, input);
      return setRoutingOrThrow(options.catalog, target);
    },
  });
}

export function createPromoteWorkerDeploymentOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.promote',
    mcpExposable: false,
    summary: 'Promote a deployment build',
    destructive: true,
    tags: ['System'],
    inputSchema: deploymentInput,
    outputSchema: z.object({
      deploymentName: z.string(),
      currentBuildId: z.string(),
      rampBasisPoints: z.number(),
      generation: z.number(),
      updatedAt: z.number(),
    }),
    access,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('promote');
      const version = await options.catalog.getVersion(input.deploymentName, input.buildId);
      if (version === null || version.state === 'removed')
        throw new Error(
          `Deployment build ${input.deploymentName}/${input.buildId} does not exist.`,
        );
      const current = await options.catalog.getRouting(input.deploymentName);
      return setRoutingOrThrow(options.catalog, {
        deploymentName: input.deploymentName,
        currentBuildId: input.buildId,
        rampBasisPoints: 10_000,
        updatedAt: Date.now(),
        ...(current === null ? {} : { expectedGeneration: current.generation }),
      });
    },
  });
}

export function createRollbackWorkerDeploymentOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.rollback',
    mcpExposable: false,
    summary: 'Rollback a deployment to a build',
    destructive: true,
    tags: ['System'],
    inputSchema: deploymentInput,
    outputSchema: z.object({
      deploymentName: z.string(),
      currentBuildId: z.string(),
      rampBasisPoints: z.number(),
      generation: z.number(),
      updatedAt: z.number(),
    }),
    access,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('rollback');
      const version = await options.catalog.getVersion(input.deploymentName, input.buildId);
      if (version === null || version.state === 'removed')
        throw new Error(
          `Deployment build ${input.deploymentName}/${input.buildId} does not exist.`,
        );
      const current = await options.catalog.getRouting(input.deploymentName);
      return setRoutingOrThrow(options.catalog, {
        deploymentName: input.deploymentName,
        currentBuildId: input.buildId,
        rampBasisPoints: 10_000,
        updatedAt: Date.now(),
        ...(current === null ? {} : { expectedGeneration: current.generation }),
      });
    },
  });
}

export function createWorkerDeploymentDiagnosticsOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.diagnostics',
    mcpExposable: false,
    summary: 'List deployment versions and routing pointers',
    destructive: false,
    tags: ['System'],
    inputSchema: diagnosticsInput,
    outputSchema: z.object({ versions: z.array(z.any()), routing: z.any() }),
    access: {
      kind: 'scoped' as const,
      scopes: { kind: 'anyOf' as const, scopes: ['system:read'] as const },
    },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('diagnostics');
      return {
        versions: [...(await options.catalog.diagnostics(input.deploymentName))],
        routing:
          input.deploymentName === undefined
            ? null
            : await options.catalog.getRouting(input.deploymentName),
      };
    },
  });
}

export function createPreviewWorkerDeploymentRoutingOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.preview',
    mcpExposable: false,
    summary: 'Validate a deployment routing change without mutating it',
    destructive: false,
    tags: ['System'],
    inputSchema: routingInput,
    outputSchema: z.object({ valid: z.boolean(), message: z.string() }),
    access,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('preview');
      await validateRoutingTargets(options.catalog, input);
      return {
        valid: true,
        message: 'Routing targets are available and immutable identities agree.',
      };
    },
  });
}

async function validateRoutingTargets(
  catalog: WorkerDeploymentCatalog,
  input: RoutingInput,
): Promise<Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number }> {
  const current = await catalog.getVersion(input.deploymentName, input.currentBuildId);
  if (current === null || current.state === 'removed')
    throw new Error(
      `Deployment build ${input.deploymentName}/${input.currentBuildId} does not exist.`,
    );
  if (input.rampingBuildId !== undefined) {
    const ramping = await catalog.getVersion(input.deploymentName, input.rampingBuildId);
    if (ramping === null || ramping.state === 'removed')
      throw new Error(
        `Deployment build ${input.deploymentName}/${input.rampingBuildId} does not exist.`,
      );
  }
  return {
    deploymentName: input.deploymentName,
    currentBuildId: input.currentBuildId,
    rampBasisPoints: input.rampBasisPoints,
    updatedAt: Date.now(),
    ...(input.rampingBuildId === undefined ? {} : { rampingBuildId: input.rampingBuildId }),
    ...(input.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: input.expectedGeneration }),
  };
}

async function setRoutingOrThrow(
  catalog: WorkerDeploymentCatalog,
  input: Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number },
): Promise<WorkerDeploymentRouting> {
  const result = await catalog.setRouting(input);
  if (result === null)
    throw new Error('Routing generation changed concurrently; retry with the current generation.');
  return result;
}

export const setWorkerDeploymentRoutingOperation = createSetWorkerDeploymentRoutingOperation();
export const promoteWorkerDeploymentOperation = createPromoteWorkerDeploymentOperation();
export const rollbackWorkerDeploymentOperation = createRollbackWorkerDeploymentOperation();
export const workerDeploymentDiagnosticsOperation = createWorkerDeploymentDiagnosticsOperation();
export const previewWorkerDeploymentRoutingOperation =
  createPreviewWorkerDeploymentRoutingOperation();

function binding(method: 'GET' | 'POST', path: string, operationName: string): UnknownRestBinding {
  return {
    method,
    path,
    pathParamNames: [],
    operationName,
    inputSources: { body: { kind: 'body', mediaType: 'application/json' } },
    extractInput: async (request, _path, context) =>
      JSON.parse(await readRestTextBody(request, context)),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeOperationFaultAsJson,
  };
}
export const workerDeploymentRoutingRestBinding = binding(
  'POST',
  '/v1/worker-deployments/routing',
  'weft.worker.deployments.setrouting',
);
export const workerDeploymentDiagnosticsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/worker-deployments/diagnostics',
  pathParamNames: [],
  operationName: 'weft.worker.deployments.diagnostics',
  inputSources: { deploymentName: { kind: 'query', queryParam: 'deploymentName' } },
  extractInput: async (request) => {
    const deploymentName = new URL(request.url).searchParams.get('deploymentName');
    return deploymentName === null ? {} : { deploymentName };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
export const workerDeploymentPromoteRestBinding = binding(
  'POST',
  '/v1/worker-deployments/promote',
  'weft.worker.deployments.promote',
);
export const workerDeploymentRollbackRestBinding = binding(
  'POST',
  '/v1/worker-deployments/rollback',
  'weft.worker.deployments.rollback',
);
export const workerDeploymentPreviewRestBinding = binding(
  'POST',
  '/v1/worker-deployments/preview',
  'weft.worker.deployments.preview',
);
