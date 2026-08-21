import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { requireStorageCapability, storageValuesEqual } from '../../../storage/interface.ts';
import { AtomicStateConflictError } from '../../atomic-state.ts';
import type { Checkpoint, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import type { WorkflowConcurrencyStartOperations } from '../workflow-concurrency.ts';
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

const WORKFLOW_CONCURRENCY_ADMISSION_MAX_ATTEMPTS = 5;

type TaggedStartCondition = {
  source: 'workflow-concurrency' | 'start-precondition';
  condition: ConditionalBatchCondition;
};

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
  workflowId: string,
  startOperations: BatchOperation[],
  conditions: TaggedStartCondition[],
): Promise<boolean> {
  // The start record is engine-generated workflow state — fence it on the lease
  // epoch (issue #470 Step 2) so a deposed engine cannot plant a phantom run in the
  // successor's store. Both branches go through the fenced helpers, which append the
  // epoch condition under `ownership: 'lease'` and are byte-for-byte no-ops under
  // `ownership: 'none'`. Workflow-scoped under `ownership: 'workflow-lease'`: ADR
  // 0002 folds `acquire()` into this enabling write (a later stage); until that
  // lands, `workflowId` has no tracked claim yet and every start fails closed —
  // correct for an unwired mode, not a regression (see the stage-89 patch summary).
  if (conditions.length === 0) {
    await commitFencedEngineWrite(
      internals,
      workflowId,
      startOperations,
      [],
      () => new Error('Workflow start lost its CAS race.'),
    );
    return true;
  }
  requireStorageCapability(internals.storage, 'conditionalBatch', 'start preconditions');
  // Preserve the idempotent-start contract: a base-precondition failure returns
  // `false` (caller resolves to the existing run), while a lost epoch fence is a
  // hard deposition halt rather than a spurious "run already exists".
  return commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    workflowId,
    startOperations,
    conditions.map((entry) => entry.condition),
  );
}

async function hasStartPreconditionConflict(
  internals: EngineInternals,
  conditions: TaggedStartCondition[],
): Promise<boolean> {
  for (const entry of conditions) {
    if (entry.source !== 'start-precondition') continue;
    const currentValue = await internals.storage.get(entry.condition.key);
    if (!storageValuesEqual(currentValue, entry.condition.expectedValue)) {
      return true;
    }
  }
  return false;
}

function tagStartPreconditions(
  conditions: ConditionalBatchCondition[] | undefined,
): TaggedStartCondition[] {
  return (conditions ?? []).map((condition) => ({
    source: 'start-precondition' as const,
    condition,
  }));
}

function tagWorkflowConcurrencyConditions(
  conditions: ConditionalBatchCondition[],
): TaggedStartCondition[] {
  return conditions.map((condition) => ({
    source: 'workflow-concurrency' as const,
    condition,
  }));
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
  buildWorkflowConcurrencyStartOperations:
    | (() => Promise<WorkflowConcurrencyStartOperations | undefined>)
    | undefined;
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
  const maxAttempts =
    context.buildWorkflowConcurrencyStartOperations === undefined
      ? 1
      : WORKFLOW_CONCURRENCY_ADMISSION_MAX_ATTEMPTS;
  let lastWorkflowConcurrencyStateKey: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const idempotent = buildIdempotentStartOperations?.(workflowId);
    const workflowConcurrency = await context.buildWorkflowConcurrencyStartOperations?.();
    lastWorkflowConcurrencyStateKey =
      workflowConcurrency?.stateKey ?? lastWorkflowConcurrencyStateKey;

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
      mergeAdditionalStartOperations(
        context.additionalStartOperations,
        mergeAdditionalStartOperations(idempotent?.operations, workflowConcurrency?.operations),
      ),
      context.callbacks,
      context.purgeDeleteOperations,
    );
    const conditions = [
      ...tagStartPreconditions(idempotent?.conditions),
      ...tagWorkflowConcurrencyConditions(workflowConcurrency?.conditions ?? []),
    ];

    const committed = await persistStartBatch(internals, workflowId, startOperations, conditions);
    if (committed) {
      return;
    }
    if (await hasStartPreconditionConflict(internals, conditions)) {
      throw new StartIdempotencyRaceLostError();
    }
    if (workflowConcurrency === undefined) {
      throw new StartIdempotencyRaceLostError();
    }
  }

  throw new AtomicStateConflictError(
    lastWorkflowConcurrencyStateKey ?? 'workflow concurrency admission',
    WORKFLOW_CONCURRENCY_ADMISSION_MAX_ATTEMPTS,
  );
}
