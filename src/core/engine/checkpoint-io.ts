import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  advanceCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from '../checkpoint.ts';
import { encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { hasPendingAttributeChanges } from '../context/context-presence.ts';
import { EMPTY_EVENT_HEAD, EventLog } from '../event-log.ts';
import {
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
} from '../events.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type { SearchAttributeValue, WorkflowTimelineEntry } from '../types.ts';
import {
  getCommittedCheckpointBytes,
  rememberCommittedCheckpointBytes,
} from './checkpoint-commit-snapshots.ts';
import {
  attachTransientCheckpointReplayPayload,
  createCheckpointEventPayload,
  mergeCheckpointReplayPayloads,
  pruneCheckpointReplayState,
  readCheckpointReplayPayload,
  type CheckpointReplayPayload,
} from './checkpoint-replay.ts';
import {
  clearPendingAtomicWorkflowCommitSideEffects,
  takePendingAtomicWorkflowCommitSideEffects,
  type AtomicWorkflowCommitSideEffects,
} from './checkpoint-side-effects.ts';
import {
  appendCompactionOperations,
  serializeDeletedEntries,
  type CompactionResult,
} from './event-log-compaction.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { getTimelineInputSummary, getTimelineOperationLabel } from './state-utilities.ts';
import { buildPendingTimelineOperation } from './termination.ts';
import { notifyWorkflowFeedCommit } from './workflow-feed.ts';

type PendingTimelineEntryValue = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
};

export type PersistCheckpointOptions = {
  timeline?: 'record-operation' | 'preserve-pending';
};

type PersistCheckpointCallbacks = {
  appendTimelineBatchOperations: (
    workflowId: string,
    operation: ContextOperationRequest,
    step: number,
    timestamp: number,
    operations: BatchOperation[],
  ) => PendingTimelineEntryValue;
  swallowPromiseRejection: (promise: Promise<void>) => void;
  validateAttributeValueSizes: (attributes: Record<string, SearchAttributeValue>) => void;
  pruneCheckpointHistory: (workflowId: string, step: number) => Promise<void>;
  dispatchEvent: (event: Event) => void;
  /**
   * Force the workflow to a terminal `timed-out` state because its event-log
   * record count breached the configured history circuit-breaker threshold.
   * Awaited synchronously on the commit path so no further checkpoint can be
   * written after the breaching one; a rejection propagates out of
   * {@link commitCheckpoint} (the checkpoint has already committed durably).
   */
  enforceHistoryCircuitBreaker: (workflowId: string) => Promise<void>;
};

type DevelopmentCheckpointCallbacks = {
  dispatchEvent: (event: Event) => void;
};

export function appendTimelineBatchOperations(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  step: number,
  timestamp: number,
  operations: BatchOperation[],
): PendingTimelineEntryValue {
  const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
  const versionTuple = internals.workflowVersionTuples.get(workflowId);

  if (pendingTimelineOperation) {
    operations.push(pendingTimelineOperation);
  }

  const entry: WorkflowTimelineEntry = {
    step,
    operationType: operation.type,
    operationLabel: getTimelineOperationLabel(operation),
    inputSummary: getTimelineInputSummary(operation),
    timestamp,
    status: 'running',
    ...(versionTuple ? { versionTuple } : {}),
  };

  operations.push({
    type: 'put',
    key: KEYS.timeline(workflowId, step),
    value: encode(entry),
  });

  return {
    startedAt: timestamp,
    entry,
  };
}

type CheckpointCommit = {
  checkpoint: CheckpointStateForCommit;
  serialized: Uint8Array;
  replayPayload?: CheckpointReplayPayload;
  expectedSerialized?: Uint8Array;
  step: number;
  timestamp: number;
  operations: BatchOperation[];
};

type CheckpointStateForCommit = ReturnType<typeof deserializeCheckpoint>;

/** Persist a workflow checkpoint, history entry, timeline record, and event log record. */
export async function persistCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  workerCheckpointBytes: ArrayBuffer | undefined,
  callbacks: PersistCheckpointCallbacks,
  options: PersistCheckpointOptions = {},
): Promise<void> {
  const context = internals.inlineStrategy?.getContext(workflowId);

  if (context) {
    await persistInlineCheckpoint(internals, workflowId, operation, callbacks, options);
  } else if (workerCheckpointBytes && workerCheckpointBytes.byteLength > 0) {
    await persistWorkerCheckpoint(
      internals,
      workflowId,
      operation,
      workerCheckpointBytes,
      callbacks,
      options,
    );
  }
}

