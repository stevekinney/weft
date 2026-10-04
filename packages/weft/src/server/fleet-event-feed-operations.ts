import { encode } from '../core/codec.ts';
import { PersistedDataCorruptError } from '../core/persisted-data-incompatible-error.ts';
import {
  KEYS,
  MAX_BATCH_OPERATIONS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from '../storage/interface.ts';
import {
  collectRetentionRecords,
  createFleetEventEnvelope,
  createFleetEventOperations,
  createGapEnvelope,
  decodeCursorOrThrow,
  decodeRetentionFloorOrThrow,
  decodeStorageValue,
  DEFAULT_RETENTION_BATCH_SIZE,
  highestFleetEventSequence,
  isFloorRecord,
  isTailRecord,
  loadConsistentReplayPage,
  loadConsistentWorkflowReplayPage,
  loadTailAuthority,
  parseFleetEventSequenceFromKey,
  REPLAY_PAGE_SIZE,
  validateRetentionOptions,
} from './fleet-event-feed-storage.ts';
import type { FleetEventFeed } from './fleet-event-feed.ts';
import {
  createDurableSubscription,
  createSerialOperationQueue,
} from './replay-live-feed-internals.ts';
import {
  createReplayLiveFeed,
  encodeCursor,
  type Cursor,
  type FleetEventAppendOptions,
  type FleetEventEnvelope,
  type FleetEventInput,
  type FleetWorkflowEventInput,
  type ReplayLiveFeed,
  type ReplayLiveFeedBackend,
} from './workflow-event-feed.ts';

export function createFleetEventFeedOperations(
  storage: Storage,
  livePollIntervalMs: number,
): FleetEventFeed {
  const listeners = new Set<(envelope: FleetEventEnvelope) => void>();
  const disposalController = new AbortController();
  const enqueueAppend = createSerialOperationQueue();

  const backend: ReplayLiveFeedBackend<FleetEventEnvelope> = {
    replay: replayPersistedFleetEvents,
    snapshotTailSequence,
    subscribeLive,
  };
  const replayLiveFeed: ReplayLiveFeed<FleetEventEnvelope> = createReplayLiveFeed(backend);

  async function append(
    event: FleetEventInput,
    options?: FleetEventAppendOptions,
  ): Promise<FleetEventEnvelope> {
    const appended = await enqueueAppend(() =>
      appendInternal(event, async () => options?.conditions ?? [], options?.operations ?? []),
    );
    if (appended === null)
      throw new Error('Fleet event append conditions unexpectedly disappeared.');
    return appended;
  }

  async function appendWorkflowEventIfPresent(
    event: FleetWorkflowEventInput,
  ): Promise<FleetEventEnvelope | null> {
    return enqueueAppend(() =>
      appendInternal(event, async () => {
        const workflowValue = await storage.get(KEYS.workflow(event.workflowId));
        if (workflowValue === null) return null;
        return [{ key: KEYS.workflow(event.workflowId), expectedValue: workflowValue }];
      }, []),
    );
  }

  function appendInternal(
    event: FleetEventInput,
    loadConditions: () => Promise<readonly ConditionalBatchCondition[] | null>,
    callerOperations?: readonly BatchOperation[],
    maxAttempts?: number,
  ): Promise<FleetEventEnvelope | null>;
  async function appendInternal(
    event: FleetEventInput,
    loadConditions?: () => Promise<readonly ConditionalBatchCondition[] | null>,
    callerOperations: readonly BatchOperation[] = [],
    maxAttempts = 25,
  ): Promise<FleetEventEnvelope | null> {
    if (event.kind === 'fleet:gap') {
      throw new RangeError('The fleet:gap event kind is reserved for retention notices.');
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const conditions = loadConditions === undefined ? [] : await loadConditions();
      if (conditions === null) return null;
      const authority = await loadTailAuthority(storage);
      if (authority === null) continue;
      const { tail, tailValue } = authority;
      const sequence = tail + 1;
      const envelope = createFleetEventEnvelope(event, sequence);
      const operations = createFleetEventOperations(envelope, callerOperations);

      const committed = await storageConditionalBatch(
        storage,
        [{ key: KEYS.fleetEventTail(), expectedValue: tailValue }, ...conditions],
        operations,
      );
      if (!committed) continue;
      fireLive(envelope);
      return envelope;
    }
    throw new Error(
      `Fleet event append for workflow "${event.workflowId ?? '<none>'}" lost its storage precondition after ${maxAttempts} attempts.`,
    );
  }

  async function* replayPersistedFleetEvents(options: {
    afterSequence: number;
    requestedCursor?: Cursor;
  }): AsyncIterable<FleetEventEnvelope> {
    let deliveredSequence = options.afterSequence;
    let gapCursor =
      options.requestedCursor ??
      (options.afterSequence < 0 ? '-1' : encodeCursor(options.afterSequence));
    while (true) {
      const page = await loadConsistentReplayPage(storage, deliveredSequence);
      if (deliveredSequence < page.floor - 1) {
        deliveredSequence = page.floor - 1;
        yield createGapEnvelope(deliveredSequence, gapCursor, page.floor);
        gapCursor = encodeCursor(deliveredSequence);
        continue;
      }
      for (const envelope of page.envelopes) {
        deliveredSequence = envelope.sequence;
        yield envelope;
      }
      if (page.envelopes.length < REPLAY_PAGE_SIZE) return;
    }
  }

  async function* replayPersistedFleetEventsForWorkflow(options: {
    workflowId: string;
    afterSequence: number;
    requestedCursor?: Cursor;
  }): AsyncIterable<FleetEventEnvelope> {
    let deliveredSequence = options.afterSequence;
    let gapCursor =
      options.requestedCursor ??
      (options.afterSequence < 0 ? '-1' : encodeCursor(options.afterSequence));
    while (true) {
      const page = await loadConsistentWorkflowReplayPage(
        storage,
        options.workflowId,
        deliveredSequence,
      );
      if (deliveredSequence < page.floor - 1) {
        deliveredSequence = page.floor - 1;
        yield createGapEnvelope(deliveredSequence, gapCursor, page.floor);
        gapCursor = encodeCursor(deliveredSequence);
        continue;
      }
      for (const envelope of page.envelopes) {
        deliveredSequence = envelope.sequence;
        yield envelope;
      }
      // Pagination completeness is judged by how many index entries the scan
      // actually found, not by how many survived the legitimate-deletion
      // filter in `loadConsistentWorkflowReplayPage` — a page where every
      // candidate was concurrently purged is still a full page and must not
      // be mistaken for the end of the index.
      if (page.scannedIndexEntries < REPLAY_PAGE_SIZE) return;
    }
  }

  /**
   * Owner-indexed counterpart to `replayPersistedFleetEvents`: instead of
   * scanning every retained fleet event (`fleet-event:`), it scans only the
   * `fleet-event-by-workflow:<workflowId>:` secondary index that `append()`
   * and `retain()` already maintain, then reads each matching envelope by its
   * exact `fleet-event:` key. Cost is proportional to that workflow's own
   * retained events, not the whole retained log. It mirrors
   * `ReplayLiveFeed.replay()`'s cursor-decode-then-limit wrapping so a
   * workflow-scoped replay carries the identical cursor, `limit`, and
   * retention-gap semantics as the unfiltered replay.
   */
  async function* replayForWorkflow(
    workflowId: string,
    args?: { fromCursor?: Cursor; limit?: number },
  ): AsyncIterable<FleetEventEnvelope> {
    if (workflowId.length === 0) {
      throw new RangeError('Fleet event replay workflowId must not be empty.');
    }
    const afterSequence =
      args?.fromCursor !== undefined ? decodeCursorOrThrow(args.fromCursor) : -1;
    let yielded = 0;
    for await (const envelope of replayPersistedFleetEventsForWorkflow({
      workflowId,
      afterSequence,
      ...(args?.fromCursor === undefined ? {} : { requestedCursor: args.fromCursor }),
    })) {
      if (args?.limit !== undefined && yielded >= args.limit) return;
      yield envelope;
      yielded += 1;
    }
  }

  async function snapshotTailSequence(): Promise<number> {
    const storedTail = await storage.get(KEYS.fleetEventTail());
    const decodedTail =
      storedTail === null ? null : decodeStorageValue(storedTail, KEYS.fleetEventTail());
    if (storedTail !== null && !isTailRecord(decodedTail))
      throw new PersistedDataCorruptError(KEYS.fleetEventTail());
    if (isTailRecord(decodedTail)) return decodedTail.sequence;

    // `append()` writes the tail record atomically with the first event, so an absent tail
    // normally means this feed is virgin; the bounded scan guards the tail-less-but-populated
    // case as corruption. An empty scan means genuinely virgin: persist a `{ sequence: -1 }`
    // sentinel so later calls answer from `storage.get()` alone. The persist is best-effort — a
    // lost CAS race or a thrown storage error both leave the already-correct `-1` unaffected.
    const highest = await highestFleetEventSequence(storage);
    if (highest !== -1) return highest;
    try {
      await storageConditionalBatch(
        storage,
        [{ key: KEYS.fleetEventTail(), expectedValue: null }],
        [{ type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence: -1 }) }],
      );
    } catch {
      /* best-effort sentinel persist; virgin feed still reports -1 */
    }
    return -1;
  }

  async function snapshotRetentionFloor(): Promise<number> {
    const value = await storage.get(KEYS.fleetEventWatermark());
    if (value === null) return 0;
    const decoded = decodeStorageValue(value, KEYS.fleetEventWatermark());
    if (!isFloorRecord(decoded)) throw new PersistedDataCorruptError(KEYS.fleetEventWatermark());
    return decoded.firstRetainedSequence;
  }

  async function retain(options: { beforeSequence: number; limit?: number }): Promise<number> {
    validateRetentionOptions(options);
    const requestedLimit = options.limit ?? DEFAULT_RETENTION_BATCH_SIZE;
    const limit = Math.min(requestedLimit, Math.floor((MAX_BATCH_OPERATIONS - 1) / 2));
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const watermarkValue = await storage.get(KEYS.fleetEventWatermark());
      const floor = decodeRetentionFloorOrThrow(watermarkValue);
      const tail = await snapshotTailSequence();
      const target = Math.min(options.beforeSequence, tail + 1);
      if (target <= floor) return 0;
      const recordsToDelete = await collectRetentionRecords(storage, target, limit);
      const deletedThrough = recordsToDelete.at(-1)?.key;
      const deletedThroughSequence =
        deletedThrough === undefined ? floor : parseFleetEventSequenceFromKey(deletedThrough)! + 1;
      const newFloor = recordsToDelete.length < limit ? target : deletedThroughSequence;
      const operations: BatchOperation[] = [
        ...recordsToDelete.flatMap(({ key, workflowId, sequence }) => [
          { type: 'delete' as const, key },
          ...(workflowId === undefined
            ? []
            : [{ type: 'delete' as const, key: KEYS.fleetEventByWorkflow(workflowId, sequence) }]),
        ]),
        {
          type: 'put',
          key: KEYS.fleetEventWatermark(),
          value: encode({ firstRetainedSequence: newFloor }),
        },
      ];
      const committed = await storageConditionalBatch(
        storage,
        [{ key: KEYS.fleetEventWatermark(), expectedValue: watermarkValue }],
        operations,
      );
      if (committed) return recordsToDelete.length;
    }
    throw new Error('Fleet event retention lost its storage precondition after 25 attempts.');
  }

  function subscribeLive(listener: (envelope: FleetEventEnvelope) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function fireLive(envelope: FleetEventEnvelope): void {
    const listenerSnapshot = Array.from(listeners);
    for (const listener of listenerSnapshot) {
      try {
        listener(envelope);
      } catch {
        // Listener failures must not corrupt append or other subscribers.
      }
    }
  }

  return {
    append,
    appendWorkflowEventIfPresent,
    replay: (options) =>
      options?.workflowId === undefined
        ? replayLiveFeed.replay(options)
        : replayForWorkflow(options.workflowId, options),
    subscribe: (options) =>
      createDurableSubscription(
        backend,
        {
          pollIntervalMs: livePollIntervalMs,
          lifecycleSignal: disposalController.signal,
        },
        options,
      ),
    snapshotTailSequence,
    snapshotRetentionFloor,
    retain,
    dispose() {
      disposalController.abort();
      listeners.clear();
      replayLiveFeed.dispose();
    },
  };
}
