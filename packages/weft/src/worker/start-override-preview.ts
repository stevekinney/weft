import { hashString } from '../runtime/portable.ts';
import {
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from '../storage/interface.ts';
import type { WorkflowWorkerBinding } from './versioning-policy.ts';

export type WorkerStartOverridePreview = Readonly<{
  token: string;
  scope: 'destructive:workflow-worker-version-binding';
  workflowId: string;
  previousRoutingGeneration: number;
  targetRoutingGeneration: number;
  targetWorkflowContractHash: string;
  targetActivityContractsDigest: string;
  expiresAt: number;
}>;

export type WorkerStartOverrideConsumption = Readonly<{
  conditions: readonly ConditionalBatchCondition[];
  operations: readonly BatchOperation[];
}>;

const OVERRIDE_CONSUMED_PREFIX = 'workflow-worker-override-consumed:';

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function activityContractsDigest(binding: WorkflowWorkerBinding): string {
  return hashString(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(binding.activityContracts).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  );
}

/** Issue a short-lived, server-created token for the explicitly destructive start override. */
export function issueWorkflowWorkerStartOverridePreview(
  options: Readonly<{
    workflowId: string;
    previousBinding: WorkflowWorkerBinding;
    targetBinding: WorkflowWorkerBinding;
    serverSecret: string;
    now?: number;
    ttlMs?: number;
  }>,
): WorkerStartOverridePreview {
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? 60_000);
  const unsigned = {
    scope: 'destructive:workflow-worker-version-binding',
    workflowId: options.workflowId,
    previousRoutingGeneration: options.previousBinding.routingGeneration,
    targetRoutingGeneration: options.targetBinding.routingGeneration,
    targetWorkflowContractHash: options.targetBinding.workflowContractHash,
    targetActivityContractsDigest: activityContractsDigest(options.targetBinding),
    expiresAt,
  } satisfies Omit<WorkerStartOverridePreview, 'token'>;
  const token = signWorkflowWorkerStartOverridePreview(unsigned, options.serverSecret);
  return { ...unsigned, token };
}

export function verifyWorkflowWorkerStartOverridePreview(
  preview: WorkerStartOverridePreview,
  serverSecret: string,
  now = Date.now(),
): boolean {
  if (preview.scope !== 'destructive:workflow-worker-version-binding' || preview.expiresAt < now) {
    return false;
  }
  return constantTimeEqual(
    preview.token,
    signWorkflowWorkerStartOverridePreview(preview, serverSecret),
  );
}

function signWorkflowWorkerStartOverridePreview(
  preview: Omit<WorkerStartOverridePreview, 'token'>,
  serverSecret: string,
): string {
  return hashString(
    [
      'workflow-worker-override',
      preview.scope,
      preview.workflowId,
      String(preview.previousRoutingGeneration),
      String(preview.targetRoutingGeneration),
      preview.targetWorkflowContractHash,
      preview.targetActivityContractsDigest,
      String(preview.expiresAt),
      serverSecret,
    ].join('\0'),
  );
}

function bindingMatchesPreview(
  preview: WorkerStartOverridePreview,
  workflowId: string,
  previousBinding: WorkflowWorkerBinding | undefined,
  targetBinding: WorkflowWorkerBinding | undefined,
): boolean {
  return (
    previousBinding !== undefined &&
    targetBinding !== undefined &&
    preview.workflowId === workflowId &&
    previousBinding.workflowId === workflowId &&
    targetBinding.workflowId === workflowId &&
    previousBinding.routingGeneration === preview.previousRoutingGeneration &&
    targetBinding.routingGeneration === preview.targetRoutingGeneration &&
    targetBinding.workflowContractHash === preview.targetWorkflowContractHash &&
    activityContractsDigest(targetBinding) === preview.targetActivityContractsDigest
  );
}

export function buildWorkflowWorkerStartOverrideConsumption(
  options: Readonly<{
    workflowId: string;
    preview: WorkerStartOverridePreview;
    previousBinding: WorkflowWorkerBinding | undefined;
    targetBinding: WorkflowWorkerBinding | undefined;
    serverSecret: string;
    now?: number;
  }>,
): WorkerStartOverrideConsumption | null {
  const verified = verifyWorkflowWorkerStartOverridePreview(
    options.preview,
    options.serverSecret,
    options.now ?? Date.now(),
  );
  if (
    !verified ||
    !bindingMatchesPreview(
      options.preview,
      options.workflowId,
      options.previousBinding,
      options.targetBinding,
    )
  ) {
    return null;
  }

  const key = `${OVERRIDE_CONSUMED_PREFIX}${encodeURIComponent(options.workflowId)}:${options.preview.token}`;
  return {
    conditions: [{ key, expectedValue: null }],
    operations: [{ type: 'put', key, value: new Uint8Array(0) }],
  };
}

/** Consume a valid destructive override exactly once using a storage CAS. */
export async function consumeWorkflowWorkerStartOverridePreview(
  storage: Storage,
  preview: WorkerStartOverridePreview,
  serverSecret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!verifyWorkflowWorkerStartOverridePreview(preview, serverSecret, now)) return false;
  const key = `${OVERRIDE_CONSUMED_PREFIX}${encodeURIComponent(preview.workflowId)}:${preview.token}`;
  return storageConditionalBatch(
    storage,
    [{ key, expectedValue: null }],
    [{ type: 'put', key, value: new Uint8Array(0) }],
  );
}