async function persistInlineCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  callbacks: PersistCheckpointCallbacks,
  options: PersistCheckpointOptions,
): Promise<void> {
  const current = internals.checkpoints.get(workflowId);
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!current || !context) return;

  const previousAttributes = { ...current.searchAttributes };
  const pendingAttributeChanges = context.checkpointPendingAttributeChanges;
  const hasPendingAttributeChangesValue = hasPendingAttributeChanges(context);
  const advanced = advanceCheckpoint(current, context.checkpointLocals, {
    accumulatedResults: context.checkpointAccumulatedResults,
    now: internals.options.getNow(),
    ...(pendingAttributeChanges !== undefined ? { searchAttributes: pendingAttributeChanges } : {}),
  });
  const pruned = pruneCheckpointReplayState(
    advanced,
    resolvePendingOperationStep(operation, context.stepIndex),
  );
  const commit = createCheckpointCommit(
    internals,
    workflowId,
    pruned.checkpoint,
    serializeCheckpoint(
      attachTransientCheckpointReplayPayload(pruned.checkpoint, pruned.replayPayload),
    ),
    pruned.replayPayload,
  );
  appendAttributeOperations(
    workflowId,
    commit,
    previousAttributes,
    pendingAttributeChanges,
    hasPendingAttributeChangesValue,
    callbacks,
  );
  await commitCheckpoint(internals, workflowId, operation, commit, callbacks, options);
  if (hasPendingAttributeChangesValue) {
    callbacks.dispatchEvent(new AttributesChangedEvent(workflowId, { ...pendingAttributeChanges }));
  }
}

async function persistWorkerCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  workerCheckpointBytes: ArrayBuffer,
  callbacks: PersistCheckpointCallbacks,
  options: PersistCheckpointOptions,
): Promise<void> {
  const serialized = new Uint8Array(workerCheckpointBytes);
  const checkpoint = deserializeCheckpoint(serialized);
  const workerReplayPayload = readCheckpointReplayPayload(checkpoint);
  const pruned = pruneCheckpointReplayState(
    checkpoint,
    resolvePendingOperationStep(operation, checkpoint.step),
  );
  const replayPayload = mergeCheckpointReplayPayloads(workerReplayPayload, pruned.replayPayload);
  const prunedSerialized = serializeCheckpoint(
    attachTransientCheckpointReplayPayload(pruned.checkpoint, replayPayload),
  );
  await commitCheckpoint(
    internals,
    workflowId,
    operation,
    createCheckpointCommit(
      internals,
      workflowId,
      pruned.checkpoint,
      prunedSerialized,
      replayPayload,
    ),
    callbacks,
    options,
  );
}

function createCheckpointCommit(
  internals: EngineInternals,
  workflowId: string,
  checkpoint: CheckpointStateForCommit,
  serialized: Uint8Array,
  replayPayload: CheckpointReplayPayload | undefined,
): CheckpointCommit {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
  ];
  if (internals.options.checkpointHistory > 0) {
    operations.push({
      type: 'put',
      key: KEYS.checkpointHistory(workflowId, checkpoint.step),
      value: serialized,
    });
  }
  const expectedSerialized = getCommittedCheckpointBytes(internals, workflowId);
  return {
    checkpoint,
    serialized,
    ...(replayPayload === undefined ? {} : { replayPayload }),
    ...(expectedSerialized !== undefined ? { expectedSerialized } : {}),
    step: checkpoint.step,
    timestamp: checkpoint.createdAt,
    operations,
  };
}

function appendAttributeOperations(
  workflowId: string,
  commit: CheckpointCommit,
  previousAttributes: Record<string, SearchAttributeValue>,
  pendingAttributeChanges: Record<string, SearchAttributeValue> | undefined,
  hasPendingAttributeChangesValue: boolean,
  callbacks: PersistCheckpointCallbacks,
): void {
  if (!hasPendingAttributeChangesValue) return;

  callbacks.validateAttributeValueSizes(pendingAttributeChanges ?? {});
  commit.operations.push({
    type: 'put',
    key: KEYS.attribute(workflowId),
    value: encode(commit.checkpoint.searchAttributes),
  });
  commit.operations.push(
    ...buildIndexOperations(workflowId, previousAttributes, commit.checkpoint.searchAttributes),
  );
}

