import { z } from 'zod';

import { defineOperation, type OperationFault } from "../../embedded/backchannel/src/index.ts";
import { readRestTextBody, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { type Storage } from "../../embedded/storage/src/index.ts";
import { decode } from '../../core/codec.ts';
import type { WorkflowState } from '../../core/types.ts';
import { KEYS } from '../../storage/keys.ts';
import { NoRoutedWorkerDeploymentError } from '../../worker/no-routed-deployment-error.ts';
import {
  issueWorkflowWorkerStartOverridePreview,
  type WorkerStartOverridePreview,
} from '../../worker/start-override-preview.ts';
import {
  evaluateWorkflowWorkerUpgrade,
  resolveWorkflowWorkerStartBinding,
  type WorkflowWorkerBinding,
} from '../../worker/versioning-policy.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import {
  UPGRADE_REFUSAL_REASON_PREFIX,
  WORKER_CONFLICT_REASONS,
} from './worker-conflict-reasons.ts';

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

function previewConflict(reason: string, message: string): OperationFault {
  return { code: 'Conflict', message, data: { reason } };
}

async function issuePreview(
  input: Input,
  options: Required<Options>,
): Promise<WorkerStartOverridePreview> {
  const stateBytes = await options.storage.get(KEYS.workflow(input.workflowId));
  if (stateBytes === null) {
    const missing: OperationFault = {
      code: 'NotFound',
      message: `Workflow "${input.workflowId}" does not exist.`,
      data: { resource: 'workflow', identifier: input.workflowId },
    };
    throw missing;
  }
  const state = decodeWorkflowState(stateBytes, input.workflowId);
  if (!terminal(state.status)) {
    throw previewConflict(
      WORKER_CONFLICT_REASONS.workflowNotTerminal,
      'Worker start override previews are only issued for terminal workflows.',
    );
  }
  if (state.workerBinding === undefined || state.workerVersioningPolicy === undefined) {
    throw previewConflict(
      WORKER_CONFLICT_REASONS.noWorkerBinding,
      'Workflow has no durable worker binding to override.',
    );
  }
  if (state.workerVersioningPolicy.mode !== 'auto-upgrade' || state.revision === undefined) {
    throw previewConflict(
      WORKER_CONFLICT_REASONS.policyNotAutoUpgrade,
      'Worker start override previews require an auto-upgrade worker policy.',
    );
  }
  const policy = state.workerVersioningPolicy;
  const targetBinding = await resolveTargetBinding(options, input, state, policy);
  const evaluation = evaluateWorkflowWorkerUpgrade({
    policy,
    current: state.workerBinding.current,
    candidate: targetBinding,
    checkpointCommitted: true,
    realmAcquired: false,
  });
  if (!evaluation.allowed) {
    throw previewConflict(
      `${UPGRADE_REFUSAL_REASON_PREFIX}${evaluation.reason}`,
      evaluation.message,
    );
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

async function resolveTargetBinding(
  options: Required<Options>,
  input: Input,
  state: WorkflowState,
  policy: NonNullable<WorkflowState['workerVersioningPolicy']>,
): Promise<WorkflowWorkerBinding> {
  try {
    return await resolveWorkflowWorkerStartBinding(options.storage, {
      workflowId: input.workflowId,
      workflowType: state.type,
      workflowRevision: state.revision ?? '',
      policy,
      boundAt: options.clock(),
      checkpointId: input.workflowId,
    });
  } catch (error) {
    if (error instanceof NoRoutedWorkerDeploymentError) {
      throw previewConflict(WORKER_CONFLICT_REASONS.noRoutedDeployment, error.message);
    }
    throw error;
  }
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
    producibleFaults: ['Conflict', 'InvalidParams', 'NotFound', 'UnsupportedCapability'],
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.storage === undefined || options.serverSecret === undefined) {
        const unsupported: OperationFault = {
          code: 'UnsupportedCapability',
          message: 'Worker start override previews require server signing configuration.',
          data: { capability: 'workerStartOverrideSigning' },
        };
        throw unsupported;
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
  shapeFault: shapeWeftOperationFaultAsJson,
};
