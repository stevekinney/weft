import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import { Context } from '../../context.ts';
import { EMPTY_EVENT_HEAD } from '../../event-log.ts';
import { WorkflowRecoverySkippedEvent, WorkflowStartedEvent } from '../../events.ts';
import { buildIndexOperations } from '../../search-attributes.ts';
import type {
  Checkpoint,
  ForkLineage,
  ForkOptions,
  SearchAttributeValue,
  WorkflowState,
} from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from '../errors.ts';
import { getWorkflowExecutionStartedAt, type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import {
  encodeWorkflowStartHeaders,
  normalizeForkStep,
  selectPersistedWorkflowStartHeaders,
} from '../state-utilities.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { decodeWorkflowState } from '../validation.ts';
import { buildWorkflowVisibilityIndexOperations } from '../workflow-indexes.ts';
import { createWorkflowVersionTuple, derivePreparedExecutionState } from './persist.ts';
import { resumeWorkflowFromStorage } from './resume.ts';
import {
  EMPTY_STORAGE_VALUE,
  FORK_LINEAGE_ATTRIBUTE,
  createWorkflowHandle,
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
    handles.push(await resume(internals, entry.workflowId, callbacks));
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
    if (callbacks.isInlineWorkflowLocallyOwned(workflowId, workflowState.status)) {
      return callbacks.getHandle(workflowId);
    }

    if (callbacks.hasLocalCheckpointOwnership(workflowId, workflowState.status)) {
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

  const sourceCheckpoint = deserializeCheckpoint(checkpointBytes);
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
  const forkCheckpoint: Checkpoint = {
    ...preparedExecutionState.checkpoint,
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
    await internals.storage.batch(
      buildForkBatchOperations(
        internals,
        workflowId,
        forkState,
        forkCheckpoint,
        persistedWorkflowStartHeaders,
        callbacks,
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
      callbacks,
    );
    forkStarted = true;
    return handle;
  } finally {
    if (!forkStarted) {
      internals.checkpoints.delete(workflowId);
      internals.workflowVersionTuples.delete(workflowId);
      internals.eventLogHeads.delete(workflowId);
      internals.workflowHeaders.delete(workflowId);
    }
  }
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
): WorkflowState {
  return {
    id: workflowId,
    type: sourceState.type,
    status: 'running',
    input: sourceState.input,
    version: versionTuple.workflowVersion,
    executionStateOwnerId: workflowId,
    createdAt: forkedAt,
    startedAt: forkedAt,
    updatedAt: forkedAt,
    ...(versionTuple.agentVersion !== undefined && {
      agentVersion: versionTuple.agentVersion,
    }),
    ...(versionTuple.toolVersions !== undefined && {
      toolVersions: versionTuple.toolVersions,
    }),
    forkedFrom: lineage,
  };
}

export function buildForkBatchOperations(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  workflowStartHeaders: Map<string, string> | undefined,
  _callbacks: LifecycleCallbacks,
): BatchOperation[] {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
    {
      type: 'put',
      key: KEYS.checkpoint(workflowId),
      value: serializeCheckpoint(checkpoint),
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

  const context = new Context({
    workflowId,
    workflowType: state.type,
    startedAt: getWorkflowExecutionStartedAt(state),
    abortController: workflowAbort,
    getNow: internals.options.getNow,
    resolveWorkflowType: callbacks.resolveWorkflowTypeTarget,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    accumulatedResults,
    searchAttributes: checkpoint.searchAttributes,
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    sleepReferenceTime: checkpoint.createdAt,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
  });

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
