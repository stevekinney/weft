import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import { buildIndexOperations } from '../../search-attributes.ts';
import type { Checkpoint, ForkLineage, SearchAttributeValue, WorkflowState } from '../../types.ts';
import type { ForkOptions } from '../../types/options.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { reserveInFlightStart } from '../catalog-removal.ts';
import { hydrateCheckpointReplayState } from '../checkpoint-replay.ts';
import { canResolveRevisionLocally } from '../dynamic-source-execution.ts';
import type { EngineInternals } from '../internals.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import { encodeWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowVisibilityIndexOperations } from '../workflow-indexes.ts';
import { EMPTY_STORAGE_VALUE, FORK_LINEAGE_ATTRIBUTE, type LifecycleCallbacks } from './shared.ts';
import { buildCatalogEntryRevisionCondition } from './start-commit.ts';

/**
 * Load and hydrate the source run's checkpoint for a fork — a specific
 * historical step (`fromStep`) or its latest — throwing when the requested
 * step doesn't exist. Extracted out of `fork()` itself purely to keep
 * `transition.ts` under the repository's implementation-file-size ceiling;
 * no behavior change from what was previously inlined there.
 */
export async function loadForkSourceCheckpoint(
  internals: EngineInternals,
  sourceWorkflowId: string,
  fromStep: number | undefined,
): Promise<Checkpoint> {
  const checkpointKey =
    fromStep !== undefined
      ? KEYS.checkpointHistory(sourceWorkflowId, fromStep)
      : KEYS.checkpoint(sourceWorkflowId);
  const checkpointBytes = await internals.storage.get(checkpointKey);
  if (!checkpointBytes) {
    if (fromStep !== undefined) {
      throw new Error(
        `Checkpoint not found at step ${String(fromStep)} for workflow "${sourceWorkflowId}"`,
      );
    }
    throw new Error(`Checkpoint not found for workflow "${sourceWorkflowId}"`);
  }
  const storedSourceCheckpoint = deserializeCheckpoint(checkpointBytes);
  return hydrateCheckpointReplayState(internals.storage, sourceWorkflowId, storedSourceCheckpoint);
}

/**
 * Validate an explicit `ForkOptions.revision` request (WFT-21) against what
 * THIS process can actually run, BEFORE `fork()` reads any checkpoint bytes
 * — a wasted storage read for a revision this process could never launch
 * anyway. Deliberately stricter than {@link canResolveRevisionLocally} for
 * an eager registration: that helper treats every eager type as always
 * resolvable regardless of the requested `revision` (correct for
 * ordinary resume/recovery, where a process only ever runs the one
 * revision it loaded, so a stale pin is harmless) — but an EXPLICIT fork
 * request naming a revision this process did NOT load must fail rather
 * than silently launching the loaded code under the requested revision's
 * name. Mirrors `pinned-schedule-revision.ts`'s identical
 * `resolvePinnedExecutableRegistration()` eager-exact-match rule, which
 * faces the same "an explicit revision commitment must not silently
 * degrade" requirement for a pinned schedule's fire-time launch.
 */
export function assertForkRevisionResolvable(
  internals: EngineInternals,
  type: string,
  revision: string,
): void {
  if (internals.registrations.has(type)) {
    if (internals.registeredCatalogRevisions.get(type) !== revision) {
      throw new WorkflowRevisionUnavailableError(type, revision, 'not-registered');
    }
    return;
  }
  if (!canResolveRevisionLocally(internals, type, revision)) {
    throw new WorkflowRevisionUnavailableError(type, revision, 'not-registered');
  }
}

/**
 * Compute the revision `fork()` resolves the new run's registration
 * against (WFT-21) — `options.revision` when supplied (after validating it
 * via {@link assertForkRevisionResolvable}), otherwise the source run's own
 * pin, unchanged from before this field existed. Extracted out of `fork()`
 * itself to keep that function's cyclomatic complexity under the
 * repository's ceiling — this single call site replaces what would
 * otherwise be two separate branches (the `??` fallback and the validation
 * `if`) inline in `fork()`.
 */
export function resolveForkTargetRevision(
  internals: EngineInternals,
  sourceState: WorkflowState,
  options: ForkOptions | undefined,
): string | undefined {
  if (options?.revision === undefined) {
    return sourceState.revision;
  }
  assertForkRevisionResolvable(internals, sourceState.type, options.revision);
  return options.revision;
}

/**
 * Compute the fork's own persisted `revision` (WFT-21): an explicit
 * `options.revision` request wins, then the source run's own pin, then
 * whatever the resolver itself resolved (the legacy-dynamic-source-with-
 * one-candidate case — see {@link createForkedWorkflowState}'s own doc for
 * why this precedence exists). Extracted out of `fork()` alongside
 * {@link resolveForkTargetRevision} to keep that function's cyclomatic
 * complexity under the repository's ceiling.
 */
