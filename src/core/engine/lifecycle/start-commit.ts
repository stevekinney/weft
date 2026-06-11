import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { requireStorageCapability, storageConditionalBatch } from '../../../storage/interface.ts';
import type { Checkpoint, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { type LifecycleCallbacks, type RegistrationEntry } from './shared.ts';
import { buildStartBatchOperations } from './start-batch.ts';

/**
 * Builds the id-dependent operations and compare-and-swap preconditions for an
 * idempotent start or `startOrSignal`. Invoked by `startWorkflow` with the real
 * `workflowId` once it has been generated, so the idempotency mapping put (and
 * any create-batch signal) can carry that id. The whole start batch then commits
 * through a single `storageConditionalBatch` gated on the returned conditions; a
 * lost CAS rolls back the start and throws {@link StartIdempotencyRaceLostError}
 * so the caller resolves to the winner.
 */
export type BuildIdempotentStartOperations = (workflowId: string) => {
  operations: BatchOperation[];
  conditions: ConditionalBatchCondition[];
};

/**
 * Internal sentinel: the idempotent create batch lost its compare-and-swap to a
 * concurrent caller holding the same idempotency key. Never surfaced to users —
 * `start` / `startOrSignal` catch it and resolve to the winning run's handle.
 */
export class StartIdempotencyRaceLostError extends Error {
  constructor() {
    super('start idempotency compare-and-swap lost to a concurrent caller');
    this.name = 'StartIdempotencyRaceLostError';
  }
}

/**
 * Commit the start batch. With no preconditions this is a plain `storage.batch()`
 * (the hot path). With preconditions — used by idempotent start and
 * `startOrSignal` — it commits through `storageConditionalBatch` so the workflow
 * record, idempotency mapping, and any create-batch signal land in ONE atomic
 * compare-and-swap. Returns `true` when the batch committed and `false` when a
 * precondition failed (a concurrent same-key caller already wrote the mapping),
 * so the caller can resolve to the existing run instead of leaking an orphan
 * record. Requires the `conditionalBatch` capability and throws if it is absent
 * rather than silently degrading to a non-atomic write.
 */
async function persistStartBatch(
  internals: EngineInternals,
  startOperations: BatchOperation[],
  conditions: ConditionalBatchCondition[] | undefined,
): Promise<boolean> {
  if (conditions === undefined) {
    await internals.storage.batch(startOperations);
    return true;
  }
  requireStorageCapability(internals.storage, 'conditionalBatch', 'start idempotency');
  return storageConditionalBatch(internals.storage, conditions, startOperations);
}

/** Concatenate caller-supplied and idempotency-derived create-batch operations. */
function mergeAdditionalStartOperations(
  additional: BatchOperation[] | undefined,
  idempotent: BatchOperation[] | undefined,
): BatchOperation[] | undefined {
  if (idempotent === undefined || idempotent.length === 0) {
    return additional;
  }
  return [...(additional ?? []), ...idempotent];
}

/** Everything {@link buildAndCommitStartBatch} needs to assemble the start batch. */
export type StartBatchContext = {
  internals: EngineInternals;
  workflowId: string;
  state: WorkflowState;
  checkpoint: Checkpoint;
  registration: RegistrationEntry;
  options: StartOptions | undefined;
  delayedStartTimer: TimerEntry | undefined;
  persistedWorkflowStartHeaders: Map<string, string> | undefined;
  additionalStartOperations: BatchOperation[] | undefined;
  callbacks: LifecycleCallbacks;
  /**
   * Storage deletes for a prior terminal run being displaced by an
   * `onTerminalConflict: 'start-new'` restart. Prepended ahead of the create puts
   * so purge-and-recreate commit as one atomic batch (see
   * {@link buildStartBatchOperations}). Undefined for an ordinary start.
   */
  purgeDeleteOperations: BatchOperation[] | undefined;
};

/**
 * Assemble the start batch — folding in the id-dependent idempotency mapping and
 * create-batch signal once the real workflow id exists — and commit it, gated on
 * any idempotency preconditions. Throws {@link StartIdempotencyRaceLostError}
 * when a concurrent same-key caller won the compare-and-swap, so the calling
 * `startWorkflow` rolls back its transient state and the wrapper resolves to the
 * winning run.
 */
export async function buildAndCommitStartBatch(
  context: StartBatchContext,
  buildIdempotentStartOperations: BuildIdempotentStartOperations | undefined,
): Promise<void> {
  const { internals, workflowId, state, checkpoint, registration, options } = context;
  const idempotent = buildIdempotentStartOperations?.(workflowId);

  const startOperations = buildStartBatchOperations(
    internals,
    workflowId,
    state,
    checkpoint,
    registration,
    options,
    state.executionDeadline,
    context.delayedStartTimer,
    context.persistedWorkflowStartHeaders,
    mergeAdditionalStartOperations(context.additionalStartOperations, idempotent?.operations),
    context.callbacks,
    context.purgeDeleteOperations,
  );

  const committed = await persistStartBatch(internals, startOperations, idempotent?.conditions);
  if (!committed) {
    throw new StartIdempotencyRaceLostError();
  }
}
