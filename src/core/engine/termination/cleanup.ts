import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS, encodeStorageKeyComponent } from '../../../storage/interface.ts';
import { CleanupWarningEvent } from '../../events.ts';
import type { WorkflowState, WorkflowStatus } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { parseTerminalCleanupTimerId, workflowFeedListenerKey } from '../state-utilities.ts';

export type TerminationCallbacks = {
  dispatchEvent: (event: Event) => void;
  forwardEventToHandle: (workflowId: string, event: Event) => void;
  broadcast: (message: { type: string; workflowId: string }) => void;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
  handleScheduledWorkflowTerminal: (workflowId: string) => Promise<void>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  commitWorkflowStateOperations: (
    state: WorkflowState,
    operations: BatchOperation[],
  ) => Promise<void>;
  cleanupReviews: (workflowId: string) => Promise<void>;
};

export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * Tracked-key waiter kinds share an identical shape: a per-workflow map of
 * `TrackedWaiterKeys` (string | Set<string>) referencing entries in a flat
 * waiter map. Sleep timers and review escalations have different shapes and
 * are handled separately.
 */
type TrackedWaiterKind = 'signal' | 'update' | 'review';

type TrackedWaiterMaps = {
  waiters: Map<string, unknown>;
  byWorkflow: Map<string, string | Set<string>>;
};

function selectTrackedWaiterMaps(
  internals: EngineInternals,
  kind: TrackedWaiterKind,
): TrackedWaiterMaps {
  // Each branch is a literal lookup — collapsing this into a Record at module
  // scope would require capturing `internals`, which is created per Engine.
  const dispatch = {
    signal: () => ({
      waiters: internals.signalWaiters as Map<string, unknown>,
      byWorkflow: internals.signalWaitersByWorkflow,
    }),
    update: () => ({
      waiters: internals.updateWaiters as Map<string, unknown>,
      byWorkflow: internals.updateWaitersByWorkflow,
    }),
    review: () => ({
      waiters: internals.reviewWaiters as Map<string, unknown>,
      byWorkflow: internals.reviewWaitersByWorkflow,
    }),
  } satisfies Record<TrackedWaiterKind, () => TrackedWaiterMaps>;
  return dispatch[kind]();
}

function cleanupTrackedWaiter(
  internals: EngineInternals,
  workflowId: string,
  kind: TrackedWaiterKind,
): void {
  const { waiters, byWorkflow } = selectTrackedWaiterMaps(internals, kind);
  const keys = byWorkflow.get(workflowId);
  if (!keys) return;
  if (typeof keys === 'string') {
    waiters.delete(keys);
  } else {
    for (const key of keys) waiters.delete(key);
  }
  byWorkflow.delete(workflowId);
}

function cleanupSleepResolvers(internals: EngineInternals, workflowId: string): void {
  const sleepOps = internals.sleepResolversByWorkflow.get(workflowId);
  if (!sleepOps) return;
  for (const operationId of sleepOps) {
    const key = `${workflowId}:${operationId}`;
    const resolver = internals.sleepResolvers.get(key);
    if (resolver) resolver();
    internals.sleepResolvers.delete(key);
  }
  internals.sleepResolversByWorkflow.delete(workflowId);
}

function cleanupReviewEscalations(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'swallowPromiseRejection'>,
): void {
  const reviewIds = internals.workflowReviewIds.get(workflowId);
  if (!reviewIds) return;
  for (const reviewId of reviewIds) {
    internals.reviewEscalationHandlers.delete(reviewId);
    const timers = internals.reviewTimerIds.get(reviewId);
    if (timers) {
      for (const timerId of timers) {
        void callbacks.swallowPromiseRejection(internals.scheduler.cancel(timerId, workflowId));
      }
      internals.reviewTimerIds.delete(reviewId);
    }
  }
  internals.workflowReviewIds.delete(workflowId);
}

const TRACKED_WAITER_KINDS: readonly TrackedWaiterKind[] = ['signal', 'update', 'review'];

