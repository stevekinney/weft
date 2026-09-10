import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { requireStorageCapability, storageValuesEqual } from '../../../storage/interface.ts';
import { AtomicStateConflictError } from '../../atomic-state.ts';
import type { Checkpoint, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import {
  commitWithWorkflowClaimFold,
  prepareWorkflowClaimFold,
  throwWorkflowClaimUnavailable,
  type WorkflowClaimFold,
} from '../workflow-claim-fold.ts';
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
  source: 'workflow-concurrency' | 'start-precondition' | 'duplicate-id';
  condition: ConditionalBatchCondition;
};

/** Outcome of {@link persistStartBatch}, disambiguating WHICH kind of race was lost. */
type PersistStartBatchOutcome = 'committed' | 'precondition-lost' | 'claim-lost';

/**
 * Commit the start batch. With no preconditions and no claim fold, this is a
 * plain `storage.batch()` (the hot path). With preconditions — used by
 * idempotent start and `startOrSignal` — it commits through
 * `storageConditionalBatch` so the workflow record, idempotency mapping, and
 * any create-batch signal land in ONE atomic compare-and-swap. Under
 * `ownership: 'workflow-lease'`, an ordinary (non-delayed) start additionally
 * folds `acquire()` into this SAME batch via `claimFold` (ADR 0002 § Entry
 * point classification): `workflowId` has no tracked claim before this write,
 * so it can never be fenced through `commitFencedEngineWrite` (which requires
 * an already-tracked epoch) — the fold's own conditions ARE the fence for this
 * first write instead. Returns `'precondition-lost'` when a base precondition
 * (idempotency mapping, workflow-concurrency admission) failed — the caller
 * resolves to the existing run or retries admission — and `'claim-lost'` when
 * the fold's own conditions were the ones that failed, which the caller
 * raises as `WorkflowClaimUnavailableError` rather than mistaking for either
 * of those. Requires the `conditionalBatch` capability whenever a batch of
 * conditions is committed, and throws if it is absent rather than silently
 * degrading to a non-atomic write.
 */
async function persistStartBatch(
  internals: EngineInternals,
  workflowId: string,
  startOperations: BatchOperation[],
  conditions: TaggedStartCondition[],
  claimFold: WorkflowClaimFold | undefined,
  isDelayedStart: boolean,
): Promise<PersistStartBatchOutcome> {
  if (claimFold) {
    const result = await commitWithWorkflowClaimFold(
      internals,
      claimFold,
      startOperations,
      conditions.map((entry) => entry.condition),
      'workflow claim acquisition',
    );
    if (result.status === 'committed') return 'committed';
    return result.claimConflict ? 'claim-lost' : 'precondition-lost';
  }

  // The start record is engine-generated workflow state — fence it on the lease
  // epoch (issue #470 Step 2) so a deposed engine cannot plant a phantom run in the
  // successor's store. Both branches go through the fenced helpers, which append the
  // epoch condition under `ownership: 'lease'` and are byte-for-byte no-ops under
  // `ownership: 'none'`. Under `ownership: 'workflow-lease'`, `fenceWorkflowId` is
  // `null` for a delayed start (its create batch is intentionally external — no
  // claim fold above — until its pending→running timer fire acquires the claim; see
  // `operations-time.ts`), so this write carries no per-workflow claim fence at all;
  // an ORDINARY start reaching this branch only happens while no
  // `WorkflowClaimRegistry` is constructed yet (Gate 1/Gate 2 wiring is a parallel
  // stage), in which case it still fails closed — correct for an unwired registry,
  // not a regression.
  const fenceWorkflowId = isDelayedStart ? null : workflowId;
  if (conditions.length === 0) {
    await commitFencedEngineWrite(
      internals,
      fenceWorkflowId,
      startOperations,
      [],
      () => new Error('Workflow start lost its CAS race.'),
    );
    return 'committed';
  }
  requireStorageCapability(internals.storage, 'conditionalBatch', 'start preconditions');
  // Preserve the idempotent-start contract: a base-precondition failure returns
  // `'precondition-lost'` (caller resolves to the existing run), while a lost epoch
  // fence is a hard deposition halt rather than a spurious "run already exists".
  const committed = await commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    fenceWorkflowId,
    startOperations,
    conditions.map((entry) => entry.condition),
  );
  return committed ? 'committed' : 'precondition-lost';
}

/**
 * Re-read the conditions tagged `source` and report whether any no longer matches.
 * A `conditionalBatch` returning `false` says only that SOME condition missed, so
 * this is how the caller attributes the miss to one specific cause — an idempotency
 * race, a duplicate id, or a workflow-concurrency admission slip — each of which
 * the caller answers with a different, caller-visible outcome. Returns `false`
 * immediately when no condition carries `source`.
 */
