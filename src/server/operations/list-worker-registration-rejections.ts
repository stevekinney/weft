/**
 * `weft.workers.rejections` operation + REST binding.
 *
 * Bounded, auditable log of recently declined `register` attempts (WFT-29):
 * the rejection code, the attempted workerId when known, and whatever
 * deployment/queue identity had already been parsed by the time the gate
 * that rejected it ran. No free-text rejection message and no manifest
 * content — this surfaces "who got rejected, when, and why (by code)", not
 * a diagnostic dump.
 *
 * @module server/operations/list-worker-registration-rejections
 */

import { z } from 'zod';

import type { RegistrationRejectionEntry, WorkerRegistry } from '../../worker/registry.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const registrationRejectionCodeSchema = z.enum([
  'invalid_registration',
  'unsupported_protocol_version',
  'deployment_conflict',
  'registration_rejected',
]);

const registrationRejectionEntrySchema = z
  .object({
    code: registrationRejectionCodeSchema,
    workerId: z.string().optional(),
    rejectedAt: z.number(),
    queue: z.string().optional(),
    deploymentName: z.string().optional(),
    buildId: z.string().optional(),
  })
  .strict() satisfies z.ZodType<RegistrationRejectionEntry>;

const listWorkerRegistrationRejectionsInput = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const listWorkerRegistrationRejectionsOutput = z.object({
  items: z.array(registrationRejectionEntrySchema),
  limit: z.number().int().min(1).max(MAX_LIMIT),
});

export type ListWorkerRegistrationRejectionsInput = z.infer<
  typeof listWorkerRegistrationRejectionsInput
>;
export type ListWorkerRegistrationRejectionsOutput = z.infer<
  typeof listWorkerRegistrationRejectionsOutput
>;

type ListWorkerRegistrationRejectionsOptions = {
  workerRegistry?: WorkerRegistry;
};

/**
 * Build the `weft.workers.rejections` operation, optionally bound to a live
 * `WorkerRegistry`. Mirrors `createListWorkersOperation`'s discovery-only
 * fallback: when `workerRegistry` is omitted, `invoke` throws if reached —
 * reserved for discovery-only registries (OpenAPI/AsyncAPI).
 */
export function createListWorkerRegistrationRejectionsOperation(
  options: ListWorkerRegistrationRejectionsOptions = {},
) {
  const registry = options.workerRegistry;
  return defineOperation<
    ListWorkerRegistrationRejectionsInput,
    ListWorkerRegistrationRejectionsOutput
  >({
    name: 'weft.workers.rejections',
    mcpExposable: false,
    summary: 'List recently declined worker registration attempts',
    description:
      'Bounded, most-recent-first log of declined `register` attempts: rejection code, ' +
      'attempted workerId when known, and whatever deployment/queue identity had already been ' +
      'parsed by the time the rejecting gate ran. No free-text message and no manifest content.',
    destructive: false,
    tags: ['Observability'],
    inputSchema: listWorkerRegistrationRejectionsInput,
    outputSchema: listWorkerRegistrationRejectionsOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
    producibleFaults: [],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }): Promise<ListWorkerRegistrationRejectionsOutput> => {
      if (registry === undefined) {
        throw new Error(
          'weft.workers.rejections invoked from a discovery-only operation registry; no WorkerRegistry was wired in',
        );
      }
      return { items: registry.getRecentRejections(input.limit), limit: input.limit };
    },
  });
}

/** Default discovery-only operation; live servers use `createListWorkerRegistrationRejectionsOperation(...)`. */
export const listWorkerRegistrationRejectionsOperation =
  createListWorkerRegistrationRejectionsOperation();

/**
 * Build the REST binding for `weft.workers.rejections`. The
 * binding is metadata only; the live `WorkerRegistry` is wired into the
 * operation, not the binding.
 */
export function createListWorkerRegistrationRejectionsRestBinding(): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/workers/registration-rejections',
    pathParamNames: [],
    operationName: 'weft.workers.rejections',
    inputSources: {
      limit: { kind: 'query', queryParam: 'limit' },
    },
    extractInput: async (request) => {
      const limit = new URL(request.url).searchParams.get('limit');
      return { limit: limit === null || limit.length === 0 ? undefined : Number(limit) };
    },
    success: { kind: 'json', status: 200 },
  };
}
