import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  advanceCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from '../checkpoint.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { sanitizeDebugValueForDisplay } from '../debug-output.ts';
import { EMPTY_EVENT_HEAD, EventLog } from '../event-log.ts';
import {
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
} from '../events.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type {
  CheckpointState,
  CheckpointSummary,
  SearchAttributeValue,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowTimelineEntry,
} from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  getTimelineInputSummary,
  getTimelineOperationLabel,
  sanitizeCheckpointState,
  sanitizeTimelineSummary,
  sanitizeWorkflowEventPayload,
} from './state-utilities.ts';
import { buildPendingTimelineOperation } from './termination.ts';
import { isWorkflowTimelineEntry } from './validation.ts';
import { notifyWorkflowFeedCommit } from './workflow-feed.ts';

type PendingTimelineEntryValue = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
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

/** Retrieve the event history for a workflow. */
export async function getEvents(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  const eventLog = new EventLog(internals.storage, workflowId);

  // Use EventLog.scan() instead of scanning the raw prefix so that the head
  // record (ev:{workflowId}:head) is filtered out by the isWorkflowLogEntry
  // guard inside scan(). Previously this method scanned the raw prefix and
  // returned a spurious entry for the head record on every checkpointed workflow.
  for await (const entry of eventLog.scan()) {
    events.push({
      type: entry.type,
      timestamp: entry.timestamp,
      data: sanitizeWorkflowEventPayload(entry.payload),
    });
  }

  return events;
}

/**
 * List checkpoint history entries for a workflow, newest first.
 * Returns summary metadata only — use getCheckpointAt for full state.
 */
export async function listCheckpoints(
  internals: EngineInternals,
  workflowId: string,
): Promise<CheckpointSummary[]> {
  if (internals.options.checkpointHistory <= 0) return [];

  const prefix = `${KEYS.checkpoint(workflowId)}:`;
  const summaries: CheckpointSummary[] = [];

  for await (const [, value] of internals.storage.scan(prefix, {
    reverse: true,
    limit: internals.options.checkpointHistory,
  })) {
    const checkpoint = deserializeCheckpoint(value);
    summaries.push({
      step: checkpoint.step,
      timestamp: checkpoint.createdAt,
      sizeBytes: value.byteLength,
    });
  }

  return summaries;
}

/** Retrieve the full deserialized checkpoint state at a specific step. */
export async function getCheckpointAt(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): Promise<CheckpointState | null> {
  const bytes = await internals.storage.get(KEYS.checkpointHistory(workflowId, step));
  if (!bytes) return null;

  const checkpoint = deserializeCheckpoint(bytes);
  return sanitizeCheckpointState({
    step: checkpoint.step,
    locals: checkpoint.locals,
    searchAttributes: checkpoint.searchAttributes,
    version: checkpoint.version,
    createdAt: checkpoint.createdAt,
  });
}

