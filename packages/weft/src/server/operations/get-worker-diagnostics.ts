/**
 * `weft.workers.diagnostics` operation + REST binding.
 *
 * Bounded diagnostic detail for one connected worker (WFT-29), split into
 * two structurally distinct sub-objects: `instance` (this live socket —
 * queue, health, connection timestamps) and `deploymentVersion` (what
 * artifact it loaded — SDK/runtime identity, manifest digest, and every
 * advertised workflow's version/revision/contract hash). Keeping these
 * separate mirrors the manifest's own split between "which process" and
 * "which build" questions.
 *
 * Deliberately excludes `capabilities` and the raw payload schemas backing
 * each `contractHash` — this surfaces identity for drift detection, not a
 * schema dump.
 *
 * @module server/operations/get-worker-diagnostics
 */

import { z } from 'zod';

import type { WorkerHealth, WorkerRegistry } from '../../worker/registry.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const workerHealthSchema = z.enum(['active', 'draining', 'drained']) as z.ZodType<WorkerHealth>;

const workerActivityContractSchema = z
  .object({
    contractHash: z.string(),
    implementationRevision: z.string(),
  })
  .strict();

const workerWorkflowContractSummarySchema = z
  .object({
    workflowVersion: z.string(),
    workflowRevision: z.string(),
    contractHash: z.string(),
    activities: z.record(z.string(), workerActivityContractSchema),
  })
  .strict();

const workerInstanceIdentitySchema = z
  .object({
    workerId: z.string(),
    queue: z.string(),
    health: workerHealthSchema,
    connectedAt: z.number(),
    startedAt: z.number(),
    lastHeartbeatAt: z.number(),
    heartbeatAgeMs: z.number(),
  })
  .strict();

const workerDeploymentVersionIdentitySchema = z
  .object({
    deploymentName: z.string(),
    buildId: z.string(),
    artifactDigest: z.string(),
    runtimeName: z.string(),
    runtimeVersion: z.string(),
    sdkVersion: z.string(),
    manifestVersion: z.number(),
    protocolVersion: z.number(),
    manifestDigest: z.string(),
    workflows: z.record(z.string(), workerWorkflowContractSummarySchema),
  })
  .strict();

const workerDiagnosticsEntrySchema = z
  .object({
    instance: workerInstanceIdentitySchema,
    deploymentVersion: workerDeploymentVersionIdentitySchema,
  })
  .strict();

const getWorkerDiagnosticsInput = z.object({
  workerId: z.string().min(1),
});

const getWorkerDiagnosticsOutput = z.object({
  worker: workerDiagnosticsEntrySchema.nullable(),
});

export type GetWorkerDiagnosticsInput = z.infer<typeof getWorkerDiagnosticsInput>;
export type WorkerDiagnosticsEntry = z.infer<typeof workerDiagnosticsEntrySchema>;
export type GetWorkerDiagnosticsOutput = z.infer<typeof getWorkerDiagnosticsOutput>;

type GetWorkerDiagnosticsOptions = {
  workerRegistry?: WorkerRegistry;
  clock?: () => number;
};

/** Project one connected worker's registry record into the bounded diagnostics shape, or `null` if not connected. */
function projectWorkerDiagnostics(
  registry: WorkerRegistry,
  workerId: string,
  now: number,
): WorkerDiagnosticsEntry | null {
  const worker = registry.getWorker(workerId);
  if (worker === undefined) return null;

  const summary = registry.getWorkerSummaries(now).find((entry) => entry.id === workerId);
  if (summary === undefined) return null;

  const workflows: Record<string, z.infer<typeof workerWorkflowContractSummarySchema>> = {};
  for (const [workflowType, contract] of Object.entries(worker.manifest.workflows)) {
    workflows[workflowType] = {
      workflowVersion: contract.workflowVersion,
      workflowRevision: contract.workflowRevision,
      contractHash: contract.contractHash,
      activities: { ...contract.activities },
    };
  }

  return {
    instance: {
      workerId: worker.id,
      queue: worker.queue,
      health: summary.health,
      connectedAt: worker.connectedAt,
      startedAt: worker.startedAt,
      lastHeartbeatAt: worker.lastHeartbeat,
      heartbeatAgeMs: summary.heartbeatAgeMs,
    },
    deploymentVersion: {
      deploymentName: worker.manifest.deployment.name,
      buildId: worker.manifest.deployment.buildId,
      artifactDigest: worker.manifest.deployment.artifactDigest,
      runtimeName: worker.manifest.runtime.name,
      runtimeVersion: worker.manifest.runtime.version,
      sdkVersion: worker.manifest.sdkVersion,
      manifestVersion: worker.manifest.manifestVersion,
      protocolVersion: worker.manifest.protocolVersion,
      manifestDigest: worker.acceptedManifestDigest,
      workflows,
    },
  };
}

/**
 * Build the `weft.workers.diagnostics` operation, optionally bound to a live
 * `WorkerRegistry` and clock. Mirrors `createListWorkersOperation`'s
 * discovery-only fallback: when `workerRegistry` is omitted, `invoke` throws
 * if reached — reserved for discovery-only registries (OpenAPI/AsyncAPI).
 */
export function createGetWorkerDiagnosticsOperation(options: GetWorkerDiagnosticsOptions = {}) {
  const registry = options.workerRegistry;
  const clock = options.clock ?? Date.now;
  return defineOperation<GetWorkerDiagnosticsInput, GetWorkerDiagnosticsOutput>({
    name: 'weft.workers.diagnostics',
    mcpExposable: false,
    summary: 'Get bounded instance and deployment-version diagnostics for one connected worker',
    description:
      "Report one connected worker's identity split into two parts: `instance` (this live " +
      'connection — queue, health, connection timestamps) and `deploymentVersion` (the ' +
      'artifact it loaded — SDK/runtime identity, manifest digest, and every advertised ' +
      "workflow's version, revision, and contract hash). Returns `worker: null` when the " +
      'workerId is not currently connected. Excludes capabilities and raw payload schemas.',
    destructive: false,
    tags: ['Observability'],
    inputSchema: getWorkerDiagnosticsInput,
    outputSchema: getWorkerDiagnosticsOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
    producibleFaults: [],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<GetWorkerDiagnosticsOutput> => {
      if (registry === undefined) {
        throw new Error(
          'weft.workers.diagnostics invoked from a discovery-only operation registry; no WorkerRegistry was wired in',
        );
      }
      return { worker: projectWorkerDiagnostics(registry, input.workerId, clock()) };
    },
  });
}

/** Default discovery-only operation; live servers use `createGetWorkerDiagnosticsOperation(...)`. */
export const getWorkerDiagnosticsOperation = createGetWorkerDiagnosticsOperation();

/**
 * Build the REST binding for `weft.workers.diagnostics`. The binding is
 * metadata only; the live `WorkerRegistry` is wired into the operation.
 */
export function createGetWorkerDiagnosticsRestBinding(): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/workers/:workerId/diagnostics',
    pathParamNames: ['workerId'],
    operationName: 'weft.workers.diagnostics',
    inputSources: {
      workerId: { kind: 'path', pathParam: 'workerId' },
    },
    extractInput: async (_request, pathParams) => ({
      workerId: pathParams['workerId'] ?? '',
    }),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeOperationFaultAsJson,
  };
}
