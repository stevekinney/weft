import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import {
  type UnknownRestBinding,
  invalidParamsFault,
  readRestTextBody,
} from "../../embedded/backchannel/src/internals.ts";
import { z } from 'zod';
import type {
  WorkerDeploymentCatalog,
  WorkerDeploymentRemovalOutcome,
  WorkerDeploymentRouting,
  WorkerDeploymentRoutingWrite,
} from '../../worker/deployment-routing.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import { WORKER_CONFLICT_REASONS } from './worker-conflict-reasons.ts';
import { announceWorkerDeploymentChanged } from './worker-deployment-events.ts';

const routingInput = z.object({
  deploymentName: z.string().min(1),
  currentBuildId: z.string().min(1),
  rampingBuildId: z.string().min(1).optional(),
  rampBasisPoints: z.number().int().min(0).max(10_000),
  expectedGeneration: z.number().int().min(0).optional(),
});
const deploymentInput = z.object({ deploymentName: z.string().min(1), buildId: z.string().min(1) });
// Promote and rollback read the current generation; one past a previewed generation is a Conflict.
const moveBuildInput = deploymentInput.extend({
  expectedGeneration: z.number().int().min(0).optional(),
});
const routingFaults = ['Conflict', 'InvalidParams', 'NotFound'] as const;
const diagnosticsInput = z.object({ deploymentName: z.string().min(1).optional() });
const access = {
  kind: 'scoped' as const,
  scopes: { kind: 'anyOf' as const, scopes: ['system:admin'] as const },
};
type Options = {
  catalog?: WorkerDeploymentCatalog;
  /** With `dispatchEvent`, lets a routing change announce the deployment's drain state. */
  workerRegistry?: WorkerRegistry;
  /** Receives `worker:deployment-changed` after each routing change. */
  dispatchEvent?: (event: Event) => void;
};
type RoutingInput = z.infer<typeof routingInput>;

function unavailable(name: string): Error {
  return new Error(`${name} requires a live worker deployment catalog.`);
}

const operationTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
} as const;

const routingResultSchema = z.object({
  deploymentName: z.string(),
  currentBuildId: z.string(),
  rampingBuildId: z.string().optional(),
  rampBasisPoints: z.number(),
  previousBuildId: z
    .string()
    .optional()
    .describe(
      'The build that was current before the latest change of `currentBuildId`, which a rollback returns to; absent until the current build has changed once.',
    ),
  generation: z.number(),
  updatedAt: z.number(),
});

function versionNotFoundFault(deploymentName: string, buildId: string): OperationFault {
  return {
    code: 'NotFound',
    message: `Deployment build ${deploymentName}/${buildId} does not exist.`,
    data: { resource: 'workerDeploymentVersion', identifier: `${deploymentName}/${buildId}` },
  };
}

/** A routing change lost to another writer, or based on a generation the pointer has moved past. */
function staleGenerationFault(
  deploymentName: string,
  currentGeneration: number,
  expectedGeneration: number | undefined,
): OperationFault {
  const expected =
    expectedGeneration === undefined ? '' : ` (expected generation ${expectedGeneration})`;
  return {
    code: 'Conflict',
    message: `Routing generation for deployment "${deploymentName}" changed concurrently${expected}; retry with generation ${currentGeneration}.`,
    data: { reason: WORKER_CONFLICT_REASONS.staleGeneration, currentGeneration },
  };
}

function versionNotReadyFault(
  deploymentName: string,
  buildId: string,
  state: string,
): OperationFault {
  return {
    code: 'Conflict',
    message: `Deployment build ${deploymentName}/${buildId} is ${state}, so it is not eligible for routing.`,
    data: { reason: WORKER_CONFLICT_REASONS.versionNotReady },
  };
}

async function currentGenerationOf(
  catalog: WorkerDeploymentCatalog,
  deploymentName: string,
): Promise<number> {
  const routing = await catalog.getRouting(deploymentName);
  return routing?.generation ?? 0;
}

