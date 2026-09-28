import { z } from 'zod';

import { decode } from '../../core/codec.ts';
import type { WorkflowState } from '../../core/types.ts';
import { KEYS, type Storage } from '../../storage/interface.ts';
import {
  issueWorkflowWorkerStartOverridePreview,
  type WorkerStartOverridePreview,
} from '../../worker/start-override-preview.ts';
import {
  evaluateWorkflowWorkerUpgrade,
  resolveWorkflowWorkerStartBinding,
} from '../../worker/versioning-policy.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestTextBody } from '../rest-body.ts';

const inputSchema = z.object({
  workflowId: z.string().min(1),
  ttlMs: z.number().int().positive().max(300_000).optional(),
});

const previewSchema = z.object({
  token: z.string(),
  scope: z.literal('destructive:workflow-worker-version-binding'),
  workflowId: z.string(),
  previousRoutingGeneration: z.number().int().min(0),
  targetRoutingGeneration: z.number().int().min(0),
  targetWorkflowContractHash: z.string(),
  targetActivityContractsDigest: z.string(),
  expiresAt: z.number().int().min(0),
});

const outputSchema = z.object({ preview: previewSchema });

type Options = Readonly<{
  storage?: Storage;
  serverSecret?: string;
  clock?: () => number;
}>;

type Input = z.infer<typeof inputSchema>;

const access = {
  kind: 'scoped' as const,
  scopes: { kind: 'anyOf' as const, scopes: ['system:admin'] as const },
};

function terminal(status: WorkflowState['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out'
  );
}

function decodeWorkflowState(bytes: Uint8Array, workflowId: string): WorkflowState {
  const decoded = decode(bytes);
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error(`Workflow "${workflowId}" has an invalid durable state.`);
  }
  return decoded as WorkflowState;
}

async function issuePreview(
  input: Input,
  options: Required<Options>,
): Promise<WorkerStartOverridePreview> {
  const stateBytes = await options.storage.get(KEYS.workflow(input.workflowId));
  if (stateBytes === null) {
    throw new Error(`Workflow "${input.workflowId}" does not exist.`);
  }
  const state = decodeWorkflowState(stateBytes, input.workflowId);
  if (!terminal(state.status)) {
    throw new Error('Worker start override previews are only issued for terminal workflows.');
  }
  if (state.workerBinding === undefined || state.workerVersioningPolicy === undefined) {
    throw new Error('Workflow has no durable worker binding to override.');
  }
  if (state.workerVersioningPolicy.mode !== 'auto-upgrade' || state.revision === undefined) {
    throw new Error('Worker start override previews require an auto-upgrade worker policy.');
  }
  const policy = state.workerVersioningPolicy;
  const targetBinding = await resolveWorkflowWorkerStartBinding(options.storage, {
    workflowId: input.workflowId,
    workflowType: state.type,
    workflowRevision: state.revision,
    policy,
    boundAt: options.clock(),
    checkpointId: input.workflowId,
  });
  const evaluation = evaluateWorkflowWorkerUpgrade({
    policy,
    current: state.workerBinding.current,
    candidate: targetBinding,
    checkpointCommitted: true,
    realmAcquired: false,
  });
  if (!evaluation.allowed) {
    throw new Error(evaluation.message);
  }
  return issueWorkflowWorkerStartOverridePreview({
    workflowId: input.workflowId,
    previousBinding: state.workerBinding.current,
    targetBinding,
    serverSecret: options.serverSecret,
    now: options.clock(),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
}

export function createWorkerStartOverridePreviewOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.startoverrides.preview',
    mcpExposable: false,
    summary: 'Issue a scoped worker start override preview',
    description:
      'Issues a short-lived, server-signed, one-time preview token that authorizes a terminal workflow start-new replacement to consume an accepted worker binding override. The token is scoped to one workflow id, one prior binding generation, and one accepted target contract.',
    destructive: false,
    tags: ['System'],
    inputSchema,
    outputSchema,
    access,
    producibleFaults: ['InvalidParams'],
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.storage === undefined || options.serverSecret === undefined) {
        throw new Error('Worker start override previews require server signing configuration.');
      }
      return {
        preview: await issuePreview(input, {
          storage: options.storage,
          serverSecret: options.serverSecret,
          clock: options.clock ?? Date.now,
        }),
      };
    },
  });
}

export const workerStartOverridePreviewOperation = createWorkerStartOverridePreviewOperation();

export const workerStartOverridePreviewRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/worker-start-overrides/preview',
  pathParamNames: [],
  operationName: 'weft.worker.startoverrides.preview',
  inputSources: { body: { kind: 'body', mediaType: 'application/json' } },
  extractInput: async (request, _path, context) =>
    JSON.parse(await readRestTextBody(request, context)),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