async function commitCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  commit: CheckpointCommit,
  callbacks: PersistCheckpointCallbacks,
  options: PersistCheckpointOptions,
): Promise<void> {
  dispatchCheckpointSizeWarning(internals, workflowId, commit, callbacks);
  const nextPendingTimelineEntry =
    options.timeline === 'preserve-pending'
      ? preservePendingTimelineEntry(internals, workflowId, commit.operations)
      : callbacks.appendTimelineBatchOperations(
          workflowId,
          operation,
          commit.step,
          commit.timestamp,
          commit.operations,
        );
  const { newHead, timestamp } = appendCheckpointEventLog(internals, workflowId, commit);

  // Event-log compaction: fold the deletes + watermark into the SAME batch as the
  // checkpoint and event append, so verify() can never observe a gap without its
  // watermark. No-op (null) when retentionWindow is disabled or nothing aged out.
  // The synchronous `retentionWindow` guard avoids introducing an extra awaited
  // microtask turn on the common (compaction-off) commit path, so the engine's
  // existing checkpoint/signal interleaving is unchanged when the feature is off.
  const retentionWindow = internals.options.historyPolicy.retentionWindow;
  const compaction =
    retentionWindow === null
      ? null
      : await appendCompactionOperations(
          internals.storage,
          workflowId,
          newHead.sequence,
          retentionWindow,
          commit.operations,
        );
  const pendingSideEffects = takePendingAtomicWorkflowCommitSideEffects(internals, workflowId);
  if (pendingSideEffects !== undefined) {
    commit.operations.push(...pendingSideEffects.operations);
  }

  const storageSupportsConditionalBatch = internals.storage.capabilities().conditionalBatch;
  const sideEffectConditions = checkpointSideEffectConditions(
    pendingSideEffects,
    storageSupportsConditionalBatch,
  );
  const conditions = buildCheckpointCommitConditions(
    workflowId,
    commit,
    storageSupportsConditionalBatch,
    sideEffectConditions,
  );
  // commitFencedEngineWrite owns the batch-vs-conditionalBatch decision and adds
  // the lease-epoch fence (under `ownership: 'lease'`). Passing the base
  // conditions here — rather than branching on `conditions.length` and calling
  // `storage.batch` directly — is load-bearing: the epoch condition must be
  // appended UPSTREAM of any plain-batch shortcut, or a checkpoint with no
  // checkpoint-CAS/side-effect condition would bypass the fence and let a deposed
  // zombie's write land unconditioned. Under `ownership: 'none'` it is a
  // byte-for-byte no-op (plain batch when no conditions, conditionalBatch otherwise).
  await commitFencedEngineWrite(internals, commit.operations, conditions, () => {
    return new Error(
      `Checkpoint commit for workflow "${workflowId}" lost its CAS race against a newer checkpoint.`,
    );
  });
  if (pendingSideEffects !== undefined) {
    clearPendingAtomicWorkflowCommitSideEffects(internals, workflowId);
  }
  if (commit.expectedSerialized !== undefined) {
    rememberCommittedCheckpointBytes(internals, workflowId, commit.serialized);
  }
  if (nextPendingTimelineEntry === undefined) {
    internals.pendingTimelineEntries.delete(workflowId);
  } else {
    internals.pendingTimelineEntries.set(workflowId, nextPendingTimelineEntry);
  }
  internals.checkpoints.set(workflowId, commit.checkpoint);
  internals.eventLogHeads.set(workflowId, newHead);
  // Archival runs only after the truncation has committed durably; it is a
  // best-effort export, never a rollback trigger (see ArchiveAdapter). The
  // Promise.resolve().then(...) wrapper turns synchronous adapter throws into
  // swallowed rejections too.
  if (compaction !== null) {
    dispatchCompactionArchival(internals, workflowId, compaction, callbacks);
  }
  notifyWorkflowFeedCommit(internals, workflowId, 'events', {
    workflowId,
    selector: 'events',
    kind: 'workflow:checkpoint',
    sequence: newHead.sequence,
    timestamp,
    payload: { step: commit.step },
  });
  callbacks.swallowPromiseRejection(callbacks.pruneCheckpointHistory(workflowId, commit.step));

  // History circuit breaker: the breaching event has now committed durably and
  // participates in the event-log hash chain, so we never unwind it. Awaiting
  // termination here makes the bound hard — no further checkpoint can commit
  // after this one. A rejection propagates out (the checkpoint is durable; the
  // pre-replay guard re-attempts termination on the next activation).
  if (historyEventLimitBreached(internals, newHead.sequence)) {
    await callbacks.enforceHistoryCircuitBreaker(workflowId);
  }
}

function preservePendingTimelineEntry(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
): PendingTimelineEntryValue | undefined {
  const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
  if (pendingTimelineOperation) {
    operations.push(pendingTimelineOperation);
  }
  return internals.pendingTimelineEntries.get(workflowId);
}

function checkpointSideEffectConditions(
  pendingSideEffects: AtomicWorkflowCommitSideEffects | undefined,
  storageSupportsConditionalBatch: boolean,
): ConditionalBatchCondition[] {
  if (!storageSupportsConditionalBatch) return [];
  return pendingSideEffects?.conditions ?? [];
}