/**
 * Remove any pending signal, update, and sleep waiters for a workflow. This
 * prevents memory leaks and ensures that cancelled/completed/failed workflows
 * cannot accept new signals, updates, or resolve orphaned sleep timers.
 */
export function cleanupWaiters(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'swallowPromiseRejection'>,
): void {
  for (const kind of TRACKED_WAITER_KINDS) {
    cleanupTrackedWaiter(internals, workflowId, kind);
  }
  cleanupSleepResolvers(internals, workflowId);
  cleanupReviewEscalations(internals, workflowId, callbacks);

  internals.workflowNestingDepths.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowTypeByWorkflowId.delete(workflowId);
}

/**
 * Remove durable records keyed by `workflowId` that otherwise leak after a
 * workflow reaches a terminal state.
 *
 * - When `includeOutputArtifacts` is `false` (used by `completeWorkflow`
 *   and `failWorkflow`), only internal bookkeeping is swept: pending
 *   signals. Output artifacts - offloaded values, blob stream chunks,
 *   shared state, and event history - are preserved so consumers can
 *   still read them via `getStreamChunks()`, `getOffload()`,
 *   `Engine.getEvents()`, etc. after `handle.result()` resolves.
 * - When `includeOutputArtifacts` is `true` (used by `terminateWorkflow`),
 *   the workflow has been cancelled or timed out and no consumer is
 *   waiting on output artifacts, so everything except `ev:` (preserved
 *   for the events endpoint) is removed.
 *
 * Concurrency note: we assume all writers for a workflow's prefixed keys
 * originate from that workflow's own execution. By the time this runs, the
 * workflow is already terminal and cannot schedule new writes. The
 * persisted `terminal-cleanup` timer invokes this after terminalization, so
 * any write that races the scan must have come from a background task that
 * itself still holds a handle to the terminal workflow. Those are
 * caller-level bugs we don't try to paper over here.
 *
 * Scale note: deletes are flushed in batches of `CLEANUP_BATCH_SIZE` so
 * workflows with many blobs/signals do not allocate a single oversized
 * operation array.
 */
export async function cleanupWorkflowStorage(
  internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
): Promise<void> {
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);

  // Always sweep internal state. Signals are workflow-scoped scratch space,
  // and the effect log holds per-operation dedup records that have no consumers
  // after the workflow terminates - leaving them behind would leak linearly with
  // effect volume across the engine's lifetime.
  const prefixes: string[] = [
    KEYS.activityReconciliationPrefix(workflowId),
    `sig:${encodedWorkflowId}:`,
    `state:execution:${encodedWorkflowId}:`,
    `tool-effect:${encodedWorkflowId}:`,
  ];

  if (includeOutputArtifacts) {
    // Terminated workflows have no waiting consumers, so drop the output
    // artifacts too. Event history is still preserved via the omission of
    // the `ev:` prefix - callers that want it gone should use a storage
    // TTL or explicit pruning.
    prefixes.push(`offload:${encodedWorkflowId}:`, `blob:${encodedWorkflowId}:`);
  }

  await internals.storage.delete(KEYS.workflowHeaders(workflowId));

  // Use the storage adapter's native prefix deletion when available
  // (e.g., BunSQLiteStorage's prepared DELETE...WHERE key >= ? AND key < ?).
  // This replaces per-key scan-then-delete loops with a single SQL statement
  // per prefix - a significant win on the activity-completion hot path.
  // Deletions are sequential to avoid multiplying memory pressure on adapters
  // that materialize matching keys before deleting.
  if (internals.storage.deletePrefix) {
    for (const prefix of prefixes) {
      await internals.storage.deletePrefix(prefix);
    }
    return;
  }

  // Fallback for storage adapters without deletePrefix: scan and batch-delete.
  const CLEANUP_BATCH_SIZE = 500;
  let deleteOperations: BatchOperation[] = [];
  const flush = async (): Promise<void> => {
    if (deleteOperations.length === 0) return;
    await internals.storage.batch(deleteOperations);
    deleteOperations = [];
  };

  for (const prefix of prefixes) {
    for await (const [key] of internals.storage.scan(prefix)) {
      deleteOperations.push({ type: 'delete', key });
      if (deleteOperations.length >= CLEANUP_BATCH_SIZE) {
        await flush();
      }
    }
  }

  await flush();
}