export function resolveForkPersistedRevision(
  options: ForkOptions | undefined,
  sourceState: WorkflowState,
  resolvedRevision: string | undefined,
): string | undefined {
  return options?.revision ?? sourceState.revision ?? resolvedRevision;
}

/**
 * Fence the fork's own commit against a concurrent `removeWorkflowRevision()`
 * targeting the fork's persisted revision (WFT-21, Codex review round 1,
 * P1): without this, under `ownership: 'lease'`/`'workflow-lease'`, a fork
 * — ESPECIALLY an explicit-revision fork onto a revision other than the
 * source run's own, which is far more likely to be an inactive removal
 * target — performs only a process-local availability check
 * ({@link assertForkRevisionResolvable}/`canResolveRevisionLocally`) and
 * reserves no `inFlightStartsByRevision` entry, so `removeWorkflowRevision()`
 * running concurrently can observe zero references, delete the catalog
 * entry, and then this fork's own commit — racing right behind it — would
 * still land a running `WorkflowState` durably pinned to a revision the
 * catalog now claims is gone. Mirrors `start()`'s own
 * `needsCatalogEntryStartPrecondition`/`buildCatalogEntryStartPrecondition`
 * gate exactly (same ownership-mode check, same "only when a revision is
 * actually persisted" gate) — `buildCatalogEntryRevisionCondition` itself is
 * reused unchanged, since `commitFencedEngineWrite`'s `baseConditions` wants
 * the same flat `ConditionalBatchCondition`, not `start()`'s own tagged
 * multi-precondition wrapper. A `'none'` ownership mode returns no
 * condition, byte-for-byte unfenced — identical to `start()`'s own no-op
 * there. Throws `WorkflowRevisionUnavailableError('not-installed')` should
 * the entry have vanished in the narrow window since this same revision was
 * already confirmed resolvable earlier in `fork()` — a genuine loss, not a
 * false positive, and still entirely before any commit (no partial write).
 *
 * **Known residual limitation, documented rather than fixed (Codex review
 * round 8, P1):** the `'none'`-mode no-op above is safe against a
 * `removeWorkflowRevision()` that is still deciding — the in-flight
 * reservation this fork's own resolver takes (via `onRevisionChosen`,
 * round 5) makes `removeWorkflowRevision()`'s pre-delete AND post-delete
 * reference counts (`catalog-removal.ts`'s `preReferences`/`postReferences`)
 * both observe the reservation and refuse or roll back. What it is NOT safe
 * against is a `removeWorkflowRevision()` that has ALREADY finished its
 * `postReferences` check at zero and moved on to
 * `finalizeCatalogTombstone()`'s own CAS: that CAS is conditioned only on
 * the tombstone key's bytes, not on the catalog-entry key or on
 * `inFlightStartsByRevision`, and `catalog.install()` (the reinstall this
 * fork's dynamic-source resolution performs, WFT-15/16) is conditioned only
 * on the entry key, not on the tombstone. A fork whose reservation and
 * reinstall both land in that specific window — after the post-check reads
 * zero, before the tombstone CAS commits — races the tombstone finalization
 * cleanly (neither CAS touches the other's key) and the fork's own commit
 * here is genuinely unfenced under `'none'`. The result:
 * `removeWorkflowRevision()` returns `{ removed: true }` while a live,
 * referenced `WorkflowState` now durably exists against that revision.
 * Closing this needs one of two real design changes, not a bounded
 * review-response fix: either serialize `finalizeRevisionRemoval()` against
 * `inFlightStartsByRevision` reservations all the way through
 * `finalizeCatalogTombstone()` (not just at the two reference-count
 * snapshots), or make this `'none'`-mode branch return a real
 * catalog-entry-bytes condition unconditionally — reversing the round-1
 * choice that `'none'` never needs `conditionalBatch` here. Both are
 * genuine architectural decisions with real tradeoffs (a broader lock in
 * the first case; a `conditionalBatch` on every `'none'`-mode fork commit,
 * a mode chosen specifically because it does not need one, in the second) —
 * left for a follow-up rather than decided unilaterally inside a review
 * response. See the CHANGELOG and `workflow-versioning.md` for the same
 * note stated once more for readers who do not read source JSDoc.
 */
export async function buildForkCatalogEntryCondition(
  internals: EngineInternals,
  type: string,
  persistedRevision: string | undefined,
): Promise<ConditionalBatchCondition[]> {
  if (internals.options.ownershipMode === 'none' || persistedRevision === undefined) {
    return [];
  }
  return [await buildCatalogEntryRevisionCondition(internals, type, persistedRevision)];
}