function buildCheckpointCommitConditions(
  workflowId: string,
  commit: CheckpointCommit,
  includeCheckpointCondition: boolean,
  sideEffectConditions: ConditionalBatchCondition[],
): ConditionalBatchCondition[] {
  const conditions: ConditionalBatchCondition[] = [];
  if (includeCheckpointCondition && commit.expectedSerialized !== undefined) {
    conditions.push({
      key: KEYS.checkpoint(workflowId),
      expectedValue: commit.expectedSerialized,
    });
  }
  conditions.push(...sideEffectConditions);
  return conditions;
}

/**
 * Whether the durable event-log record count (`sequence + 1`) now exceeds the
 * configured `maxEvents`. Returns `false` when the circuit breaker is disabled.
 */
function historyEventLimitBreached(internals: EngineInternals, sequence: number): boolean {
  const maxEvents = internals.options.historyPolicy.maxEvents;
  return maxEvents !== null && sequence + 1 > maxEvents;
}

/**
 * Best-effort export of a compacted event-log range to the operator's
 * {@link import('../types/archive-adapter.ts').ArchiveAdapter}, if configured.
 * Never affects checkpoint success: a rejecting OR synchronously-throwing
 * adapter is swallowed, and the records are already deleted regardless.
 */
function dispatchCompactionArchival(
  internals: EngineInternals,
  workflowId: string,
  compaction: CompactionResult,
  callbacks: Pick<PersistCheckpointCallbacks, 'swallowPromiseRejection'>,
): void {
  const adapter = internals.options.archiveAdapter;
  if (adapter === null || compaction.deletedEntries.length === 0) return;

  const { from, to } = compaction.deletedRange;
  const key = `events:${from}-${to}`;
  const bytes = serializeDeletedEntries(compaction.deletedEntries);
  callbacks.swallowPromiseRejection(
    Promise.resolve().then(() => adapter.store(workflowId, key, bytes)),
  );
}

function dispatchCheckpointSizeWarning(
  internals: EngineInternals,
  workflowId: string,
  commit: CheckpointCommit,
  callbacks: PersistCheckpointCallbacks,
): void {
  if (commit.serialized.byteLength >= internals.options.checkpointSizeWarningThreshold) {
    callbacks.dispatchEvent(
      new CheckpointSizeWarningEvent(workflowId, commit.serialized.byteLength, commit.step),
    );
  }
}

function appendCheckpointEventLog(
  internals: EngineInternals,
  workflowId: string,
  commit: CheckpointCommit,
): ReturnType<EventLog['appendToBatch']> {
  const eventLog = new EventLog(internals.storage, workflowId);
  return eventLog.appendToBatch(
    {
      type: 'workflow:checkpoint',
      payload: createCheckpointEventPayload(commit.step, commit.replayPayload),
    },
    commit.operations,
    internals.eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
    internals.workflowVersionTuples.get(workflowId),
  );
}

function resolvePendingOperationStep(
  operation: ContextOperationRequest,
  fallbackStepIndex: number,
): number {
  const operationStep = 'step' in operation ? operation.step : undefined;
  if (
    typeof operationStep === 'number' &&
    Number.isSafeInteger(operationStep) &&
    operationStep >= 0
  ) {
    return operationStep;
  }
  return Math.max(0, fallbackStepIndex - 1);
}

/** Delete the single checkpoint history entry that overflows the retention limit. */
export async function pruneCheckpointHistory(
  internals: EngineInternals,
  workflowId: string,
  currentStep: number,
): Promise<void> {
  const limit = internals.options.checkpointHistory;
  if (limit <= 0) return;

  const overflowStep = currentStep - limit;
  if (overflowStep < 1) return;

  const key = KEYS.checkpointHistory(workflowId, overflowStep);
  await internals.storage.delete(key);
}

/** Validate checkpoint serialization in development mode and dispatch warnings. */
export function validateDevelopmentCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  callbacks: DevelopmentCheckpointCallbacks,
): void {
  if (!internals.options.development) return;

  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!context) return;

  const step = context.stepIndex;
  const current = internals.checkpoints.get(workflowId);
  if (!current) return;
  const result = validateCheckpointRoundTrip({
    ...current,
    locals: context.checkpointLocals,
    accumulatedResults: context.checkpointAccumulatedResults,
  });

  if (!result.valid) {
    const fieldPaths = result.divergences.map((divergence) => divergence.path);
    const message = `Checkpoint at step ${step} has ${result.divergences.length} non-serializable field(s)`;
    callbacks.dispatchEvent(new DevelopmentWarningEvent(workflowId, message, fieldPaths));
  }
}
