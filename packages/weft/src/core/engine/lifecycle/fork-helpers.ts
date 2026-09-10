import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { buildIndexOperations } from '../../search-attributes.ts';
import type { Checkpoint, ForkLineage, SearchAttributeValue, WorkflowState } from '../../types.ts';
import type { ForkOptions } from '../../types/options.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { canResolveRevisionLocally } from '../dynamic-source-execution.ts';
import type { EngineInternals } from '../internals.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import { encodeWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowVisibilityIndexOperations } from '../workflow-indexes.ts';
import { EMPTY_STORAGE_VALUE, FORK_LINEAGE_ATTRIBUTE, type LifecycleCallbacks } from './shared.ts';
import { buildCatalogEntryRevisionCondition } from './start-commit.ts';

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