async function hasStartConditionConflict(
  internals: EngineInternals,
  conditions: TaggedStartCondition[],
  source: TaggedStartCondition['source'],
): Promise<boolean> {
  for (const entry of conditions) {
    if (entry.source !== source) continue;
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

function tagDuplicateIdCondition(
  condition: ConditionalBatchCondition | undefined,
): TaggedStartCondition[] {
  return condition === undefined ? [] : [{ source: 'duplicate-id' as const, condition }];
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
    (() => Promise<WorkflowConcurrencyStartOperations | undefined>) | undefined;
  callbacks: LifecycleCallbacks;
  /**
   * Storage deletes for a prior terminal run being displaced by an
   * `onTerminalConflict: 'start-new'` restart. Prepended ahead of the create puts
   * so purge-and-recreate commit as one atomic batch (see
   * {@link buildStartBatchOperations}). Undefined for an ordinary start.
   */
  purgeDeleteOperations: BatchOperation[] | undefined;
  /**
   * Compare-and-swap precondition making the caller-supplied-id duplicate check
   * atomic with this commit (WFT-152). Built by `resolveTerminalConflictForRestart`
   * from the exact bytes its duplicate-id read observed, and carried here as the
   * `duplicateIdCondition` of the `StartDuplicateIdDecision` it returns. Undefined
   * for a generated id, which cannot collide and so keeps the unconditioned hot
   * path.
   */
  duplicateIdCondition: ConditionalBatchCondition | undefined;
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
      ...tagDuplicateIdCondition(context.duplicateIdCondition),
      ...tagWorkflowConcurrencyConditions(workflowConcurrency?.conditions ?? []),
    ];
    // ADR 0002 row `startWorkflow`/`buildAndCommitStartBatch`: claim-acquiring for
    // an ordinary start, but the delayed `startAt`/`startAfter` create batch is
    // intentionally external — its `pending` row has no owner yet, and the
    // corresponding acquire happens later, at the delayed-start timer fire (see
    // `operations-time.ts`). Re-prepared fresh every attempt of this loop, since a
    // stale epoch read would doom a later retry's CAS.
    const isDelayedStart = context.delayedStartTimer !== undefined;
    const claimFold = isDelayedStart
      ? undefined
      : await prepareWorkflowClaimFold(internals, workflowId);

    const outcome = await persistStartBatch(
      internals,
      workflowId,
      startOperations,
      conditions,
      claimFold,
      isDelayedStart,
    );
    if (outcome === 'committed') {
      return;
    }
    if (await hasStartConditionConflict(internals, conditions, 'start-precondition')) {
      throw new StartIdempotencyRaceLostError();
    }
    if (outcome === 'claim-lost') {
      return throwWorkflowClaimUnavailable(internals, workflowId);
    }
    // WFT-152: another engine sharing this store committed a create for the same
    // caller-supplied id after this start's duplicate-id read. Surface the SAME
    // error the in-engine `pendingStarts` guard raises for the identical
    // collision, so a cross-engine duplicate id is indistinguishable from an
    // in-engine one from the caller's side. Checked AFTER `claim-lost` because a
    // `workflow-lease` loser fails both conditions and must keep reporting the
    // claim outcome, and BEFORE the workflow-concurrency fallthrough because a
    // duplicate id is terminal — re-entering the admission retry loop would
    // re-fail this same condition on every attempt and end in a misleading
    // `AtomicStateConflictError`.
    if (context.duplicateIdCondition !== undefined) {
      // Attribute by ELIMINATION whenever nothing else could have missed, rather
      // than by re-reading the key. A re-read is not reliable here: the winning run
      // can complete and be purged (or swept by retention) between the failed
      // compare-and-swap and this check, restoring `wf:<id>` to the very value the
      // condition expected. The conflict then reads as "no conflict" and the start
      // would fall through to the `StartIdempotencyRaceLostError` sentinel below —
      // which is internal and documented as never reaching a caller. With no
      // workflow-concurrency conditions in this batch, the duplicate-id condition is
      // the only base condition there was, so a `'precondition-lost'` outcome is
      // proof enough on its own.
      if (workflowConcurrency === undefined) {
        throw new WorkflowAlreadyExistsError(workflowId);
      }
      // Both kinds of base condition are present, so the outcome alone cannot say
      // which missed. Re-read only the duplicate-id key: a concurrency admission
      // miss is retryable and must fall through to the loop, while a duplicate id is
      // terminal. The purge race above still applies, but mis-reading it here costs
      // a retry rather than a leaked sentinel — the admission loop ends in
      // `AtomicStateConflictError`, which is a public error.
      if (await hasStartConditionConflict(internals, conditions, 'duplicate-id')) {
        throw new WorkflowAlreadyExistsError(workflowId);
      }
    } else if (workflowConcurrency === undefined) {
      throw new StartIdempotencyRaceLostError();
    }
  }

  throw new AtomicStateConflictError(
    lastWorkflowConcurrencyStateKey ?? 'workflow concurrency admission',
    WORKFLOW_CONCURRENCY_ADMISSION_MAX_ATTEMPTS,
  );
}