/**
 * Build the error a lost `fork()` commit-time CAS race throws (WFT-21,
 * Codex review round 4, P2). A lost race on that commit is ALWAYS the
 * catalog-entry precondition (`forkCatalogEntryCondition`) — the only other
 * possible cause, a deposition, throws `EngineDeposedError` directly inside
 * `commitFencedEngineWrite` before ever reaching this factory — so whenever
 * `forkCatalogEntryCondition` was non-empty, this throws the SAME typed
 * `WorkflowRevisionUnavailableError('not-installed')` the pre-commit check
 * in `buildForkCatalogEntryCondition()` throws for the identical class of
 * loss, so `resolveForkAccess()` maps it to a `Conflict` fault instead of a
 * generic `EngineFailure`. Falls back to a generic error only in the
 * (currently unreachable, since an empty condition array cannot lose a
 * non-epoch CAS) case the condition was empty — never silently
 * misclassifying a genuinely unexpected loss as a revision conflict.
 */
export function buildForkCommitLostRaceError(
  workflowId: string,
  sourceType: string,
  persistedRevision: string | undefined,
  forkCatalogEntryCondition: ConditionalBatchCondition[],
): Error {
  if (forkCatalogEntryCondition.length > 0) {
    return new WorkflowRevisionUnavailableError(sourceType, persistedRevision, 'not-installed');
  }
  return new Error(`Fork of workflow "${workflowId}" lost its CAS race.`);
}

/**
 * A SECOND, conditional in-flight reservation for `fork()` (WFT-21, Codex
 * review round 3, P1) — closes the one gap `fork()`'s own early
 * `targetRevision` reservation cannot cover: a legacy (pre-revision-pinning)
 * source run on a dynamic-source type with exactly one registered candidate
 * has `sourceState.revision` genuinely `undefined`, so `targetRevision`
 * (`options.revision ?? sourceState.revision`) is `undefined` too and the
 * early reservation is a no-op — yet the resolver still resolves, and the
 * fork still persists against, that sole candidate's real revision
 * (`persistedRevision`). Reserves that real revision instead, but ONLY when
 * it differs from `targetRevision` (otherwise the early reservation already
 * covers it, and a second reservation would double-count the fork's own
 * in-flight reference). See `fork-revision-catalog-race.test.ts`'s round-3
 * `describe` block for the full end-to-end race this closes.
 *
 * Called from `fork()`'s `resolveExecutableRegistrationForRevision()`
 * `onRevisionChosen` hook (WFT-21, Codex review round 5, P1), not after that
 * whole resolve returns as through round 4 — the resolver's own await
 * (loading the source, when not already cached) was a window where a
 * concurrent `removeWorkflowRevision()` could delete and finalize the sole
 * candidate before a post-hoc reservation ever ran, letting a subsequent
 * shared-load reinstall paper over a removal that already reported success.
 * See `resolveExecutableRegistrationForRevision()`'s own doc for the full
 * rationale; this function's own reservation logic is unchanged. Its
 * `persistedRevision === targetRevision` guard is now defensive-only in
 * practice — the sole call site only invokes it when `targetRevision` is
 * already `undefined`, so a defined `persistedRevision` can never equal it
 * — kept rather than removed so this function's own contract still holds
 * independently of that one call site; exercised directly by a unit test.
 *
 * **Known residual limitation, documented rather than fixed (Codex review
 * round 6, P1):** this reservation is `inFlightStartsByRevision` —
 * process-local, in-memory (see `catalog-removal.ts`'s own doc) — so under
 * a supported multi-engine `ownership: 'workflow-lease'` deployment it
 * protects only a race against ANOTHER caller on THIS SAME process. A
 * SIBLING engine (a separate process sharing durable storage) can still
 * remove the sole candidate after this hook fires but before the awaited
 * source loader (`resolveWorkflowSourceForExecution()`) finishes reading
 * it — that sibling's own `removeWorkflowRevision()` sees only DURABLE
 * references, never this process's local map, so it can report success
 * while this load is still in flight; the loader's own `catalog.install()`
 * then reinstalls the revision regardless, papering over that removal.
 * `buildForkCatalogEntryCondition()` still fences the fork's own FINAL
 * commit durably under lease ownership (round 1) — this residual gap is
 * narrower: the intermediate LOAD/INSTALL step the resolver performs
 * before that commit is reached has no durable fence of its own. Closing
 * it properly needs either a durable, cross-process reservation (a
 * lease/claim analog to `inFlightStartsByRevision` itself) or a
 * tombstone-aware `catalog.install()` that refuses to resurrect a revision
 * concurrently removed — either is a genuine architectural addition, not a
 * bounded review-response fix, and warrants a follow-up rather than a
 * rushed change here. Scoped narrowly: only a legacy (pre-revision-pinning)
 * dynamic-source fork, under `workflow-lease` specifically, racing a
 * sibling engine's own concurrent removal of that exact sole candidate.
 */