/**
 * Shared synchronous cleanup invoked from every terminal-state transition
 * before result delivery. Drops only in-memory state so workflow resolution
 * is no longer blocked on storage cleanup. Durable scratch cleanup is
 * retried later through a persisted `terminal-cleanup` timer.
 *
 */
export function cleanupTerminalWorkflowMemory(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'swallowPromiseRejection'>,
): void {
  internals.workflowsNeedingTerminalCleanup.delete(workflowId);
  internals.checkpoints.delete(workflowId);
  internals.heartbeatDetails.delete(workflowId);
  internals.eventLogHeads.delete(workflowId);
  internals.pendingTimelineEntries.delete(workflowId);
  internals.parkedInlineWorkflows.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  // Drop any remaining feed-listener buckets for this workflow.
  // Transports normally unsubscribe when their subscription ends,
  // but a crashed or leaked connection would otherwise retain its
  // closure for the engine's lifetime. Per-workflow cleanup here
  // matches the other maps above and prevents unbounded growth.
  internals.workflowFeedListeners.delete(workflowFeedListenerKey(workflowId, 'events'));
  internals.workflowFeedListeners.delete(workflowFeedListenerKey(workflowId, 'tokens'));
  cleanupWaiters(internals, workflowId, callbacks);
}

export function cleanupTerminalWorkflowImmediately(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): void {
  cleanupTerminalWorkflowMemory(internals, workflowId, callbacks);
}

export async function cleanupTerminalWorkflowSynchronously(
  internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
  callbacks: TerminationCallbacks,
): Promise<void> {
  cleanupTerminalWorkflowMemory(internals, workflowId, callbacks);
  await cleanupTerminalWorkflowDurableState(
    internals,
    workflowId,
    includeOutputArtifacts,
    callbacks,
  );
}

export async function cleanupTerminalWorkflowDurableState(
  internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await callbacks.cleanupReviews(workflowId);
  await cleanupWorkflowStorage(internals, workflowId, includeOutputArtifacts);
  await internals.storage.delete(KEYS.terminalCleanupNeeded(workflowId));
}

export async function runDeferredTerminalCleanup(
  internals: EngineInternals,
  workflowId: string,
  timerId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const parsedTimer = parseTerminalCleanupTimerId(timerId);
  if (!parsedTimer) {
    callbacks.handleCleanupError(
      'cleanupTerminalWorkflowDurableState',
      new Error(`Ignoring malformed terminal cleanup timer id "${timerId}"`),
      workflowId,
    );
    return;
  }

  const state = await callbacks.loadWorkflowState(workflowId);
  if (!state || !TERMINAL_WORKFLOW_STATUSES.has(state.status)) {
    return;
  }

  if (state.terminalCleanupToken !== parsedTimer.terminalCleanupToken) {
    return;
  }

  try {
    await cleanupTerminalWorkflowDurableState(
      internals,
      workflowId,
      parsedTimer.includeOutputArtifacts,
      callbacks,
    );
  } catch (error) {
    callbacks.handleCleanupError('cleanupTerminalWorkflowDurableState', error, workflowId);
    throw error;
  }
}

export function handleCleanupError(
  _internals: EngineInternals,
  source: string,
  error: unknown,
  workflowId: string | undefined,
  callbacks: Pick<TerminationCallbacks, 'dispatchEvent'>,
): void {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  callbacks.dispatchEvent(new CleanupWarningEvent(source, normalizedError, workflowId));
}

export async function finalizeScheduledWorkflowTerminal(
  _internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'handleCleanupError' | 'handleScheduledWorkflowTerminal'>,
): Promise<void> {
  try {
    await callbacks.handleScheduledWorkflowTerminal(workflowId);
  } catch (error) {
    callbacks.handleCleanupError('handleScheduledWorkflowTerminal', error, workflowId);
  }
}
