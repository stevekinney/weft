import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../../checkpoint.ts';
import { RegExpExtensionDecodeError } from '../../codec/extension-codec.ts';
import { Context, setContextWorkflowInterceptor } from '../../context.ts';
import { EMPTY_EVENT_HEAD } from '../../event-log.ts';
import { WorkflowRecoverySkippedEvent, WorkflowStartedEvent } from '../../events.ts';
import type { Checkpoint, ForkOptions, WorkflowState } from '../../types.ts';
import { createCancelHandlerRegistration, resetCancelHandlers } from '../cancel-handlers.ts';
import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { hydrateCheckpointReplayState } from '../checkpoint-replay.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from '../errors.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import { getWorkflowExecutionStartedAt, type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { normalizeForkStep, selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { getComposedWorkflowInterceptor } from '../strategy-helpers.ts';
import { decodeWorkflowState } from '../validation.ts';
import {
  buildForkBatchOperations,
  buildForkSearchAttributes,
  createForkLineage,
  createForkedWorkflowState,
} from './fork-helpers.ts';
import { createWorkflowVersionTuple, derivePreparedExecutionState } from './persist.ts';
import { resumeWorkflowFromStorage } from './resume.ts';
import {
  createWorkflowHandle,
  enforceHistoryPolicyBeforeReplayById,
  loadWorkflowStartHeaders,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RecoverAllOptions,
  type RegistrationEntry,
} from './shared.ts';

type MissingRecoveryWorkflow = { type: string; workflowId: string };

type RecoveryPreflightEntry =
  | { kind: 'local'; workflowId: string }
  | { kind: 'missing'; workflow: MissingRecoveryWorkflow }
  | { kind: 'recoverable'; workflowId: string };

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

  if (!internals.registrations.has(state.type)) {
    return { kind: 'missing', workflow: { type: state.type, workflowId: state.id } };
  }

  return { kind: 'recoverable', workflowId: state.id };
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

export async function recoverAll(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  options?: RecoverAllOptions,
): Promise<WorkflowHandle[]> {
  const preflight = await preflightRecoverAll(internals, callbacks);
  const handles: WorkflowHandle[] = [];

  if (preflight.missingWorkflows.length > 0 && options?.acknowledgeUnknownWorkflowTypes !== true) {
    throw new WorkflowTypeNotRegisteredForRecoveryError({
      registeredTypes: internals.registrations.keys(),
      missingWorkflows: preflight.missingWorkflows,
    });
  }

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
    try {
      handles.push(await resume(internals, entry.workflowId, callbacks));
    } catch (error) {
      if (error instanceof RegExpExtensionDecodeError) {
        await callbacks.failWorkflowForCheckpointDecodeError(entry.workflowId, error);
        continue;
      }
      throw error;
    }
  }

  return handles;
}

export async function resume(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  const workflowState = await loadWorkflowState(internals, workflowId);
  if (workflowState !== null) {
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

  return resumeWorkflowFromStorage(internals, workflowId, true, callbacks);
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

  const registration = internals.registrations.get(sourceState.type);
  if (!registration) {
    throw new Error(
      `No workflow registered with name "${sourceState.type}" (needed to fork "${sourceWorkflowId}")`,
    );
  }

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
  );

  let forkStarted = false;
  try {
    const forkCheckpointBytes = serializeCheckpoint(forkCheckpoint);
    // Fork plants a new workflow run from an existing checkpoint — engine-generated
    // workflow state. Fence it on the lease epoch (issue #470 Step 2) so a deposed
    // engine cannot create a phantom forked run in the successor's store.
    await commitFencedEngineWrite(
      internals,
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

function launchInlineWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): void {
  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('Inline workflow launch requested without an inline strategy.');
  }

  const accumulatedResults = new Map<number, unknown>(checkpoint.accumulatedResults);
  const workflowAbort = new AbortController();

  resetCancelHandlers(internals, workflowId);
  const context = new Context({
    workflowId,
    ...(state.workflowExecutionToken !== undefined && {
      workflowExecutionToken: state.workflowExecutionToken,
    }),
    workflowType: state.type,
    startedAt: getWorkflowExecutionStartedAt(state),
    abortController: workflowAbort,
    getNow: internals.options.getNow,
    resolveWorkflowType: callbacks.resolveWorkflowTypeTarget,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    accumulatedResults,
    searchAttributes: checkpoint.searchAttributes,
    registerCancelHandler: createCancelHandlerRegistration(internals, workflowId),
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    sleepReferenceTime: checkpoint.createdAt,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    // Carry the host `ctx.log` sink onto the checkpoint-launched context, mirroring the
    // fresh-start and resume paths. This path runs for forked / launch-from-checkpoint
    // runs; without the sink, a log at the forked run's live frontier (and any
    // speculative child it parents) reaches the console but never `EngineOptions.onLog`.
    // Construction normalizes a missing `onLog` to `null`; use loose `!= null` so the
    // narrowed type drops both `null` and the option's declared `undefined`, keeping
    // `logSink` assignable under `exactOptionalPropertyTypes` (build's stricter tsc) (#549).
    ...(internals.options.onLog != null && { logSink: internals.options.onLog }),
  });
  setContextWorkflowInterceptor(context, getComposedWorkflowInterceptor(internals));

  if (internals.options.development) {
    context.explain(true);
  }

  const generator = registration.handler(context, state.input);
  inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);
  inlineStrategy.continueWorkflow(workflowId, undefined);
  void callbacks.swallowPromiseRejection(
    callbacks.processPendingUpdatesAfterInlineAdvance(workflowId),
  );
}

function launchWorkerWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
): void {
  const serialized = serializeCheckpoint(checkpoint);
  internals.strategy.startWorkflow({
    workflowId,
    ...(state.workflowExecutionToken !== undefined && {
      workflowExecutionToken: state.workflowExecutionToken,
    }),
    workflowType: state.type,
    input: state.input,
    checkpoint: serialized,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    ...(internals.workflowHeaders.has(workflowId) && {
      headers: [...internals.workflowHeaders.get(workflowId)!],
    }),
  });
}

export function launchWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): WorkflowHandle {
  // Store checkpoint for future persistence
  internals.checkpoints.set(workflowId, checkpoint);
  internals.workflowVersionTuples.set(
    workflowId,
    createWorkflowVersionTuple(internals, registration, callbacks),
  );

  const handle = createWorkflowHandle(internals, workflowId, callbacks);
  callbacks.dispatchEvent(new WorkflowStartedEvent(workflowId, state.type, state.input));

  if (internals.inlineStrategy) {
    launchInlineWorkflowFromCheckpoint(
      internals,
      workflowId,
      state,
      checkpoint,
      registration,
      callbacks,
    );
  } else {
    launchWorkerWorkflowFromCheckpoint(internals, workflowId, state, checkpoint);
  }

  return handle;
}
