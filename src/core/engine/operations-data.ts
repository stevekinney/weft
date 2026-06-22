import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import { callMemoFunctionWithDurableActivityScope } from './memo-durable-activity.ts';
import type { ActivityOperationCallbacks } from './operations-activity.ts';
import type { OperationWithCallerStack } from './operations-router.ts';

type MemoOperation = Extract<ContextOperationRequest, { type: 'memo' }>;
type OffloadOperation = Extract<ContextOperationRequest, { type: 'offload' }>;
type LoadOperation = Extract<ContextOperationRequest, { type: 'load' }>;
type ArchiveOperation = Extract<ContextOperationRequest, { type: 'archive' }>;

export type DataOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  persistCheckpoint: (workflowId: string, operation: ContextOperationRequest) => Promise<void>;
  getActivityOperationCallbacks?: () => ActivityOperationCallbacks;
};

export async function processMemoOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: MemoOperation,
  callbacks: DataOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () =>
    callMemoFunctionWithDurableActivityScope(internals, workflowId, operation, callbacks),
  );
}

export async function processOffloadOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: OffloadOperation,
  callbacks: DataOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const data = await operation.fn();
    const encoded = encode(data);
    await internals.storage.put(KEYS.offload(workflowId, operation.key), encoded);
    return {
      key: operation.key,
      workflowId,
      sizeBytes: encoded.byteLength,
    };
  });
}

export async function processLoadOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: LoadOperation,
  callbacks: DataOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const { workflowId: referenceWorkflowId, key: referenceKey, sizeBytes } = operation.reference;

    if (typeof referenceWorkflowId !== 'string' || referenceWorkflowId !== workflowId) {
      throw new Error('ctx.load() can only read offloaded data from the current workflow');
    }
    if (typeof referenceKey !== 'string' || referenceKey.length === 0) {
      throw new Error('ctx.load() requires a non-empty offload reference key');
    }
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new Error('ctx.load() requires a valid offload reference size');
    }

    const raw = await internals.storage.get(KEYS.offload(referenceWorkflowId, referenceKey));
    if (raw === null) {
      throw new Error(
        `Offloaded data not found for key "${referenceKey}" in workflow "${referenceWorkflowId}"`,
      );
    }
    return decode(raw);
  });
}

/**
 * Read an offloaded value back out of storage by `workflowId` + `key`, decoding
 * it with the same codec {@link processOffloadOperation} wrote it with.
 *
 * This is the post-completion sibling of the in-workflow `ctx.load()` read
 * (see {@link processLoadOperation}): `ctx.load()` is restricted to the running
 * workflow's own offloads and throws on a miss, whereas this external reader
 * lets a consumer read a *terminal* workflow's offloaded output after
 * `handle.result()` resolves — the artifact survives normal completion
 * (`completeWorkflow`/`failWorkflow` preserve `offload:` keys) and is swept only
 * when the workflow is terminated/cancelled.
 *
 * @returns The decoded offload value, or `null` when no value is stored under
 *   that key (either the key was never written, or the artifact was swept).
 */
export async function getOffloadFromInternals(
  internals: EngineInternals,
  workflowId: string,
  key: string,
): Promise<unknown> {
  const raw = await internals.storage.get(KEYS.offload(workflowId, key));
  if (raw === null) {
    return null;
  }
  return decode(raw);
}

export async function processArchiveOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ArchiveOperation,
  callbacks: DataOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    await internals.storage.put(KEYS.archive(workflowId, operation.key), encode(operation.data));
    return undefined;
  });
}