/** Fails a stale `expectedGeneration` before any write, so a preview and a mutation agree. */
async function assertExpectedGeneration(
  catalog: WorkerDeploymentCatalog,
  deploymentName: string,
  expectedGeneration: number | undefined,
): Promise<void> {
  if (expectedGeneration === undefined) return;
  const current = await currentGenerationOf(catalog, deploymentName);
  if (current !== expectedGeneration) {
    throw staleGenerationFault(deploymentName, current, expectedGeneration);
  }
}

export function createSetWorkerDeploymentRoutingOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.setrouting',
    mcpExposable: false,
    summary: 'Set a deployment routing pointer',
    description:
      'Set the current build, the optional ramping build, and the ramp share (basis points) of a ' +
      "deployment's routing pointer. Pass `expectedGeneration` to apply the change only if the " +
      'pointer is still at that generation; a pointer that has moved faults with Conflict ' +
      '(`reason: "stale-generation"`, `currentGeneration`). A build that does not exist faults with ' +
      'NotFound; one that is not ready faults with Conflict.',
    destructive: true,
    tags: ['System'],
    inputSchema: routingInput,
    outputSchema: routingResultSchema,
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('setRouting');
      const target = await validateRoutingTargets(options.catalog, input);
      const routing = await setRoutingOrThrow(options.catalog, target);
      await announceWorkerDeploymentChanged(options, routing.deploymentName, undefined, {
        routingGeneration: routing.generation,
      });
      return routing;
    },
  });
}

async function moveToBuild(
  options: Options & { catalog: WorkerDeploymentCatalog },
  input: z.infer<typeof moveBuildInput>,
): Promise<WorkerDeploymentRouting> {
  const catalog = options.catalog;
  const target = await validateRoutingTargets(catalog, {
    deploymentName: input.deploymentName,
    currentBuildId: input.buildId,
    rampBasisPoints: 10_000,
  });
  // Without an `expectedGeneration` the move is conditional on the generation just read.
  const expectedGeneration =
    input.expectedGeneration ?? (await currentGenerationOf(catalog, input.deploymentName));
  const routing = await setRoutingOrThrow(catalog, { ...target, expectedGeneration });
  await announceWorkerDeploymentChanged(options, routing.deploymentName, undefined, {
    routingGeneration: routing.generation,
  });
  return routing;
}

export function createPromoteWorkerDeploymentOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.promote',
    mcpExposable: false,
    summary: 'Promote a deployment build',
    description:
      "Route all of a deployment's new unpinned traffic to one build. Pass `expectedGeneration` " +
      '(for example from `weft.worker.deployments.preview`) to apply the change only if the ' +
      'pointer is still at that generation; otherwise it applies against the generation current ' +
      'at the time of the call. A moved pointer faults with Conflict (`reason: "stale-generation"`).',
    destructive: true,
    tags: ['System'],
    inputSchema: moveBuildInput,
    outputSchema: routingResultSchema.omit({ rampingBuildId: true }),
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('promote');
      return moveToBuild({ ...options, catalog: options.catalog }, input);
    },
  });
}

export function createRollbackWorkerDeploymentOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.rollback',
    mcpExposable: false,
    summary: 'Rollback a deployment to a build',
    description:
      'Route all new unpinned traffic of a deployment back to a previously registered build. ' +
      'Takes the same `expectedGeneration` precondition and faults as promote.',
    destructive: true,
    tags: ['System'],
    inputSchema: moveBuildInput,
    outputSchema: routingResultSchema.omit({ rampingBuildId: true }),
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('rollback');
      return moveToBuild({ ...options, catalog: options.catalog }, input);
    },
  });
}

export function createRemoveWorkerDeploymentVersionOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.remove',
    mcpExposable: false,
    summary: 'Remove a draining deployment build that no work is bound to',
    description:
      'Mark one deployment build removed, irreversibly. Only a draining build can be removed ' +
      '(drain it first with `weft.worker.deployments.drain`): a build that is not draining ' +
      'faults with Conflict (`reason: "version-not-draining"`). A build that does not exist, or ' +
      'was already removed, faults with NotFound. The current or ramping build of the routing ' +
      'pointer faults with Conflict (`reason: "version-routed"`). A build that durable work is ' +
      'still bound to faults with Conflict (`reason: "version-referenced"`): that work is every ' +
      'run that is not terminal (running, pending, or suspended) whose current worker binding ' +
      'names the build, under any worker-versioning policy, and every task-ledger entry that is ' +
      'not terminal whose execution requirement names the build; a dead-lettered entry is not ' +
      'terminal and keeps the build until it is cleared. Schedules and revision realms do not pin ' +
      'a build and do not count. A run, a task, or a retry that tries to bind to the build once it ' +
      'is removed fails with Conflict (`reason: "version-removed"`). If bindings keep landing on ' +
      'the build while the removal scans it, the removal gives up with Conflict ' +
      '(`reason: "version-busy"`); retry. A refused build is left as it was. The count is ' +
      'computed when the build is removed or listed, it is the `executionReferences` of ' +
      '`weft.worker.deployments.diagnostics`, and it falls to zero as the work finishes.',
    destructive: true,
    tags: ['System'],
    inputSchema: deploymentInput,
    outputSchema: z.object({
      deploymentName: z.string(),
      buildId: z.string(),
      removed: z.literal(true),
    }),
    access,
    producibleFaults: ['Conflict', 'NotFound'],
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      const catalog = options.catalog;
      if (catalog === undefined) throw unavailable('remove');
      const version = await catalog.getVersion(input.deploymentName, input.buildId);
      if (version === null || version.state === 'removed') {
        throw versionNotFoundFault(input.deploymentName, input.buildId);
      }
      const removal = await catalog.removeVersion(input.deploymentName, input.buildId);
      if (removal.outcome !== 'removed') {
        throw removalRefusal(removal, input.deploymentName, input.buildId);
      }
      return {
        deploymentName: input.deploymentName,
        buildId: input.buildId,
        removed: true as const,
      };
    },
  });
}

export function createWorkerDeploymentDiagnosticsOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.diagnostics',
    mcpExposable: false,
    summary: 'List deployment versions and routing pointers',
    description:
      'List the deployment builds, optionally of one deployment, with the routing pointer when ' +
      'a deployment is named. Each build carries `executionReferences`, the number of durable ' +
      'work items bound to it, computed from the run records and the task ledger when the list ' +
      'is read: every run that is not terminal whose current worker binding names the build, and ' +
      'every task-ledger entry that is not terminal whose execution requirement names it.',
    destructive: false,
    tags: ['System'],
    inputSchema: diagnosticsInput,
    outputSchema: z.object({ versions: z.array(z.any()), routing: z.any() }),
    access: {
      kind: 'scoped' as const,
      scopes: { kind: 'anyOf' as const, scopes: ['system:read'] as const },
    },
    transports: operationTransports,
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
    description:
      'Check that a routing change would be accepted, without applying it: the builds exist, ' +
      'are ready, and the ramp is valid. Returns the routing generation as it stands, ' +
      '`currentGeneration` (`0` before the first routing change), to pass as ' +
      '`expectedGeneration` to the change itself. When `expectedGeneration` is given and the ' +
      'pointer has moved past it, faults with Conflict (`reason: "stale-generation"`).',
    destructive: false,
    tags: ['System'],
    inputSchema: routingInput,
    outputSchema: z.object({
      valid: z.boolean(),
      message: z.string(),
      currentGeneration: z.number().int().min(0),
    }),
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('preview');
      await validateRoutingTargets(options.catalog, input);
      await assertExpectedGeneration(
        options.catalog,
        input.deploymentName,
        input.expectedGeneration,
      );
      return {
        valid: true,
        message: 'Routing targets are available and immutable identities agree.',
        currentGeneration: await currentGenerationOf(options.catalog, input.deploymentName),
      };
    },
  });
}

