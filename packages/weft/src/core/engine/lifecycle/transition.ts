import { serializeCheckpoint } from '../../checkpoint.ts';
import { EMPTY_EVENT_HEAD } from '../../event-log.ts';
import { WorkflowRecoverySkippedEvent } from '../../events.ts';
import type { ForkOptions, WorkflowState } from '../../types.ts';
import { releaseInFlightStart, reserveInFlightStart } from '../catalog-removal.ts';
import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { resolveExecutableRegistrationOrRenamedNotFound } from '../dynamic-source-execution.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from '../errors.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import type { WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { normalizeForkStep, selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { decodeWorkflowState } from '../validation.ts';
import { launchWorkflowFromCheckpoint } from './checkpoint-launch.ts';
import {
  buildForkBatchOperations,
  buildForkCatalogEntryCondition,
  buildForkCheckpoint,
  buildForkCommitLostRaceError,
  createForkLineage,
  createForkedWorkflowState,
  loadForkSourceCheckpoint,
  reserveLegacyForkTargetRevision,
  resolveForkPersistedRevision,
  resolveForkTargetRevision,
} from './fork-helpers.ts';
import {
  assertForkSourceCheckpointMatchesState,
  assertForkSourceNotReplacedBeforeCommit,
} from './fork-source-replacement-guards.ts';
import { derivePreparedExecutionState } from './persist.ts';
import { isolateRecoveryFailure } from './recovery-isolation.ts';
import {
  buildRecoveryRevisionGroups,
  classifyRevisionGroups,
  createRecoveryScopedRevisionCallbacks,
} from './recovery-revision-groups.ts';
import { resumeWorkflowFromStorage, type FreshResumeClaimTracker } from './resume.ts';
import {
  enforceHistoryPolicyBeforeReplayById,
  loadWorkflowStartHeaders,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RecoverAllOptions,
} from './shared.ts';
import { releaseFreshlyAcquiredResumeClaim } from './standalone-claim-acquire.ts';

type MissingRecoveryWorkflow = { type: string; workflowId: string };

type RecoveryPreflightEntry =
  | { kind: 'local'; workflowId: string }
  | { kind: 'missing'; workflow: MissingRecoveryWorkflow }
  | { kind: 'recoverable'; workflowId: string; type: string; revision: string | undefined };

type RecoveryPreflightResult = {
  // Storage-scan order, preserving the interleaving callers observed before
  // the preflight refactor. Recovery iterates this list once, so the
  // returned WorkflowHandle[] is in the same order the original
  // single-pass `recoverAll` produced.
  entries: RecoveryPreflightEntry[];
  missingWorkflows: MissingRecoveryWorkflow[];
};

type RecoveryPreflightClassification = { kind: 'ignored' } | RecoveryPreflightEntry;

function isWorkflowSideRecordKey(key: string): boolean {
  return (
    key.includes(':ckpt') ||
    key.includes(':offload') ||
    key.includes(':archive') ||
    key.includes(':timeline:')
  );
}

function classifyRecoveryState(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  state: WorkflowState,
): RecoveryPreflightClassification {
  const hasLocalCheckpointOwnershipResult = callbacks.hasLocalCheckpointOwnership(
    state.id,
    state.status,
  );
  if (
    state.status === 'pending' ||
    callbacks.isInlineWorkflowLocallyOwned(state.id, state.status) ||
    hasLocalCheckpointOwnershipResult
  ) {
    return { kind: 'local', workflowId: state.id };
  }

  if (state.status !== 'running') return { kind: 'ignored' };

  // A registered-but-unresolved dynamic source is NOT "missing" —
  // `recoverAll()`'s preload barrier resolves it before any generator advances.
  if (!internals.registrations.has(state.type) && !internals.sources.byName.has(state.type)) {
    return { kind: 'missing', workflow: { type: state.type, workflowId: state.id } };
  }

  return { kind: 'recoverable', workflowId: state.id, type: state.type, revision: state.revision };
}

function appendRecoveryClassification(
  result: RecoveryPreflightResult,
  classification: RecoveryPreflightClassification,
): void {
  if (classification.kind === 'ignored') return;
  result.entries.push(classification);
  if (classification.kind === 'missing') {
    result.missingWorkflows.push(classification.workflow);
  }
}

async function preflightRecoverAll(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
): Promise<RecoveryPreflightResult> {
  const result: RecoveryPreflightResult = {
    entries: [],
    missingWorkflows: [],
  };

  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (isWorkflowSideRecordKey(key)) continue;

    appendRecoveryClassification(
      result,
      classifyRecoveryState(internals, callbacks, decodeWorkflowState(value)),
    );
  }

  return result;
}

/**
 * Resume one recoverable preflight entry, isolating the failures `recoverAll()`
 * knows how to contain to just this workflow instead of aborting the batch:
 *
 * - `RegExpExtensionDecodeError` (an undecodable checkpoint on this runtime).
 * - `VersionMismatchError`, unless `options.versionMismatchPolicy` is
 *   `'throw'`, which selects fail-fast recovery and leaves later entries in
 *   storage-scan order unresumed.
 * - `WorkflowClaimUnavailableError` (ADR 0002): another engine already holds
 *   a live, unexpired claim for this workflow under `ownership:
 *   'workflow-lease'`. `recoverAll()` is background scanning — the ADR
 *   requires it to skip a lost claim and continue recovering every OTHER
 *   workflow this engine can legitimately own, never abort the sweep or
 *   surface the error to the caller. This is the one caller-side difference
 *   from `engine.resume(id)`, which reaches the SAME `resume()` below
 *   un-isolated and lets the error propagate, per the ADR's "explicit API...
 *   throws" vs "background scanning... never thrown" asymmetry.
 *
 * Returns `null` when the failure was isolated (nothing to push onto the
 * caller's handle list); rethrows anything else, including an opted-in
 * `VersionMismatchError` throw.
 *
 * `resume()` below runs with `deferClaimReleaseOnRejection: true`: several
 * branches (`failWorkflowForXxx`) commit a `'self'`-fenced write that needs a
 * freshly-acquired claim still installed (WFT-134 review round 2, issue D —
 * releasing before this function's own handling ran left no local epoch, so
 * `commitFencedEngineWrite` threw `EngineDeposedError`, aborting recovery
 * instead of terminalizing just this run). The `finally` below releases the
 * tracked epoch AFTER every branch has had its chance, mirroring the release
 * an explicit `engine.resume()` gets immediately.
 */
async function recoverEntryOrIsolateFailure(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks,
  options: RecoverAllOptions | undefined,
): Promise<WorkflowHandle | null> {
  const freshClaimTracker: FreshResumeClaimTracker = { epoch: null };
  try {
    return await resume(internals, workflowId, callbacks, options?.onRecoveredWorkflow, {
      deferClaimReleaseOnRejection: true,
      freshClaimTracker,
    });
  } catch (error) {
    try {
      return await isolateRecoveryFailure(workflowId, callbacks, options, error);
    } finally {
      if (freshClaimTracker.epoch !== null) {
        await releaseFreshlyAcquiredResumeClaim(internals, workflowId, freshClaimTracker.epoch);
      }
    }
  }
}

export async function recoverAll(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  options?: RecoverAllOptions,
): Promise<WorkflowHandle[]> {
  const preflight = await preflightRecoverAll(internals, callbacks);
  const handles: WorkflowHandle[] = [];

  if (preflight.missingWorkflows.length > 0 && options?.acknowledgeUnknownWorkflowTypes !== true) {
    // A dynamic source registered but never yet resolved is still a
    // "registered type" as far as an operator reading this error is
    // concerned — `classifyRecoveryState` above already treats it as
    // non-missing; this list must agree, or a mixed recovery batch reports
    // every registered lazy type as unregistered.
    throw new WorkflowTypeNotRegisteredForRecoveryError({
      registeredTypes: new Set([
        ...internals.registrations.keys(),
        ...internals.sources.byName.keys(),
      ]),
      missingWorkflows: preflight.missingWorkflows,
    });
  }

  const recoverableEntries = preflight.entries.filter(
    (entry): entry is Extract<RecoveryPreflightEntry, { kind: 'recoverable' }> =>
      entry.kind === 'recoverable',
  );
  const revisionGroups = buildRecoveryRevisionGroups(recoverableEntries);
  const revisionClassifications = await classifyRevisionGroups(
    internals,
    callbacks,
    revisionGroups,
  );

  // Wrap `callbacks` so THIS batch's per-entry `resume()` calls below see
  // the barrier's failures via a closure-local `Map`, never a field on
  // shared `internals` — a concurrent, unrelated `engine.start()`,
  // `engine.resume()`, or a second concurrent `recoverAll()` batch keeps
  // using the real, un-wrapped `callbacks.resolveExecutableRegistrationForRevision`
  // and can never observe (or race the reset of) this batch's
  // classification. See `createRecoveryScopedRevisionCallbacks()`. A
  // `recoverable` entry whose group failed still goes through
  // `recoverEntryOrIsolateFailure` -> `resume()` below like every other
  // entry, so it gets the SAME claim-acquisition and
  // terminal-cleanup-tracking sequence a version-mismatch failure gets,
  // instead of calling `failWorkflowForRevisionUnavailable` directly ahead
  // of that sequence.
  const recoveryScopedCallbacks = createRecoveryScopedRevisionCallbacks(
    callbacks,
    revisionClassifications,
  );

  // Walk preflight entries in storage-scan order so the returned handle
  // list matches the interleaving callers observed before the preflight
  // refactor (locals, missing, and recoverables stay in scan order).
  for (const entry of preflight.entries) {
    if (entry.kind === 'local') {
      handles.push(callbacks.getHandle(entry.workflowId));
      continue;
    }
    if (entry.kind === 'missing') {
      callbacks.dispatchEvent(
        new WorkflowRecoverySkippedEvent(
          entry.workflow.workflowId,
          entry.workflow.type,
          'type-not-registered',
        ),
      );
      continue;
    }
    const handle = await recoverEntryOrIsolateFailure(
      internals,
      entry.workflowId,
      recoveryScopedCallbacks,
      options,
    );
    if (handle !== null) {
      handles.push(handle);
    }
  }

  return handles;
}

/** Options for {@link resume}. */
export type ResumeOptions = {
  /**
   * Skip the local-ownership fast path and always replay from durable storage.
   *
   * Required by ADR 0002 reclaim-driven resume: deposition drops only the
   * registry's claim entry, so local checkpoints, parked markers, contexts and
   * generators survive. Without this, a reclaim by the same engine returns the
   * pre-deposition handle without reaching `resumeWorkflowFromStorage()` and
   * renews a run that never restarted from durable state. Ordinary
   * `engine.resume()` leaves it `false` — nothing was deposed there.
   */
  readonly forceReplayFromStorage?: boolean;
  /**
   * Forwarded to `resumeWorkflowFromStorage()`'s matching options — see
   * `ResumeFromStorageOptions` (WFT-134 issue D). Set by
   * `recoverEntryOrIsolateFailure` only; unset for the local-ownership fast
   * path above, which never reaches that function.
   */
  readonly deferClaimReleaseOnRejection?: boolean;
  readonly freshClaimTracker?: FreshResumeClaimTracker;
};

export async function resume(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'],
  options?: ResumeOptions,
): Promise<WorkflowHandle> {
  const workflowState = await loadWorkflowState(internals, workflowId);
  if (workflowState !== null && options?.forceReplayFromStorage !== true) {
    const locallyOwned =
      callbacks.isInlineWorkflowLocallyOwned(workflowId, workflowState.status) ||
      callbacks.hasLocalCheckpointOwnership(workflowId, workflowState.status);
    if (locallyOwned) {
      // The local-ownership paths return without reaching
      // `resumeWorkflowFromStorage`, where the pre-replay history guard lives.
      // Run the guard here so a locally-owned workflow left `running` with an
      // oversized history (e.g. after a write-path termination failure on this
      // same engine instance) is still reaped on resume. Only the owned paths
      // need this — the non-owned path below delegates to
      // `resumeWorkflowFromStorage`, which guards using the head it already
      // loads, so we avoid a duplicate event-log head read on the hot path.
      await enforceHistoryPolicyBeforeReplayById(internals, workflowId, callbacks);
      return callbacks.getHandle(workflowId);
    }
  }

  return resumeWorkflowFromStorage(internals, workflowId, true, callbacks, onRecoveredWorkflow, {
    ...(options?.deferClaimReleaseOnRejection !== undefined && {
      deferClaimReleaseOnRejection: options.deferClaimReleaseOnRejection,
    }),
    ...(options?.freshClaimTracker !== undefined && {
      freshClaimTracker: options.freshClaimTracker,
    }),
  });
}

export async function fork(
  internals: EngineInternals,
  sourceWorkflowId: string,
  options: ForkOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  const sourceState = await loadWorkflowState(internals, sourceWorkflowId);
  if (!sourceState) {
    throw new Error(`Workflow "${sourceWorkflowId}" not found`);
  }

  // Resolve against the SOURCE run's own exact pinned revision (WFT-17's
  // `WorkflowState.revision`), never the catalog's active pointer (WFT-19
  // review round 2): the active pointer can move between the source run's
  // start and this fork call, and resolving via it would launch the forked
  // run against the wrong code from the first turn. `options.revision`
  // (WFT-21) opts into a different installed revision explicitly — see
  // `resolveForkTargetRevision()`'s doc.
  const targetRevision = resolveForkTargetRevision(internals, sourceState, options);
  // Reserve an in-flight-start slot against `targetRevision` before any
  // further async work (WFT-21, Codex review round 2, P1): closes the
  // same-process race a concurrent `removeWorkflowRevision()` could win
  // between this validation and the fork's own commit, in any ownership
  // mode — unlike `buildForkCatalogEntryCondition()` below (durable,
  // cross-process fencing only under lease modes). Mirrors `start()`'s
  // `reserveInFlightStart`/`releaseInFlightStart` pairing; released in
  // this function's own outer `finally` below.
  const inFlightRevision = reserveInFlightStart(internals, sourceState.type, targetRevision);
  // Reserved via `onRevisionChosen` below, synchronously (WFT-21, Codex
  // review round 5, P1) — see `reserveLegacyForkTargetRevision()`'s doc.
  let legacyResolvedInFlightRevision: string | undefined;
  try {
    // `revision` here is the resolver's OWN resolved revision — threaded
    // through to `launchWorkflowFromCheckpoint()`'s identity-cache population
    // below, NOT re-derived from `forkState.revision` (which is `undefined`
    // for a legacy record even when this resolve found a real sole
    // candidate — see that call site's doc, WFT-19 review round 5).
    const { entry: registration, revision: resolvedRevision } =
      await resolveExecutableRegistrationOrRenamedNotFound(
        (type) =>
          callbacks.resolveExecutableRegistrationForRevision(type, targetRevision, (chosen) => {
            legacyResolvedInFlightRevision = reserveLegacyForkTargetRevision(
              internals,
              sourceState.type,
              inFlightRevision,
              chosen,
            );
          }),
        sourceState.type,
        () =>
          new Error(
            `No workflow registered with name "${sourceState.type}" (needed to fork "${sourceWorkflowId}")`,
          ),
      );
    // The fork's own persisted `revision` — see `resolveForkPersistedRevision()`'s
    // doc. Always equals `chosen` above when the hook fired, so no double-reserve.
    const persistedRevision = resolveForkPersistedRevision(options, sourceState, resolvedRevision);

    const fromStep =
      options?.fromStep !== undefined ? normalizeForkStep(options.fromStep) : undefined;
    const sourceCheckpoint = await loadForkSourceCheckpoint(internals, sourceWorkflowId, fromStep);
    // See this function's own doc (WFT-21, Codex review, item 6).
    assertForkSourceCheckpointMatchesState(sourceWorkflowId, sourceState, sourceCheckpoint);
    const preparedExecutionState = derivePreparedExecutionState(
      internals,
      sourceWorkflowId,
      sourceState,
      sourceCheckpoint,
      registration,
      callbacks,
    );
    const sourceWorkflowHeaders =
      internals.workflowHeaders.get(sourceWorkflowId) ??
      (await loadWorkflowStartHeaders(internals, sourceWorkflowId, callbacks));
    const persistedWorkflowStartHeaders =
      selectPersistedWorkflowStartHeaders(sourceWorkflowHeaders);

    const workflowId = crypto.randomUUID();
    const forkedAt = internals.options.getNow();
    const lineage = createForkLineage(internals, sourceWorkflowId, sourceCheckpoint, callbacks);
    const forkState = createForkedWorkflowState(
      internals,
      workflowId,
      preparedExecutionState.state,
      preparedExecutionState.versionTuple,
      lineage,
      forkedAt,
      callbacks,
      persistedRevision,
    );
    const forkCheckpoint = buildForkCheckpoint(
      internals,
      workflowId,
      forkedAt,
      preparedExecutionState.checkpoint,
      forkState,
      lineage,
      callbacks,
    );

    // Fences the commit below against a concurrent removeWorkflowRevision()
    // (WFT-21 round 1, P1) — see `buildForkCatalogEntryCondition()`'s doc.
    const forkCatalogEntryCondition = await buildForkCatalogEntryCondition(
      internals,
      sourceState.type,
      persistedRevision,
    );

    // See this function's own doc (WFT-21, Codex review, item 6).
    await assertForkSourceNotReplacedBeforeCommit(internals, sourceWorkflowId, sourceState);
    let forkStarted = false;
    try {
      const forkCheckpointBytes = serializeCheckpoint(forkCheckpoint);
      // Fork plants a new workflow run from an existing checkpoint — engine-generated
      // workflow state. Fence it on the lease epoch (issue #470 Step 2) so a deposed
      // engine cannot create a phantom forked run in the successor's store.
      await commitFencedEngineWrite(
        internals,
        workflowId,
        buildForkBatchOperations(
          internals,
          workflowId,
          forkState,
          forkCheckpoint,
          forkCheckpointBytes,
          persistedWorkflowStartHeaders,
          callbacks,
        ),
        forkCatalogEntryCondition,
        () =>
          buildForkCommitLostRaceError(
            workflowId,
            sourceState.type,
            persistedRevision,
            forkCatalogEntryCondition,
          ),
      );
      internals.eventLogHeads.set(workflowId, EMPTY_EVENT_HEAD);
      setWorkflowStartHeaders(internals, workflowId, persistedWorkflowStartHeaders, callbacks);
      const handle = launchWorkflowFromCheckpoint(
        internals,
        workflowId,
        forkState,
        forkCheckpoint,
        registration,
        resolvedRevision,
        callbacks,
      );
      forkStarted = true;
      return handle;
    } finally {
      if (!forkStarted) {
        forgetCommittedCheckpointBytes(internals, workflowId);
        internals.checkpoints.delete(workflowId);
        internals.workflowVersionTuples.delete(workflowId);
        internals.eventLogHeads.delete(workflowId);
        internals.workflowHeaders.delete(workflowId);
      }
    }
  } finally {
    releaseInFlightStart(internals, sourceState.type, inFlightRevision);
    releaseInFlightStart(internals, sourceState.type, legacyResolvedInFlightRevision);
  }
}
