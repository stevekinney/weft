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
import { createDurableSubscription } from './replay-live-feed-internals.ts';
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
 * import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft/server/handler';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const fleetEventFeed: FleetEventFeed = createFleetEventFeed(engine.storage);
 * void fleetEventFeed;
 * ```
 */
export type FleetEventFeed = {
  append(event: FleetEventInput, options?: FleetEventAppendOptions): Promise<FleetEventEnvelope>;
  appendWorkflowEventIfPresent(event: FleetWorkflowEventInput): Promise<FleetEventEnvelope | null>;
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<FleetEventEnvelope>;
  subscribe(
    options?: ReplayLiveSubscribeOptions<FleetEventEnvelope>,
  ): AsyncIterable<FleetEventEnvelope>;
  snapshotTailSequence(): Promise<number>;
  snapshotRetentionFloor(): Promise<number>;
  retain(options: { beforeSequence: number; limit?: number }): Promise<number>;
  dispose(): void;
};

const DEFAULT_RETENTION_BATCH_SIZE = 100;

/**
 * Build a `FleetEventFeed` backed by the given `Storage` — typically
 * `engine.storage`. Pass the result as `HandlerOptions.fleetEventFeed` to
 * drive `/v1/events/sse` through `handleRequest()` directly, without
 * `serve()`. Call once per storage instance and share the returned feed
 * across every transport that needs it.
 *
 * This feed does not subscribe to `Engine` events on its own. `serve()` bridges
 * engine lifecycle events into it; a direct `handleRequest()` host must append
 * the events it wants `/v1/events/sse` to carry.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import {
 *   createFleetEventFeed,
 *   handleRequest,
 *   type HandlerOptions,
 * } from '@lostgradient/weft/server/handler';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const fleetEventFeed = createFleetEventFeed(engine.storage);
 * const options: HandlerOptions = { fleetEventFeed };
 *
 * async function handleFleetEventsSse(request: Request): Promise<Response> {
 *   return handleRequest(request, engine, options);
 * }
 * void handleFleetEventsSse;
 * ```
 */
export function createFleetEventFeed(
  storage: Storage,
  feedOptions?: FleetEventFeedOptions,
): FleetEventFeed {
  const liveBufferSize = feedOptions?.liveBufferSize ?? 1000;
  const livePollIntervalMs = feedOptions?.livePollIntervalMs ?? 100;
  if (!Number.isSafeInteger(liveBufferSize) || liveBufferSize < 1) {
    throw new RangeError('Fleet event live buffer size must be positive.');
  }
  if (!Number.isSafeInteger(livePollIntervalMs) || livePollIntervalMs < 1) {
    throw new RangeError('Fleet event live poll interval must be positive.');
  }
  const listeners = new Set<(envelope: FleetEventEnvelope) => void>();
  const disposalController = new AbortController();

  const backend: ReplayLiveFeedBackend<FleetEventEnvelope> = {
    replay: replayPersistedFleetEvents,
    snapshotTailSequence,
    subscribeLive,
  };
  const replayLiveFeed: ReplayLiveFeed<FleetEventEnvelope> = createReplayLiveFeed(
    backend,
    feedOptions,
  );

  async function append(
    event: FleetEventInput,
    options?: FleetEventAppendOptions,
  ): Promise<FleetEventEnvelope> {
    const appended = await appendInternal(
      event,
      async () => options?.conditions ?? [],
      options?.operations ?? [],
    );
    if (appended === null)
      throw new Error('Fleet event append conditions unexpectedly disappeared.');
    return appended;
  }

  async function appendWorkflowEventIfPresent(
    event: FleetWorkflowEventInput,
  ): Promise<FleetEventEnvelope | null> {
    return appendInternal(
      event,
      async () => {
        const workflowValue = await storage.get(KEYS.workflow(event.workflowId));
        if (workflowValue === null) return null;
        return [{ key: KEYS.workflow(event.workflowId), expectedValue: workflowValue }];
      },
      [],
      25,
    );
  }

  function appendInternal(event: FleetEventInput): Promise<FleetEventEnvelope>;
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
  }): AsyncIterable<FleetEventEnvelope> {
    const { floor, envelopes } = await loadConsistentReplay(storage, options.afterSequence);
    if (options.afterSequence < floor - 1) {
      yield {
        kind: 'fleet:gap',
        sequence: floor - 1,
        cursor: encodeCursor(floor - 1),
        emittedAtMs: 0,
        payload: {
          requestedCursor: options.afterSequence < 0 ? '-1' : encodeCursor(options.afterSequence),
          firstRetainedSequence: floor,
        },
      };
    }
    yield* envelopes;
  }

  async function snapshotTailSequence(): Promise<number> {
    const storedTail = await storage.get(KEYS.fleetEventTail());
    const decodedTail =
      storedTail === null ? null : decodeStorageValue(storedTail, KEYS.fleetEventTail());
    if (storedTail !== null && !isTailRecord(decodedTail))
      throw new PersistedDataCorruptError(KEYS.fleetEventTail());
    if (isTailRecord(decodedTail)) return decodedTail.sequence;

    for await (const [key] of storage.scan(KEYS.fleetEventPrefix(), { reverse: true })) {
      const sequence = parseFleetEventSequenceFromKey(key);
      if (sequence !== null) return sequence;
      throw new PersistedDataCorruptError(key);
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
    return committed ? recordsToDelete.length : 0;
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
    replay: (options) => replayLiveFeed.replay(options),
    subscribe: (options) =>
      createDurableSubscription(
        backend,
        {
          liveBufferSize,
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
  const tail =
    tailValue === null ? await requireEmptyFleetHistory(storage) : decodeTailOrThrow(tailValue);
  const highest = await highestFleetEventSequence(storage);
  if (highest > tail) {
    const refreshedTailValue = await storage.get(KEYS.fleetEventTail());
    if (!bytesEqual(refreshedTailValue, tailValue)) return null;
    throw new PersistedDataCorruptError(KEYS.fleetEventTail());
  }
  return { tail, tailValue };
}

async function loadConsistentReplay(
  storage: Storage,
  afterSequence: number,
): Promise<{ floor: number; envelopes: FleetEventEnvelope[] }> {
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const floorValue = await storage.get(KEYS.fleetEventWatermark());
    const floor = decodeRetentionFloorOrThrow(floorValue);
    const envelopes: FleetEventEnvelope[] = [];
    const scanOptions = afterSequence >= 0 ? { gt: KEYS.fleetEvent(afterSequence) } : undefined;
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

async function requireEmptyFleetHistory(storage: Storage): Promise<number> {
  for await (const [key] of storage.scan(KEYS.fleetEventPrefix(), { reverse: true, limit: 1 })) {
    if (parseFleetEventSequenceFromKey(key) === null) throw new PersistedDataCorruptError(key);
    throw new PersistedDataCorruptError(KEYS.fleetEventTail());
  }
  return -1;
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
