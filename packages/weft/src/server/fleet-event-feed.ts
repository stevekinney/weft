import { decode, encode } from '../core/codec.ts';
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
  createDurableSubscription,
  createSerialOperationQueue,
} from './replay-live-feed-internals.ts';
import {
  createReplayLiveFeed,
  decodeCursor,
  encodeCursor,
  type Cursor,
  type FleetEventAppendOptions,
  type FleetEventEnvelope,
  type FleetEventFeedOptions,
  type FleetEventInput,
  type FleetWorkflowEventInput,
  type ReplayLiveFeed,
  type ReplayLiveFeedBackend,
  type ReplayLiveSubscribeOptions,
} from './workflow-event-feed.ts';
export type {
  FleetEventAppendOptions,
  FleetEventEnvelope,
  FleetEventFeedOptions,
  FleetEventGapEnvelope,
  FleetEventInput,
  FleetWorkflowEventInput,
} from './workflow-event-feed.ts';

/**
 * Append cross-workflow events, replay history, then subscribe for live delivery. This is the shape
 * of `HandlerOptions.fleetEventFeed` — build a real one with
 * `createFleetEventFeed()` to drive `/v1/events/sse` through `handleRequest()`
 * without `serve()`.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const fleetEventFeed: FleetEventFeed = createFleetEventFeed(engine.storage);
 * void fleetEventFeed;
 * ```
 */