/** Return the durable per-step execution timeline for a workflow. */
export async function getTimeline(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowTimelineEntry[]> {
  const timeline: WorkflowTimelineEntry[] = [];

  for await (const [, value] of internals.storage.scan(KEYS.timelinePrefix(workflowId))) {
    let decoded: unknown;
    try {
      decoded = decode(value);
    } catch {
      continue;
    }

    if (isWorkflowTimelineEntry(decoded)) {
      timeline.push({
        ...decoded,
        inputSummary: sanitizeTimelineSummary(decoded.inputSummary) ?? decoded.inputSummary,
        ...(decoded.outputSummary !== undefined
          ? {
              outputSummary:
                sanitizeTimelineSummary(decoded.outputSummary) ?? decoded.outputSummary,
            }
          : {}),
      });
    }
  }

  timeline.sort((left, right) => left.step - right.step);
  return timeline;
}

/** Reconstruct workflow state at a historical checkpoint step. */
export async function replayTo(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): Promise<WorkflowReplay | null> {
  const bytes = await internals.storage.get(KEYS.checkpointHistory(workflowId, step));
  if (!bytes) {
    return null;
  }

  const checkpoint = deserializeCheckpoint(bytes);
  const eventLog = new EventLog(internals.storage, workflowId);
  const entries = await eventLog.replay(Math.max(step - 1, -1));

  return {
    checkpoint: sanitizeCheckpointState({
      step: checkpoint.step,
      locals: checkpoint.locals,
      searchAttributes: checkpoint.searchAttributes,
      version: checkpoint.version,
      createdAt: checkpoint.createdAt,
    }),
    accumulatedResults: checkpoint.accumulatedResults.map(([index, value]) => [
      index,
      sanitizeDebugValueForDisplay(value),
    ]),
    events: entries.map((entry) => ({
      type: entry.type,
      timestamp: entry.timestamp,
      data: sanitizeWorkflowEventPayload(entry.payload),
    })),
  };
}

type CheckpointCommit = {
  checkpoint: CheckpointStateForCommit;
  serialized: Uint8Array;
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
): Promise<void> {
  const context = internals.inlineStrategy?.getContext(workflowId);

  if (context) {
    await persistInlineCheckpoint(internals, workflowId, operation, callbacks);
  } else if (workerCheckpointBytes && workerCheckpointBytes.byteLength > 0) {
    await persistWorkerCheckpoint(
      internals,
      workflowId,
      operation,
      workerCheckpointBytes,
      callbacks,
    );
  }
}

async function persistInlineCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  callbacks: PersistCheckpointCallbacks,
): Promise<void> {
  const current = internals.checkpoints.get(workflowId);
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!current || !context) return;

  const previousAttributes = { ...current.searchAttributes };
  const pendingAttributeChanges = context.checkpointPendingAttributeChanges;
  const hasPendingAttributeChanges = context.hasPendingAttributeChanges;
  const advanced = advanceCheckpoint(current, context.checkpointLocals, {
    accumulatedResults: context.checkpointAccumulatedResults,
    now: internals.options.getNow(),
    ...(pendingAttributeChanges !== undefined ? { searchAttributes: pendingAttributeChanges } : {}),
  });
  const commit = createCheckpointCommit(
    internals,
    workflowId,
    advanced,
    serializeCheckpoint(advanced),
  );
  appendAttributeOperations(
    workflowId,
    commit,
    previousAttributes,
    pendingAttributeChanges,
    hasPendingAttributeChanges,
    callbacks,
  );
  await commitCheckpoint(internals, workflowId, operation, commit, callbacks);
  if (hasPendingAttributeChanges) {
    callbacks.dispatchEvent(new AttributesChangedEvent(workflowId, pendingAttributeChanges ?? {}));
  }
}

async function persistWorkerCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  workerCheckpointBytes: ArrayBuffer,
  callbacks: PersistCheckpointCallbacks,
): Promise<void> {
  const serialized = new Uint8Array(workerCheckpointBytes);
  const checkpoint = deserializeCheckpoint(serialized);
  await commitCheckpoint(
    internals,
    workflowId,
    operation,
    createCheckpointCommit(internals, workflowId, checkpoint, serialized),
    callbacks,
  );
}

function createCheckpointCommit(
  internals: EngineInternals,
  workflowId: string,
  checkpoint: CheckpointStateForCommit,
  serialized: Uint8Array,
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
  return {
    checkpoint,
    serialized,
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
  hasPendingAttributeChanges: boolean,
  callbacks: PersistCheckpointCallbacks,
): void {
  if (!hasPendingAttributeChanges) return;

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
): Promise<void> {
  dispatchCheckpointSizeWarning(internals, workflowId, commit, callbacks);
  const nextPendingTimelineEntry = callbacks.appendTimelineBatchOperations(
    workflowId,
    operation,
    commit.step,
    commit.timestamp,
    commit.operations,
  );
  const { newHead, timestamp } = appendCheckpointEventLog(internals, workflowId, commit);

  await internals.storage.batch(commit.operations);
  internals.pendingTimelineEntries.set(workflowId, nextPendingTimelineEntry);
  internals.checkpoints.set(workflowId, commit.checkpoint);
  internals.eventLogHeads.set(workflowId, newHead);
  notifyWorkflowFeedCommit(internals, workflowId, 'events', {
    workflowId,
    selector: 'events',
    kind: 'workflow:checkpoint',
    sequence: newHead.sequence,
    timestamp,
    payload: { step: commit.step },
  });
  callbacks.swallowPromiseRejection(callbacks.pruneCheckpointHistory(workflowId, commit.step));
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
    { type: 'workflow:checkpoint', payload: { step: commit.step } },
    commit.operations,
    internals.eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
    internals.workflowVersionTuples.get(workflowId),
  );
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
  const result = validateCheckpointRoundTrip(current);

  if (!result.valid) {
    const fieldPaths = result.divergences.map((divergence) => divergence.path);
    const message = `Checkpoint at step ${step} has ${result.divergences.length} non-serializable field(s)`;
    callbacks.dispatchEvent(new DevelopmentWarningEvent(workflowId, message, fieldPaths));
  }
}
