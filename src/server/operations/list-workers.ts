/**
 * `weft.workers.list` operation + REST binding.
 *
 * Reports the connected-worker fleet for an operator-facing
 * "Workers & Queues" view: per-worker queue assignment, advertised
 * activities, concurrency, in-flight count, available capacity,
 * connected/heartbeat timestamps, and heartbeat age. Routing policy is
 * reported at the response top level so it does not drift per-worker.
 *
 * Access is `system:read` because the registry is server-wide
 * infrastructure.
 *
 * The operation is constructed via a factory that closes over a
 * `WorkerRegistry` and an injectable `clock`. Tests use a deterministic
 * clock to prove the operation reads "now" exactly once per request and
 * derives every `heartbeatAgeMs` from it.
 *
 * Discovery-only callers (`asyncapi`, `openapi`) may build the operation
 * with no registry; the resulting `invoke` is a sentinel that throws if
 * reached. No live request path uses a discovery-only registry.
 *
 * @module server/operations/list-workers
 */

import { z } from 'zod';

import type { RemoteWorkerJsonValue } from '../../worker/protocol.ts';
import type {
  RoutingPolicy,
  WorkerDeploymentSummary,
  WorkerHealth,
  WorkerRegistry,
  WorkerSummary,
} from '../../worker/registry.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listWorkersInput = z.object({});

const routingPolicySchema = z.enum([
  'least-loaded',
  'round-robin',
  'fair-share',
]) as z.ZodType<RoutingPolicy>;

const workerHealthSchema = z.enum(['active', 'draining', 'drained']) as z.ZodType<WorkerHealth>;

const remoteWorkerJsonValueSchema: z.ZodType<RemoteWorkerJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(remoteWorkerJsonValueSchema),
    z.record(z.string(), remoteWorkerJsonValueSchema),
  ]),
);

const workerSummarySchema = z.object({
  id: z.string(),
  queue: z.string(),
  activities: z.array(z.string()),
  concurrency: z.number(),
  inFlight: z.number(),
  availableCapacity: z.number(),
  connectedAt: z.number(),
  lastHeartbeatAt: z.number(),
  heartbeatAgeMs: z.number(),
  startedAt: z.number(),
  capabilities: z.record(z.string(), remoteWorkerJsonValueSchema),
  health: workerHealthSchema,
  deploymentName: z.string().optional(),
  buildId: z.string().optional(),
  runtimeVersion: z.string().optional(),
  gitSha: z.string().optional(),
}) satisfies z.ZodType<WorkerSummary>;

const workerDeploymentSummarySchema = z.object({
  deploymentName: z.string().nullable(),
  buildId: z.string().nullable(),
  runtimeVersion: z.string().nullable(),
  gitSha: z.string().nullable(),
  health: workerHealthSchema,
  workers: z.number(),
  activeWorkers: z.number(),
  drainingWorkers: z.number(),
  drainedWorkers: z.number(),
  inFlight: z.number(),
  oldestStartedAt: z.number().nullable(),
}) satisfies z.ZodType<WorkerDeploymentSummary>;

const listWorkersOutput = z.object({
  items: z.array(workerSummarySchema),
  deployments: z.array(workerDeploymentSummarySchema),
  routingPolicy: routingPolicySchema,
}) satisfies z.ZodType<ListWorkersOutput>;

export type ListWorkersInput = z.infer<typeof listWorkersInput>;
export type ListWorkersOutput = {
  items: WorkerSummary[];
  deployments: WorkerDeploymentSummary[];
  routingPolicy: RoutingPolicy;
};

type ListWorkersOptions = {
  workerRegistry?: WorkerRegistry;
  clock?: () => number;
};

/**
 * Build the `weft.workers.list` operation, optionally bound to a live
 * `WorkerRegistry` and clock.
 *
 * When `workerRegistry` is omitted, the operation is registered with full
 * metadata (name, schemas, access, transports) so the public catalog
 * stays honest, but `invoke` throws if called — this path is reserved
 * for discovery-only registries (OpenAPI/AsyncAPI generators).
 */
export function createListWorkersOperation(options?: ListWorkersOptions) {
  const registry = options?.workerRegistry;
  const clock = options?.clock ?? Date.now;
  return defineOperation<ListWorkersInput, ListWorkersOutput>({
    name: 'weft.workers.list',
    mcpExposable: false,
    summary: 'List connected workers, their advertised activities, and saturation',
    description:
      'List workers currently connected to the engine, including each worker id, its advertised ' +
      'activities and workflows, drain state, and saturation. Read-only. Use this to observe ' +
      'the worker fleet before draining or rebalancing.',
    destructive: false,
    tags: ['System'],
    inputSchema: listWorkersInput,
    outputSchema: listWorkersOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async (): Promise<ListWorkersOutput> => {
      if (registry === undefined) {
        throw new Error(
          'weft.workers.list invoked from a discovery-only operation registry; no WorkerRegistry was wired in',
        );
      }
      const now = clock();
      return {
        items: registry.getWorkerSummaries(now),
        deployments: registry.getDeploymentSummaries(now),
        routingPolicy: registry.policy,
      };
    },
  });
}

/** Default discovery-only operation; live servers use `createListWorkersOperation(...)`. */
export const listWorkersOperation = createListWorkersOperation();

/**
 * Build the REST binding for `weft.workers.list`. The binding is metadata
 * only; the live `WorkerRegistry` is wired into the operation, not the
 * binding.
 */
export function createListWorkersRestBinding(): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/workers',
    pathParamNames: [],
    operationName: 'weft.workers.list',
    inputSources: {},
    extractInput: async () => ({}),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeOperationFaultAsJson,
  };
}