export function reserveLegacyForkTargetRevision(
  internals: EngineInternals,
  type: string,
  targetRevision: string | undefined,
  persistedRevision: string | undefined,
): string | undefined {
  if (persistedRevision === targetRevision) {
    return undefined;
  }
  return reserveInFlightStart(internals, type, persistedRevision);
}

export function createForkLineage(
  _internals: EngineInternals,
  sourceWorkflowId: string,
  checkpoint: Checkpoint,
  _callbacks: LifecycleCallbacks,
): ForkLineage {
  return {
    workflowId: sourceWorkflowId,
    step: checkpoint.step,
  };
}

export function buildForkSearchAttributes(
  _internals: EngineInternals,
  checkpoint: Checkpoint,
  lineage: ForkLineage,
  _callbacks: LifecycleCallbacks,
): Record<string, SearchAttributeValue> {
  return {
    ...checkpoint.searchAttributes,
    [FORK_LINEAGE_ATTRIBUTE]: lineage.workflowId,
  };
}

export function createForkedWorkflowState(
  _internals: EngineInternals,
  workflowId: string,
  sourceState: WorkflowState,
  versionTuple: WorkflowVersionTuple,
  lineage: ForkLineage,
  forkedAt: number,
  _callbacks: LifecycleCallbacks,
  /**
   * The fork's own persisted `revision` — computed by the CALLER (`fork()`
   * in `transition.ts`), not here, as
   * `options.revision ?? sourceState.revision ?? resolvedRevision` (WFT-21).
   * Renamed from the pre-WFT-21 `resolvedRevision` parameter (which used to
   * carry only the resolver's own answer, and this function itself computed
   * `sourceState.revision ?? resolvedRevision`) so the precedence chain
   * lives in ONE place — `fork()` — rather than split across two functions,
   * now that a THIRD input (`options.revision`, an explicit diagnostic
   * opt-in) joins the chain ahead of both.
   *
   * The two lower-precedence terms preserve WFT-19 review round 6's fix
   * byte-for-byte: `sourceState.revision` wins whenever it is defined —
   * `resolveExecutableRegistrationForRevision()` ALWAYS returns
   * `revision: undefined` for an eager registration (eager has no ambiguity
   * to resolve against), even though the eager source run's own
   * `sourceState.revision` is a real, independently-meaningful value
   * (`resolveCachedStartRevision()`'s `registeredCatalogRevisions` fallback
   * stamps it at ordinary start time, for every registration kind); only a
   * legacy (pre-revision-pinning) source run on a dynamic-source type with
   * exactly one registered candidate has `sourceState.revision` genuinely
   * `undefined`, falling through to the resolver's own answer instead —
   * caught by `tests/replay-fixtures/fork-from-checkpoint.json`'s golden
   * byte comparison. Mirrors the identical fix already applied to the
   * process-local identity cache in `checkpoint-launch.ts`'s
   * `launchWorkflowFromCheckpoint()` (WFT-19 review round 5).
   */
  persistedRevision: string | undefined,
): WorkflowState {
  return {
    id: workflowId,
    type: sourceState.type,
    status: 'running',
    input: sourceState.input,
    workflowExecutionToken: crypto.randomUUID(),
    versionTuple,
    ...(persistedRevision !== undefined && { revision: persistedRevision }),
    executionStateOwnerId: workflowId,
    createdAt: forkedAt,
    startedAt: forkedAt,
    updatedAt: forkedAt,
    forkedFrom: lineage,
  };
}

export function buildForkBatchOperations(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  serializedCheckpoint: Uint8Array,
  workflowStartHeaders: Map<string, string> | undefined,
  _callbacks: LifecycleCallbacks,
): BatchOperation[] {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
    {
      type: 'put',
      key: KEYS.checkpoint(workflowId),
      value: serializedCheckpoint,
    },
    ...buildWorkflowVisibilityIndexOperations(workflowId, null, state).batchOps,
  ];

  if (Object.keys(checkpoint.searchAttributes).length > 0) {
    operations.push(
      {
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(checkpoint.searchAttributes),
      },
      ...buildIndexOperations(workflowId, {}, checkpoint.searchAttributes),
    );
  }

  if (workflowStartHeaders && workflowStartHeaders.size > 0) {
    operations.push(
      {
        type: 'put',
        key: KEYS.workflowHeaders(workflowId),
        value: encodeWorkflowStartHeaders(workflowStartHeaders),
      },
      {
        type: 'put',
        key: KEYS.terminalCleanupNeeded(workflowId),
        value: EMPTY_STORAGE_VALUE,
      },
    );
  }

  return operations;
}
