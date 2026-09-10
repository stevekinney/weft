import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../../checkpoint.ts';
import { RegExpExtensionDecodeError } from '../../codec/extension-codec.ts';
import { EMPTY_EVENT_HEAD } from '../../event-log.ts';
import { WorkflowRecoverySkippedEvent } from '../../events.ts';
import type { Checkpoint, ForkOptions, WorkflowState } from '../../types.ts';
import { VersionMismatchError } from '../../versioning.ts';
import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { hydrateCheckpointReplayState } from '../checkpoint-replay.ts';
import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import { resolveExecutableRegistrationOrRenamedNotFound } from '../dynamic-source-execution.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from '../errors.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import type { WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { WorkflowClaimUnavailableError } from '../lease-errors.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import { normalizeForkStep, selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { decodeWorkflowState } from '../validation.ts';
import { launchWorkflowFromCheckpoint } from './checkpoint-launch.ts';
import {
  buildForkBatchOperations,
  buildForkSearchAttributes,
  createForkLineage,
  createForkedWorkflowState,
  resolveForkPersistedRevision,
  resolveForkTargetRevision,
} from './fork-helpers.ts';
import { derivePreparedExecutionState } from './persist.ts';
import {
  buildRecoveryRevisionGroups,
  classifyRevisionGroups,
  createRecoveryScopedRevisionCallbacks,
} from './recovery-revision-groups.ts';
import { resumeWorkflowFromStorage } from './resume.ts';
import {
  enforceHistoryPolicyBeforeReplayById,
  loadWorkflowStartHeaders,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RecoverAllOptions,
} from './shared.ts';

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
 *   un-isolated and lets the error propagate, per the ADR's explicit
 *   "explicit, single-workflow public API... throws" vs "background
 *   scanning... never thrown" asymmetry.
 *
 * Returns `null` when the failure was isolated (nothing to push onto the
 * caller's handle list); rethrows anything else, including an opted-in
 * `VersionMismatchError` throw.
 */
async function recoverEntryOrIsolateFailure(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks,
  options: RecoverAllOptions | undefined,
): Promise<WorkflowHandle | null> {
  try {
    return await resume(internals, workflowId, callbacks, options?.onRecoveredWorkflow);
  } catch (error) {
    if (error instanceof RegExpExtensionDecodeError) {
      await callbacks.failWorkflowForCheckpointDecodeError(workflowId, error);
      return null;
    }
    if (error instanceof VersionMismatchError && options?.versionMismatchPolicy !== 'throw') {
      await callbacks.failWorkflowForVersionMismatch(workflowId, error);
      return null;
    }
    if (error instanceof WorkflowClaimUnavailableError) {
      return null;
    }
    if (error instanceof WorkflowRevisionUnavailableError) {
      // `recoverAll()`'s preload barrier classified this entry's
      // `(type, revision)` group `unavailable` before the loop started;
      // `resume()` reached this exact cached error via the batch-local,
      // closure-scoped `resolveExecutableRegistrationForRevision()` wrapper
      // `createRecoveryScopedRevisionCallbacks()` builds below, AFTER
      // acquiring this workflow's claim and loading its terminal-cleanup
      // tracking — the same ordering `VersionMismatchError` gets — so
      // `failWorkflowForRevisionUnavailable` below commits cleanly under
      // `ownership: 'workflow-lease'` instead of racing an unfenced write.
      await callbacks.failWorkflowForRevisionUnavailable(workflowId, error);
      return null;
    }
    if (error instanceof DynamicWorkflowSourceUnavailableError) {
      // A legacy (revision-undefined) run on a dynamic source with a single
      // registered candidate falls through to the ordinary active-pointer
      // resolve inside `resolveExecutableRegistrationForRevision()`, which
      // can still fail with THIS error (a load failure, or an
      // ambiguous-revision race against a concurrent removal) rather than
      // `WorkflowRevisionUnavailableError` — isolate it the same way.
      await callbacks.failWorkflowForUnavailableDynamicSource(workflowId, error);
      return null;
    }
    throw error;
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

  return resumeWorkflowFromStorage(internals, workflowId, true, callbacks, onRecoveredWorkflow);
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
  // `WorkflowState.revision`), never the catalog's currently active pointer
  // (WFT-19 review round 2, found while proving the identity-cache fix
  // below): the active pointer can move between the source run's start and
  // this fork call, and resolving via `resolveExecutableRegistration`
  // (active-pointer-based) would launch the FORKED run against a different
  // revision's handler entirely — not just a routing mismatch downstream of
  // execution, but the wrong code running from the very first turn. Mirrors
  // `resolveExecutableRegistrationForRetry()`'s identical fix for bulk retry.
  //
  // `options.revision` (WFT-21) is an explicit, validated opt-in to fork
  // against a DIFFERENT installed revision than the source run's own pin —
  // validated BEFORE the checkpoint is ever read, so an unresolvable
  // request fails fast with no partial write. When absent, `targetRevision`
  // is exactly `sourceState.revision`, preserving this fork's pre-WFT-21
  // behavior byte-for-byte. See `resolveForkTargetRevision()`'s own doc for
  // why this is extracted rather than inlined here.
  const targetRevision = resolveForkTargetRevision(internals, sourceState, options);
  // `revision` here is the resolver's OWN resolved revision — threaded
  // through to `launchWorkflowFromCheckpoint()`'s identity-cache population
  // below, NOT re-derived from `forkState.revision` (which is `undefined`
  // for a legacy record even when this resolve found a real sole
  // candidate — see that call site's doc, WFT-19 review round 5).
  const { entry: registration, revision: resolvedRevision } =
    await resolveExecutableRegistrationOrRenamedNotFound(
      (type) => callbacks.resolveExecutableRegistrationForRevision(type, targetRevision),
      sourceState.type,
      () =>
        new Error(
          `No workflow registered with name "${sourceState.type}" (needed to fork "${sourceWorkflowId}")`,
        ),
    );
  // The fork's own persisted `revision` (WFT-21) — see
  // `resolveForkPersistedRevision()`'s own doc for the precedence chain.
  const persistedRevision = resolveForkPersistedRevision(options, sourceState, resolvedRevision);

  const fromStep =
    options?.fromStep !== undefined ? normalizeForkStep(options.fromStep) : undefined;
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
  const sourceCheckpoint = await hydrateCheckpointReplayState(
    internals.storage,
    sourceWorkflowId,
    storedSourceCheckpoint,
  );
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
  const persistedWorkflowStartHeaders = selectPersistedWorkflowStartHeaders(sourceWorkflowHeaders);

  const workflowId = crypto.randomUUID();
  const forkedAt = internals.options.getNow();
  const lineage = createForkLineage(internals, sourceWorkflowId, sourceCheckpoint, callbacks);
  const { accumulatedResultReplayWatermark: _sourceReplayWatermark, ...sourceCheckpointForFork } =
    preparedExecutionState.checkpoint;
  const forkCheckpoint: Checkpoint = {
    ...sourceCheckpointForFork,
    createdAt: forkedAt,
    workflowId,
    searchAttributes: buildForkSearchAttributes(
      internals,
      preparedExecutionState.checkpoint,
      lineage,
      callbacks,
    ),
  };
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
      [],
      () => new Error(`Fork of workflow "${workflowId}" lost its CAS race.`),
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
}