async function requireReadyVersion(
  catalog: WorkerDeploymentCatalog,
  deploymentName: string,
  buildId: string,
): Promise<void> {
  const version = await catalog.getVersion(deploymentName, buildId);
  if (version === null || version.state === 'removed') {
    throw versionNotFoundFault(deploymentName, buildId);
  }
  if (version.state !== 'ready') throw versionNotReadyFault(deploymentName, buildId, version.state);
}

async function validateRoutingTargets(
  catalog: WorkerDeploymentCatalog,
  input: RoutingInput,
): Promise<WorkerDeploymentRoutingWrite> {
  if (input.rampingBuildId === input.currentBuildId) {
    throw invalidParamsFault('Ramping deployment build must differ from the current build.');
  }
  await requireReadyVersion(catalog, input.deploymentName, input.currentBuildId);
  if (input.rampingBuildId !== undefined) {
    await requireReadyVersion(catalog, input.deploymentName, input.rampingBuildId);
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
  input: WorkerDeploymentRoutingWrite,
): Promise<WorkerDeploymentRouting> {
  const result = await catalog.setRouting(input);
  if (result === null) {
    throw staleGenerationFault(
      input.deploymentName,
      await currentGenerationOf(catalog, input.deploymentName),
      input.expectedGeneration,
    );
  }
  return result;
}

export const setWorkerDeploymentRoutingOperation = createSetWorkerDeploymentRoutingOperation();
export const promoteWorkerDeploymentOperation = createPromoteWorkerDeploymentOperation();
export const rollbackWorkerDeploymentOperation = createRollbackWorkerDeploymentOperation();
export const workerDeploymentDiagnosticsOperation = createWorkerDeploymentDiagnosticsOperation();
export const previewWorkerDeploymentRoutingOperation =
  createPreviewWorkerDeploymentRoutingOperation();
export const removeWorkerDeploymentVersionOperation =
  createRemoveWorkerDeploymentVersionOperation();

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
    shapeFault: shapeWeftOperationFaultAsJson,
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
  shapeFault: shapeWeftOperationFaultAsJson,
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
export const workerDeploymentRemoveRestBinding = binding(
  'POST',
  '/v1/worker-deployments/remove',
  'weft.worker.deployments.remove',
);

/** The fault that answers a removal the catalog refused, built from the reason it reported. */
function removalRefusal(
  refusal: Exclude<WorkerDeploymentRemovalOutcome, { outcome: 'removed' }>,
  deploymentName: string,
  buildId: string,
): OperationFault {
  const build = `Deployment build ${deploymentName}/${buildId}`;
  if (refusal.outcome === 'not-found') return versionNotFoundFault(deploymentName, buildId);
  if (refusal.outcome === 'not-draining') {
    return {
      code: 'Conflict',
      message: `${build} is ${refusal.state}, not draining, so it cannot be removed; drain it first.`,
      data: { reason: WORKER_CONFLICT_REASONS.versionNotDraining },
    };
  }
  if (refusal.outcome === 'routed') {
    return {
      code: 'Conflict',
      message: `${build} is a routing target and cannot be removed; route new traffic to another build first.`,
      data: { reason: WORKER_CONFLICT_REASONS.versionRouted },
    };
  }
  if (refusal.outcome === 'busy') {
    return {
      code: 'Conflict',
      message: `${build} kept receiving new work while it was scanned for removal; retry.`,
      data: { reason: WORKER_CONFLICT_REASONS.versionBusy },
    };
  }
  return {
    code: 'Conflict',
    message: `${build} is still referenced by ${refusal.references} piece${refusal.references === 1 ? '' : 's'} of work and cannot be removed.`,
    data: { reason: WORKER_CONFLICT_REASONS.versionReferenced },
  };
}
