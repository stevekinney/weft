import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint } from '../../worker/versioning-policy.ts';
import { bytesEqual } from '../application-primitive-commit.ts';
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
  ActivityCompletedEvent,
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
} from '../events.ts';
import { tagWorkflowEventGeneration } from '../events/workflow-event-generation.ts';
import { resolvePendingOperationStep } from '../pending-operation-step.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type { SearchAttributeValue, WorkflowTimelineEntry } from '../types.ts';
import { buildActivityRetryingOperations } from './activity-retrying-record.ts';
import { retryCheckpointBatch } from './checkpoint-commit-retry.ts';
import {
  getCommittedCheckpointBytes,
  rememberCommittedCheckpointBytes,
} from './checkpoint-commit-snapshots.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { CheckpointEncodingError } from './checkpoint-encoding-error.ts';
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
  takeCommitSideEffects,
  type AtomicWorkflowCommitSideEffects,
} from './checkpoint-side-effects.ts';
import {
  appendCompactionOperations,
  serializeDeletedEntries,
  type CompactionResult,
} from './event-log-compaction.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { FileWorkflowEvent } from './file-workflow-completion-events.ts';
import { appendFileWorkflowCheckpointEvents } from './file-workflow-history.ts';
import type { EngineInternals } from './internals.ts';
import { getTimelineInputSummary, getTimelineOperationLabel } from './state-utilities.ts';
import { buildPendingTimelineOperation } from './termination.ts';
import {
  captureCommitReceipts,
  type ActivityCompletionReceipt,
} from './timeline-coordinator-detail.ts';
import { notifyWorkflowFeedCommit } from './workflow-feed.ts';

type PendingTimelineEntryValue = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
};

function dispatchActivityCompletionReceipt(
  callbacks: Pick<PersistCheckpointCallbacks, 'dispatchEvent'>,
  workflowId: string,
  receipt: ActivityCompletionReceipt,
): void {
  callbacks.dispatchEvent(
    tagWorkflowEventGeneration(
      new ActivityCompletedEvent(
        receipt.operationId,
        workflowId,
        receipt.activityName,
        receipt.duration,
      ),
      receipt.workflowExecutionToken,
    ),
  );
}

export type PersistCheckpointOptions = {
  timeline?: 'record-operation' | 'preserve-pending';
  /**
   * The durable step index the operation occupies, as a worker reports it on its `checkpoint`
   * message (`pendingStepIndex`). Only a worker commit reads it, and requires it: an inline commit
   * reads the live context.
   */
  pendingStepIndex?: number;
  /** With `preserve-pending`: the branch activities whose completion receipts this commit reports. */
  settledBranchOperationIds?: readonly string[];
  /** With `preserve-pending`: the file-workflow completion events this commit records. */
  settledFileWorkflowEvents?: readonly FileWorkflowEvent[];
  /** With `preserve-pending`: the held side effects it writes in place of the staged ones. */
  sideEffects?: AtomicWorkflowCommitSideEffects;
};

/** What a commit made while its operation is still running reports for the steps it settled. */
export type MidOperationCommitReport = Omit<
  PersistCheckpointOptions,
  'timeline' | 'pendingStepIndex'
>;