export type FleetEventFeed = {
  append(event: FleetEventInput, options?: FleetEventAppendOptions): Promise<FleetEventEnvelope>;
  appendWorkflowEventIfPresent(event: FleetWorkflowEventInput): Promise<FleetEventEnvelope | null>;
  /**
   * Replay retained fleet events. Pass `workflowId` to serve only that
   * workflow's retained events from the `fleet-event-by-workflow:` secondary
   * index instead of scanning the entire retained fleet log — see
   * `replayForWorkflow` for the indexed algorithm. Omitting `workflowId`
   * replays the full fleet feed exactly as before. Both forms share the same
   * cursor, `limit`, and retention-gap (`fleet:gap`) semantics.
   */
  replay(options?: {
    workflowId?: string;
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<FleetEventEnvelope>;
  subscribe(
    options?: ReplayLiveSubscribeOptions<FleetEventEnvelope>,
  ): AsyncIterable<FleetEventEnvelope>;
  snapshotTailSequence(): Promise<number>;
  snapshotRetentionFloor(): Promise<number>;
  retain(options: { beforeSequence: number; limit?: number }): Promise<number>;
  dispose(): void;
};

const DEFAULT_RETENTION_BATCH_SIZE = 100;
const REPLAY_PAGE_SIZE = 128;

/**
 * Build a `FleetEventFeed` backed by the given `Storage` — typically
 * `engine.storage` and share it across every fleet transport.
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { createFleetEventFeed } from '@lostgradient/weft';
 * const feed = createFleetEventFeed(new MemoryStorage());
 * ```
 */
export function createFleetEventFeed(
  storage: Storage,
  feedOptions?: FleetEventFeedOptions,
): FleetEventFeed {
  if (!storage.capabilities().conditionalBatch) {
    throw new Error('Fleet event feeds require storage with conditional batch support.');
  }
  const livePollIntervalMs = feedOptions?.livePollIntervalMs ?? 100;
  if (!Number.isSafeInteger(livePollIntervalMs) || livePollIntervalMs < 1) {
    throw new RangeError('Fleet event live poll interval must be positive.');
  }
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

async function loadTailAuthority(
  storage: Storage,
): Promise<{ tail: number; tailValue: Uint8Array | null } | null> {
  const tailValue = await storage.get(KEYS.fleetEventTail());
  const tail = tailValue === null ? -1 : decodeTailOrThrow(tailValue);
  const highest = await highestFleetEventSequence(storage);
  if (highest > tail) {
    const refreshedTailValue = await storage.get(KEYS.fleetEventTail());
    if (!bytesEqual(refreshedTailValue, tailValue)) return null;
    throw new PersistedDataCorruptError(KEYS.fleetEventTail());
  }
  return { tail, tailValue };
}

async function loadConsistentReplayPage(
  storage: Storage,
  afterSequence: number,
): Promise<{ floor: number; envelopes: FleetEventEnvelope[] }> {
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const floorValue = await storage.get(KEYS.fleetEventWatermark());
    const floor = decodeRetentionFloorOrThrow(floorValue);
    const envelopes: FleetEventEnvelope[] = [];
    const scanOptions = {
      ...(afterSequence >= 0 ? { gt: KEYS.fleetEvent(afterSequence) } : {}),
      limit: REPLAY_PAGE_SIZE,
    };
    for await (const [key, value] of storage.scan(KEYS.fleetEventPrefix(), scanOptions)) {
      const sequence = parseFleetEventSequenceFromKey(key);
      if (sequence === null) throw new PersistedDataCorruptError(key);
      if (sequence <= afterSequence) continue;
      const decoded = decodeStorageValue(value, key);
      if (!isFleetEventEnvelope(decoded) || decoded.sequence !== sequence) {
        throw new PersistedDataCorruptError(key);
      }
      envelopes.push(decoded);
    }
    const refreshedFloorValue = await storage.get(KEYS.fleetEventWatermark());
    if (bytesEqual(refreshedFloorValue, floorValue)) return { floor, envelopes };
  }
  throw new Error('Fleet event replay could not obtain a stable retention snapshot.');
}

/**
 * Owner-indexed sibling of `loadConsistentReplayPage`: scans the
 * `fleet-event-by-workflow:<workflowId>:` index instead of the full
 * `fleet-event:` keyspace, then reads each matching sequence's envelope
 * directly by key via `readWorkflowFleetEvent`. Unlike `loadConsistentReplayPage`
 * — which reads a key and its value from the same `storage.scan()` snapshot —
 * the event value here comes from a separate `storage.get()` issued after the
 * index scan, so a legitimate concurrent deletion (by `retain()` or
 * `Engine.purge()`) can land in that window; see `readWorkflowFleetEvent` for
 * how that is told apart from genuine corruption.
 *
 * The floor/watermark stability retry below is unrelated to that: it exists
 * so the `floor` value returned is consistent with what was actually scanned,
 * which only `retain()` affects (`Engine.purge()` never writes
 * `fleetEventWatermark`), keeping this function's gap-detection contract
 * identical to `loadConsistentReplayPage`'s.
 */
async function loadConsistentWorkflowReplayPage(
  storage: Storage,
  workflowId: string,
  afterSequence: number,
): Promise<{ floor: number; envelopes: FleetEventEnvelope[]; scannedIndexEntries: number }> {
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const floorValue = await storage.get(KEYS.fleetEventWatermark());
    const floor = decodeRetentionFloorOrThrow(floorValue);
    const candidateSequences: number[] = [];
    const scanOptions = {
      ...(afterSequence >= 0 ? { gt: KEYS.fleetEventByWorkflow(workflowId, afterSequence) } : {}),
      limit: REPLAY_PAGE_SIZE,
    };
    for await (const [key] of storage.scan(
      KEYS.fleetEventByWorkflowPrefix(workflowId),
      scanOptions,
    )) {
      const sequence = parseFleetEventByWorkflowSequenceFromKey(workflowId, key);
      if (sequence === null) throw new PersistedDataCorruptError(key);
      if (sequence <= afterSequence) continue;
      candidateSequences.push(sequence);
    }
    const envelopes: FleetEventEnvelope[] = [];
    for (const sequence of candidateSequences) {
      const envelope = await readWorkflowFleetEvent(storage, workflowId, sequence);
      // A `null` here already went through readWorkflowFleetEvent's own
      // legitimacy check — it is a confirmed benign concurrent deletion, not
      // a signal that this page needs retrying, so it is just left out.
      if (envelope !== null) envelopes.push(envelope);
    }
    const refreshedFloorValue = await storage.get(KEYS.fleetEventWatermark());
    if (bytesEqual(refreshedFloorValue, floorValue)) {
      return { floor, envelopes, scannedIndexEntries: candidateSequences.length };
    }
  }
  throw new Error('Fleet event replay could not obtain a stable retention snapshot.');
}

/**
 * Read one workflow-indexed fleet event by sequence, tolerating a benign
 * concurrent deletion. `retain()` and `Engine.purge()`
 * (`addWorkflowLinkedFleetEventDeleteKeys` in `core/engine/bulk-operations-purge.ts`)
 * are each the sole writer of their own atomic batch that deletes a
 * `fleet-event:<sequence>` record together with its
 * `fleet-event-by-workflow:` index entry for the same sequence — `retain()`
 * via `storageConditionalBatch`, purge via `commitFencedEngineWrite`, both
 * documented as committing their operations atomically. So if the event
 * record is missing, the index entry for that exact sequence is either also
 * already gone (an ordinary concurrent deletion by either of them — those
 * two are the only callers that ever delete these keys, so nothing else
 * could explain it) or it is still present, meaning the pair was torn apart
 * by something that is not one of those atomic batches: genuine corruption.
 * This check does not depend on `fleetEventWatermark`, since purge never
 * writes it — only `retain()` does.
 */
async function readWorkflowFleetEvent(
  storage: Storage,
  workflowId: string,
  sequence: number,
): Promise<FleetEventEnvelope | null> {
  const eventKey = KEYS.fleetEvent(sequence);
  const value = await storage.get(eventKey);
  if (value === null) {
    const indexValue = await storage.get(KEYS.fleetEventByWorkflow(workflowId, sequence));
    if (indexValue === null) return null;
    throw new PersistedDataCorruptError(eventKey);
  }
  const decoded = decodeStorageValue(value, eventKey);
  if (
    !isFleetEventEnvelope(decoded) ||
    decoded.sequence !== sequence ||
    decoded.workflowId !== workflowId
  ) {
    // Immutable data disagreeing with its own index entry can never be a
    // benign concurrent deletion — sequences are append-only and a
    // committed envelope's `workflowId` never changes — so this is always
    // genuine corruption, unlike a missing record.
    throw new PersistedDataCorruptError(eventKey);
  }
  return decoded;
}

function decodeCursorOrThrow(cursor: Cursor): number {
  const sequence = decodeCursor(cursor);
  if (sequence === null) throw new Error('Invalid cursor');
  return sequence;
}

function createGapEnvelope(
  sequence: number,
  requestedCursor: Cursor,
  firstRetainedSequence: number,
): FleetEventEnvelope {
  return {
    kind: 'fleet:gap',
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: 0,
    payload: { requestedCursor, firstRetainedSequence },
  };
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function createFleetEventEnvelope(event: FleetEventInput, sequence: number): FleetEventEnvelope {
  return {
    kind: event.kind,
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: event.emittedAtMs,
    ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
    payload: event.payload,
  };
}

function createFleetEventOperations(
  envelope: FleetEventEnvelope,
  callerOperations: readonly BatchOperation[],
): BatchOperation[] {
  return [
    ...callerOperations,
    { type: 'put', key: KEYS.fleetEvent(envelope.sequence), value: encode(envelope) },
    { type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence: envelope.sequence }) },
    ...(envelope.workflowId === undefined
      ? []
      : [
          {
            type: 'put' as const,
            key: KEYS.fleetEventByWorkflow(envelope.workflowId, envelope.sequence),
            value: new Uint8Array(),
          },
        ]),
  ];
}

