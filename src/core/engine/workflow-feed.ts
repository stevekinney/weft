import { EventLog } from '../event-log.ts';
import type { EngineInternals } from './internals.ts';
import { workflowFeedListenerKey } from './state-utilities.ts';
import { loadStoredStreamChunks } from './stream-chunk-loading.ts';

/**
 * Discriminator for `replayWorkflowFeed` / `snapshotWorkflowFeedTail`
 * / `subscribeWorkflowFeedCommits`. Mirrored by `EventSelector` in
 * `src/server/workflow-event-feed.ts` so the core engine takes no
 * dependency on the server package.
 */
export type WorkflowFeedSelector = 'events' | 'tokens';

/**
 * Hard-coded stream key for the `tokens` selector. Matches the
 * legacy REST SSE endpoint's key so resumption cursors round-trip
 * across transports.
 */
export const TOKENS_STREAM_KEY = 'tokens';

/** Record `kind` for every token stream chunk emitted by the feed. */
export const STREAM_CHUNK_KIND = 'stream:chunk';

/**
 * A committed workflow-feed record surfaced to subscribers of
 * `subscribeWorkflowFeedCommits()`. Fires after `storage.batch()`
 * (events) or `storage.put()` (tokens) resolves, so replay and live
 * delivery share the same committed sequence authority. The same
 * shape covers both selectors — consumers filter on `selector`
 * before interpreting `payload`.
 *
 *   - `events` selector: `kind` is the durable log entry type
 *     (e.g. `'workflow:checkpoint'`). `sequence` / `timestamp` come
 *     from the `WorkflowLogEntry` written inside the batch.
 *   - `tokens` selector: `kind` is always `'stream:chunk'`.
 *     `sequence` is the chunk index; `timestamp` is wall-clock at
 *     write time.
 */
export type WorkflowFeedRecord = {
  readonly workflowId: string;
  readonly selector: WorkflowFeedSelector;
  readonly kind: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly payload: unknown;
};

export type WorkflowFeedRecordValue = WorkflowFeedRecord;

/**
 * Listener signature for `subscribeWorkflowFeedCommits()`. Returning
 * `void | Promise<void>` is explicit: an async listener's rejected
 * promise is caught by the notifier and discarded, exactly like a
 * sync throw. This is the only correct shape for a notifier called
 * from a hot path — an escaped unhandled rejection would surface as
 * a test-runner or Node process-level crash.
 */
export type WorkflowFeedListener = (record: WorkflowFeedRecord) => void | Promise<void>;

/**
 * Iterate over the workflow's post-commit records for a given selector.
 */
export async function* replayWorkflowFeed(
  internals: EngineInternals,
  workflowId: string,
  selector: WorkflowFeedSelector,
  afterSequence: number,
): AsyncIterable<WorkflowFeedRecord> {
  if (selector === 'events') {
    yield* replayWorkflowEventLog(internals, workflowId, afterSequence);
    return;
  }
  yield* replayWorkflowTokens(internals, workflowId, afterSequence);
}

/**
 * Snapshot the current tail sequence for the selector.
 */
export async function snapshotWorkflowFeedTail(
  internals: EngineInternals,
  workflowId: string,
  selector: WorkflowFeedSelector,
): Promise<number> {
  if (selector === 'events') {
    const head = internals.eventLogHeads.get(workflowId);
    if (head) return head.sequence;
    const eventLog = new EventLog(internals.storage, workflowId);
    const loaded = await eventLog.loadHead();
    return loaded.sequence;
  }
  // `tokens` — scan is O(n) in stored chunks. The legacy stream-
  // chunk storage model does not persist a tail record, so a full
  // prefix iteration is unavoidable without a schema change.
  // Acceptable for now; the typical token stream is short-lived
  // and reconnect frequency is low.
  const chunks = await loadStoredStreamChunks(internals.storage, workflowId, TOKENS_STREAM_KEY);
  if (chunks.length === 0) return -1;
  let max = -1;
  for (const chunk of chunks) {
    if (chunk.sequence > max) max = chunk.sequence;
  }
  return max;
}

/**
 * Subscribe to post-commit workflow-feed notifications.
 */
export function subscribeWorkflowFeedCommits(
  internals: EngineInternals,
  workflowId: string,
  selector: WorkflowFeedSelector,
  listener: WorkflowFeedListener,
): () => void {
  const key = workflowFeedListenerKey(workflowId, selector);
  let bucket = internals.workflowFeedListeners.get(key);
  if (!bucket) {
    bucket = new Set();
    internals.workflowFeedListeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    const set = internals.workflowFeedListeners.get(key);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) internals.workflowFeedListeners.delete(key);
  };
}

/**
 * Replay committed workflow event-log entries after a durable sequence cursor.
 */
export async function* replayWorkflowEventLog(
  internals: EngineInternals,
  workflowId: string,
  afterSequence: number,
): AsyncIterable<WorkflowFeedRecord> {
  const eventLog = new EventLog(internals.storage, workflowId);
  const fromSequence = afterSequence < 0 ? 0 : afterSequence + 1;
  for await (const entry of eventLog.scan({ fromSequence })) {
    yield {
      workflowId,
      selector: 'events',
      kind: entry.type,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      payload: entry.payload,
    };
  }
}

/**
 * Replay committed token stream chunks after a durable sequence cursor.
 */
export async function* replayWorkflowTokens(
  internals: EngineInternals,
  workflowId: string,
  afterSequence: number,
): AsyncIterable<WorkflowFeedRecord> {
  const chunks =
    afterSequence >= 0
      ? await loadStoredStreamChunks(internals.storage, workflowId, TOKENS_STREAM_KEY, {
          after: afterSequence,
        })
      : await loadStoredStreamChunks(internals.storage, workflowId, TOKENS_STREAM_KEY);
  // Stream chunks carry no persisted timestamp — the replay path
  // stamps the wallclock at iteration time so consumers always see
  // a populated `timestamp`. Live chunks stamp the same way at
  // commit time for symmetry.
  const timestamp = Date.now();
  for (const chunk of chunks) {
    yield {
      workflowId,
      selector: 'tokens',
      kind: STREAM_CHUNK_KIND,
      sequence: chunk.sequence,
      timestamp,
      payload: chunk.value,
    };
  }
}

/**
 * Dispatch a committed record to every listener registered for
 * `(workflowId, selector)`.
 */
export function notifyWorkflowFeedCommit(
  internals: EngineInternals,
  workflowId: string,
  selector: WorkflowFeedSelector,
  record: WorkflowFeedRecord,
): void {
  const bucket = internals.workflowFeedListeners.get(workflowFeedListenerKey(workflowId, selector));
  if (!bucket || bucket.size === 0) return;
  const listeners = [...bucket];
  for (const listener of listeners) {
    try {
      const result = listener(record);
      if (result && typeof result.then === 'function') {
        // Async listener: its promise may reject after the sync
        // return. Catch so the rejection does not surface as a
        // Node-level unhandled-rejection event.
        void result.catch(() => {});
      }
    } catch {
      // Sync throw from the listener must not corrupt the commit path.
    }
  }
}