export type PersistCheckpointCallbacks = {
  appendTimelineBatchOperations: (
    workflowId: string,
    operation: ContextOperationRequest,
    step: number,
    stepIndex: number,
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
  stepIndex: number,
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
    stepIndex,
    ...((operation as ContextOperationRequest & { documentStep?: number }).documentStep ===
    undefined
      ? {}
      : {
          documentStep: (operation as ContextOperationRequest & { documentStep?: number })
            .documentStep,
        }),
    ...((operation as ContextOperationRequest & { documentStepAddress?: string })
      .documentStepAddress === undefined
      ? {}
      : {
          documentStepAddress: (
            operation as ContextOperationRequest & { documentStepAddress: string }
          ).documentStepAddress,
        }),
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
  /** The durable step index of the operation this commit records; see {@link WorkflowTimelineEntry.stepIndex}. */
  stepIndex: number;
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
  const pendingStepIndex = resolvePendingOperationStep(
    operation,
    Math.max(0, context.stepIndex - 1),
  );
  const pruned = pruneCheckpointReplayState(advanced, pendingStepIndex);
  let serialized: ReturnType<typeof serializeCheckpoint>;
  try {
    serialized = serializeCheckpoint(
      attachTransientCheckpointReplayPayload(pruned.checkpoint, pruned.replayPayload),
    );
  } catch (error) {
    throw new CheckpointEncodingError(workflowId, error);
  }
  const commit = createCheckpointCommit(
    internals,
    workflowId,
    pruned.checkpoint,
    serialized,
    pruned.replayPayload,
    pendingStepIndex,
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
  // Fence this commit to the CURRENT execution generation, comparing —
  // never persisting — the worker's own claimed token (WFT-21, Codex
  // review round 5, P1, superseding round 4's "reattach the host's token"
  // with "reject when the generations disagree"). The worker's checkpoint
  // bytes DO carry a trustworthy token for COMPARISON: the host itself
  // stamped it into the initial checkpoint this run's worker was launched
  // from (`createInitialCheckpoint`), and `advanceCheckpoint()` carries it
  // forward unchanged on every subsequent step — so it names the exact
  // generation THIS worker turn was dispatched for. Round 4 was right that
  // it must never be TRUSTED AS THE VALUE TO PERSIST (a hostile or
  // stale worker could forge it there) — this reads it only to detect a
  // mismatch, then always persists the HOST's own copy.
  //
  // `internals.checkpoints.get(workflowId)` — read SYNCHRONOUSLY, no
  // `await` — is the host's own in-memory record of the CURRENT
  // generation, set by every launch (`start()`,
  // `launchWorkflowFromCheckpoint()` for fork, `resume()`) before any
  // worker could receive dispatched work for that generation, and cleared
  // on terminal cleanup/suspend/purge. No entry at all means the live
  // generation has already torn down entirely — reject outright.
  const currentGeneration = internals.checkpoints.get(workflowId);
  if (currentGeneration === undefined) {
    throw new Error(
      `Checkpoint commit for workflow "${workflowId}" targets a generation that no longer exists.`,
    );
  }
  const hostToken = currentGeneration.workflowExecutionToken;
  const workerToken = checkpoint.workflowExecutionToken;
  // Whenever the HOST has a token, require an EXACT worker-token match —
  // including the worker's own token being `undefined` (WFT-21, Codex
  // review round 7, P1, tightening round 5's own fix). The original
  // both-sides-defined-and-disagreeing guard left exactly the gap round 4
  // existed to close: a stale or hostile worker that simply OMITS the
  // field entirely (indistinguishable on the wire from a genuinely
  // pre-upgrade worker that has never heard of it) skipped this check
  // completely and fell through to being silently stamped with the HOST's
  // current token regardless — after a cancel + `start-new` replacement of
  // this same workflow ID, that stale-content-now-wearing-the-replacement's-
  // token checkpoint could pass the replacement's own checkpoint-bytes CAS
  // and overwrite it. A host with a token is strong enough evidence this is
  // NOT a genuinely legacy generation to omit for, so any worker-side
  // disagreement — including silence — is now rejected. The remaining
  // legacy tolerance is narrower and safe: BOTH sides `undefined` (a host
  // generation that itself predates this field, paired with an equally
  // pre-upgrade worker) still proceeds, since there is no "current"
  // identity such a worker could spoof away from in the first place.
  if (hostToken !== undefined && workerToken !== hostToken) {
    throw new Error(
      `Checkpoint commit for workflow "${workflowId}" targets a different execution generation.`,
    );
  }
  if (hostToken !== undefined) {
    checkpoint.workflowExecutionToken = hostToken;
  } else {
    delete checkpoint.workflowExecutionToken;
  }
  const workerReplayPayload = readCheckpointReplayPayload(checkpoint);
  if (options.pendingStepIndex === undefined) {
    throw new Error(
      `Worker checkpoint commit for workflow "${workflowId}" carries no pending step index.`,
    );
  }
  const pendingStepIndex = resolvePendingOperationStep(operation, options.pendingStepIndex);
  const pruned = pruneCheckpointReplayState(checkpoint, pendingStepIndex);
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
      pendingStepIndex,
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
  stepIndex: number,
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
    stepIndex,
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
  const activityCompletionReceipts = captureCommitReceipts(
    internals,
    workflowId,
    options.timeline,
    options.settledBranchOperationIds,
  );
  dispatchCheckpointSizeWarning(internals, workflowId, commit, callbacks);
  // The record behind `WorkflowSummary.retrying` moves in this same batch, only when it changes.
  commit.operations.push(
    ...buildActivityRetryingOperations(internals, workflowId, commit.checkpoint),
  );
  const nextPendingTimelineEntry =
    options.timeline === 'preserve-pending'
      ? preservePendingTimelineEntry(internals, workflowId, commit.operations)
      : callbacks.appendTimelineBatchOperations(
          workflowId,
          operation,
          commit.step,
          commit.stepIndex,
          commit.timestamp,
          commit.operations,
        );
  const fileWorkflowHead = await appendFileWorkflowCheckpointEvents(
    internals,
    workflowId,
    operation,
    commit.stepIndex,
    commit.operations,
    internals.eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
    options.settledFileWorkflowEvents,
  );
  const { newHead, timestamp } = appendCheckpointEventLog(
    internals,
    workflowId,
    commit,
    fileWorkflowHead,
  );

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
  const { sideEffects: pendingSideEffects, fromStaged } = takeCommitSideEffects(
    internals,
    workflowId,
    commit.checkpoint.workflowExecutionToken,
    options.sideEffects,
  );
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
  //
  // A refused write is retried in process (see `retryCheckpointBatch`). The retry starts from the
  // catch of this first attempt, so a batch that commits first time adds no promise turn.
  let committed: boolean;
  try {
    committed = await commitFencedEngineWriteAllowingPreconditionFailure(
      internals,
      workflowId,
      commit.operations,
      conditions,
    );
  } catch (error) {
    committed = await retryCheckpointBatch(internals, workflowId, commit, conditions, error);
  }
  if (!committed) await throwCheckpointCommitLoss(internals, workflowId, commit);
  recordCommittedCheckpoint(
    internals,
    workflowId,
    commit,
    newHead,
    nextPendingTimelineEntry,
    fromStaged,
  );
  for (const receipt of activityCompletionReceipts) {
    dispatchActivityCompletionReceipt(callbacks, workflowId, receipt);
  }
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
  await evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
    internals.storage,
    workflowId,
    `checkpoint:${String(commit.step)}`,
    () => internals.options.getNow(),
  );

  // History circuit breaker: the breaching event has now committed durably and
  // participates in the event-log hash chain, so we never unwind it. Awaiting
  // termination here makes the bound hard — no further checkpoint can commit
  // after this one. A rejection propagates out (the checkpoint is durable; the
  // pre-replay guard re-attempts termination on the next activation).
  if (historyEventLimitBreached(internals, newHead.sequence)) {
    await callbacks.enforceHistoryCircuitBreaker(workflowId);
  }
}

/** The engine's in-memory record of a checkpoint batch that has just committed. Synchronous. */
function recordCommittedCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  commit: CheckpointCommit,
  newHead: ReturnType<EventLog['appendToBatch']>['newHead'],
  nextPendingTimelineEntry: PendingTimelineEntryValue | undefined,
  hadPendingSideEffects: boolean,
): void {
  if (hadPendingSideEffects) {
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

/**
 * Throw for a checkpoint batch that lost its conditional commit. The batch
 * carries more than the checkpoint compare-and-swap (staged side-effect
 * conditions), so a loss is not by itself proof that another writer advanced the
 * checkpoint: only changed checkpoint bytes make it a
 * {@link WorkflowCheckpointConflictError}; anything else keeps the generic error.
 */
async function throwCheckpointCommitLoss(
  internals: EngineInternals,
  workflowId: string,
  commit: CheckpointCommit,
): Promise<never> {
  // Captured before the classification read awaits: a local replacement run can
  // install itself under this id while that read is in flight.
  const { workflowExecutionToken } = commit.checkpoint;
  let checkpointChanged: boolean;
  try {
    checkpointChanged = await checkpointBytesChangedUnderWriter(internals, workflowId, commit);
  } catch (readError) {
    // The compare-and-swap already lost. If the loss cannot be classified it
    // must stay on the write-free conflict path, never fail the run normally.
    throw new WorkflowCheckpointConflictError(workflowId, {
      cause: readError,
      workflowExecutionToken,
    });
  }
  if (checkpointChanged) {
    throw new WorkflowCheckpointConflictError(workflowId, { workflowExecutionToken });
  }
  throw new Error(
    `Checkpoint commit for workflow "${workflowId}" lost its CAS race against a newer checkpoint.`,
  );
}

/**
 * After a lost conditional batch, whether the stored checkpoint no longer holds
 * the bytes this commit was conditioned on — a checkpoint another writer
 * advanced, replaced, or removed. A commit with no checkpoint condition cannot
 * have lost on the checkpoint, and an unchanged checkpoint means a side-effect
 * condition (signal-record consumption, activity reconciliation, child
 * cancellation) was the one that failed.
 */
async function checkpointBytesChangedUnderWriter(
  internals: EngineInternals,
  workflowId: string,
  commit: CheckpointCommit,
): Promise<boolean> {
  if (commit.expectedSerialized === undefined) return false;
  const stored = await internals.storage.get(KEYS.checkpoint(workflowId));
  return stored === null || !bytesEqual(stored, commit.expectedSerialized);
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
  head = internals.eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
): ReturnType<EventLog['appendToBatch']> {
  const eventLog = new EventLog(internals.storage, workflowId, internals.options.getNow);
  return eventLog.appendToBatch(
    {
      type: 'workflow:checkpoint',
      payload: createCheckpointEventPayload(commit.step, commit.replayPayload),
    },
    commit.operations,
    head,
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