function validateRetentionOptions(options: { beforeSequence: number; limit?: number }): void {
  if (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 0) {
    throw new RangeError('Fleet event retention sequence must be a non-negative safe integer.');
  }
  const limit = options.limit ?? DEFAULT_RETENTION_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Fleet event retention limit must be positive.');
  }
}

async function collectRetentionRecords(
  storage: Storage,
  target: number,
  limit: number,
): Promise<Array<{ key: string; sequence: number; workflowId?: string }>> {
  const records: Array<{ key: string; sequence: number; workflowId?: string }> = [];
  for await (const [key, value] of storage.scan(KEYS.fleetEventPrefix(), {
    lt: KEYS.fleetEvent(target),
    limit,
  })) {
    const sequence = parseFleetEventSequenceFromKey(key);
    if (sequence === null) throw new PersistedDataCorruptError(key);
    if (sequence < target) {
      const envelope = decodeStorageValue(value, key);
      if (!isFleetEventEnvelope(envelope) || envelope.sequence !== sequence) {
        throw new PersistedDataCorruptError(key);
      }
      records.push({
        key,
        sequence,
        ...(envelope.workflowId === undefined ? {} : { workflowId: envelope.workflowId }),
      });
    }
  }
  return records;
}

function decodeRetentionFloorOrThrow(value: Uint8Array | null): number {
  if (value === null) return 0;
  const decoded = decodeStorageValue(value, KEYS.fleetEventWatermark());
  if (!isFloorRecord(decoded)) throw new PersistedDataCorruptError(KEYS.fleetEventWatermark());
  return decoded.firstRetainedSequence;
}

function decodeStorageValue(value: Uint8Array, key: string): unknown {
  try {
    return decode(value);
  } catch {
    throw new PersistedDataCorruptError(key);
  }
}

function decodeTailOrThrow(value: Uint8Array): number {
  const decoded = decodeStorageValue(value, KEYS.fleetEventTail());
  if (!isTailRecord(decoded)) throw new PersistedDataCorruptError(KEYS.fleetEventTail());
  return decoded.sequence;
}

async function highestFleetEventSequence(storage: Storage): Promise<number> {
  for await (const [key] of storage.scan(KEYS.fleetEventPrefix(), { reverse: true, limit: 1 })) {
    const sequence = parseFleetEventSequenceFromKey(key);
    if (sequence === null) throw new PersistedDataCorruptError(key);
    return sequence;
  }
  return -1;
}

function parseFleetEventSequenceFromKey(key: string): number | null {
  if (!key.startsWith(KEYS.fleetEventPrefix())) return null;
  const rawSequence = key.slice(KEYS.fleetEventPrefix().length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function parseFleetEventByWorkflowSequenceFromKey(workflowId: string, key: string): number | null {
  const prefix = KEYS.fleetEventByWorkflowPrefix(workflowId);
  if (!key.startsWith(prefix)) return null;
  const rawSequence = key.slice(prefix.length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function isTailRecord(value: unknown): value is { sequence: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sequence' in value &&
    Number.isSafeInteger(value.sequence)
  );
}

function isFloorRecord(value: unknown): value is { firstRetainedSequence: number } {
  if (typeof value !== 'object' || value === null) return false;
  const firstRetainedSequence = (value as Record<string, unknown>)['firstRetainedSequence'];
  return Number.isSafeInteger(firstRetainedSequence) && (firstRetainedSequence as number) >= 0;
}

function isFleetEventEnvelope(value: unknown): value is FleetEventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['kind'] === 'string' &&
    Number.isSafeInteger(record['sequence']) &&
    typeof record['cursor'] === 'string' &&
    decodeCursor(record['cursor']) === record['sequence'] &&
    Number.isFinite(record['emittedAtMs']) &&
    (record['workflowId'] === undefined || typeof record['workflowId'] === 'string') &&
    Object.hasOwn(record, 'payload')
  );
}
