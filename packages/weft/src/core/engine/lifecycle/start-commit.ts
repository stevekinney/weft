import {
  KEYS,
  requireStorageCapability,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { AtomicStateConflictError } from '../../atomic-state.ts';
import type { Checkpoint, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
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
  source: 'workflow-concurrency' | 'start-precondition' | 'catalog-entry';
  condition: ConditionalBatchCondition;
};

/**
 * Admission-time defense against the WFT-17 catalog-removal/start race
 * (Codex review, PR #958): fence a fresh start's create batch on the
 * resolved revision's durable catalog entry still being installed — so a
 * concurrent `removeWorkflowRevision()` on a DIFFERENT process, landing
 * between this process resolving `state.revision` and this batch's own
 * commit, cannot let the start silently commit a `wf:` record pinned to a
 * revision the catalog no longer carries (which recovery would later find
 * `unavailable` anyway, but only after the run had already run for a while
 * believing itself durably identified).
 *
 * Scoped to `ownershipMode !== 'none'` only: the cross-process race this
 * closes cannot occur under `ownership: 'none'`, which is single-writer by
 * contract (see "One engine per durable store" in the recovery guide) — the
 * SAME-process case is already closed by `inFlightStartsByRevision`
 * (reserved before this batch even builds). Both `'lease'` and
 * `'workflow-lease'` already require `conditionalBatch` for an ordinary
 * start's own epoch/claim fencing, so this adds no NEW storage-capability
 * requirement for the common path — only for a delayed (`startAt`/`startAfter`)
 * start under `workflow-lease`, which today can reach the zero-precondition
 * plain-`batch()` fast path; that narrow path now also requires
 * `conditionalBatch`, consistent with every other write this ownership mode
 * already makes.
 *
 * `conditionalBatch`'s precondition is checked against the LIVE stored value
 * AT COMMIT TIME, not at the time this function's own read happens — so
 * this needs no ordering coordination with `removeWorkflowRevision()`'s own
 * CAS; whichever one's commit lands first wins, and the loser's CAS fails
 * closed. A `null` read here (the entry is ALREADY gone by the time this
 * process looks) throws immediately rather than building an
 * `expectedValue: null` "still absent" precondition — the entry was
 * installed synchronously before `ensureWorkflowCatalogReady()` returned for
 * an eager type, or resolved and installed by `resolveExecutableRegistrationForRevision()`
 * for a dynamic source, so ITS absence here can only mean a concurrent
 * removal already won; treating that as "still absent, so still fine to
 * commit against" would be the exact bug this function exists to close.
 */
function needsCatalogEntryStartPrecondition(
  internals: EngineInternals,
  state: WorkflowState,
): state is WorkflowState & { revision: string } {
  return internals.options.ownershipMode !== 'none' && state.revision !== undefined;
}

/**
 * Only called once {@link needsCatalogEntryStartPrecondition} has already
 * confirmed (synchronously) that a precondition is needed — `await`ing an
 * `async` function always costs a microtask tick even when its own body
 * would take a fast-path early return, the same reason `isWorkflowCatalogReady()`
 * (`catalog-readiness.ts`) is its own sync check rather than folded into
 * `ensureWorkflowCatalogReady()`'s body. `buildAndCommitStartBatch()` is
 * EVERY start's shared commit loop, including `ownership: 'none'`'s hot
 * path, so an unconditional `await` here — even one whose body always
 * returns `undefined` immediately for that mode — would still shift this
 * loop's interleaving against concurrent callers on every single start,
 * with no compensating benefit for the mode where the precondition never
 * applies at all.
 */
async function buildCatalogEntryStartPrecondition(
  internals: EngineInternals,
  state: WorkflowState & { revision: string },
): Promise<TaggedStartCondition> {
  const key = KEYS.catalogEntry(state.type, state.revision);
  const entryBytes = await internals.storage.get(key);
  if (entryBytes === null) {
    throw new WorkflowRevisionUnavailableError(state.type, state.revision, 'not-installed');
  }
  return { source: 'catalog-entry', condition: { key, expectedValue: entryBytes } };
}

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

/**
 * Re-check specifically the `'catalog-entry'`-tagged condition (see
 * {@link buildCatalogEntryStartPrecondition}) against live storage, to
 * disambiguate a lost CAS caused by a concurrent revision removal from an
 * idempotency or workflow-concurrency conflict. Checked AFTER
 * {@link hasStartPreconditionConflict} in `buildAndCommitStartBatch` — a
 * same-idempotency-key winner takes priority when both are somehow true,
 * since resolving to the existing run is more useful to the caller than a
 * removal error.
 */
async function hasCatalogEntryConflict(
  internals: EngineInternals,
  conditions: TaggedStartCondition[],
): Promise<boolean> {
  for (const entry of conditions) {
    if (entry.source !== 'catalog-entry') continue;
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
    (() => Promise<WorkflowConcurrencyStartOperations | undefined>) | undefined;
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
    // Re-read fresh every attempt of this loop, same as `idempotent`/`claimFold`
    // above/below — a stale read from an earlier attempt would doom a later
    // retry's CAS, and real time (a full storage round-trip) passes between
    // attempts. Throws `WorkflowRevisionUnavailableError` immediately if the
    // revision is ALREADY gone by the time this attempt reads it. The sync
    // guard is checked BEFORE ever calling the async builder — see that
    // function's own doc for why an unconditional `await` here would cost
    // every start, including `ownership: 'none'`'s hot path, a microtask
    // tick it has no use for.
    const catalogEntryPrecondition = needsCatalogEntryStartPrecondition(internals, state)
      ? await buildCatalogEntryStartPrecondition(internals, state)
      : undefined;

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
      ...(catalogEntryPrecondition === undefined ? [] : [catalogEntryPrecondition]),
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
    if (await hasStartPreconditionConflict(internals, conditions)) {
      throw new StartIdempotencyRaceLostError();
    }
    if (await hasCatalogEntryConflict(internals, conditions)) {
      throw new WorkflowRevisionUnavailableError(state.type, state.revision, 'not-installed');
    }
    if (outcome === 'claim-lost') {
      return throwWorkflowClaimUnavailable(internals, workflowId);
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
