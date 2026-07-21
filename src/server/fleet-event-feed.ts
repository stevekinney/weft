import { decode, encode } from '../core/codec.ts';
import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from '../storage/interface.ts';
import {
  createReplayLiveFeed,
  decodeCursor,
  encodeCursor,
  type Cursor,
  type FeedEventKind,
  type ReplayLiveFeed,
  type ReplayLiveFeedBackend,
  type ReplayLiveSubscribeOptions,
  type WorkflowEventFeedOptions,
} from './workflow-event-feed.ts';

/**
 * A single committed record from the fleet-wide event feed — cross-workflow
 * lifecycle and system events, optionally scoped to one `workflowId`.
 * Returned by `FleetEventFeed.replay()` / `FleetEventFeed.subscribe()`, and
 * consumed directly by the `/v1/events/sse` REST route.
 *
 * @example
 * ```ts
 * import type { FleetEventEnvelope } from '@lostgradient/weft/server/handler';
 *
 * declare const envelope: FleetEventEnvelope;
 * console.log(envelope.kind); // e.g. 'workflow:completed'
 * console.log(envelope.workflowId); // string | undefined
 * ```
 */
export type FleetEventEnvelope = {
  readonly kind: FeedEventKind;
  readonly workflowId?: string | undefined;
  readonly sequence: number;
  readonly cursor: Cursor;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

export type FleetEventInput = {
  readonly kind: FeedEventKind;
  readonly workflowId?: string | undefined;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

export type FleetWorkflowEventInput = FleetEventInput & {
  readonly workflowId: string;
};

/**
 * The fleet-wide event feed: append cross-workflow events, replay committed
 * history from a cursor, then subscribe for live delivery. This is the shape
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
  append(event: FleetEventInput): Promise<FleetEventEnvelope>;
  appendWorkflowEventIfPresent(event: FleetWorkflowEventInput): Promise<FleetEventEnvelope | null>;
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<FleetEventEnvelope>;
  subscribe(
    options?: ReplayLiveSubscribeOptions<FleetEventEnvelope>,
  ): AsyncIterable<FleetEventEnvelope>;
  snapshotTailSequence(): Promise<number>;
  dispose(): void;
};

const MAX_WORKFLOW_OWNED_APPEND_ATTEMPTS = 5;

/**
 * Build a `FleetEventFeed` backed by the given `Storage` — typically
 * `engine.storage`. Pass the result as `HandlerOptions.fleetEventFeed` to
 * drive `/v1/events/sse` through `handleRequest()` directly, without
 * `serve()`. Call once per storage instance and share the returned feed
 * across every transport that needs it.
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
  feedOptions?: WorkflowEventFeedOptions,
): FleetEventFeed {
  const listeners = new Set<(envelope: FleetEventEnvelope) => void>();
  let sequenceInitPromise: Promise<number> | null = null;
  let nextSequence: number | null = null;
  // Current durable recovery supports one server process per durable store.
  // Multi-process fleet feeds need a conditional storage allocator here.
  let appendChain = Promise.resolve();

  const backend: ReplayLiveFeedBackend<FleetEventEnvelope> = {
    replay: replayPersistedFleetEvents,
    snapshotTailSequence,
    subscribeLive,
  };
  const replayLiveFeed: ReplayLiveFeed<FleetEventEnvelope> = createReplayLiveFeed(
    backend,
    feedOptions,
  );

  async function initializeNextSequence(): Promise<number> {
    if (nextSequence !== null) return nextSequence;
    if (sequenceInitPromise) return sequenceInitPromise;

    sequenceInitPromise = snapshotTailSequence()
      .then((tailSequence) => {
        nextSequence = tailSequence + 1;
        return nextSequence;
      })
      .catch((error) => {
        sequenceInitPromise = null;
        throw error;
      });

    return sequenceInitPromise;
  }

  async function append(event: FleetEventInput): Promise<FleetEventEnvelope> {
    return appendInternal(event);
  }

  async function appendWorkflowEventIfPresent(
    event: FleetWorkflowEventInput,
  ): Promise<FleetEventEnvelope | null> {
    return appendInternal(event, async () => {
      const workflowValue = await storage.get(KEYS.workflow(event.workflowId));
      if (workflowValue === null) return null;
      return [{ key: KEYS.workflow(event.workflowId), expectedValue: workflowValue }];
    });
  }

  function appendInternal(event: FleetEventInput): Promise<FleetEventEnvelope>;
  function appendInternal(
    event: FleetEventInput,
    loadConditions: () => Promise<readonly ConditionalBatchCondition[] | null>,
  ): Promise<FleetEventEnvelope | null>;
  async function appendInternal(
    event: FleetEventInput,
    loadConditions?: () => Promise<readonly ConditionalBatchCondition[] | null>,
  ): Promise<FleetEventEnvelope | null> {
    const appended = appendChain.then(async () => {
      for (let attempt = 1; attempt <= MAX_WORKFLOW_OWNED_APPEND_ATTEMPTS; attempt += 1) {
        const conditions = loadConditions === undefined ? undefined : await loadConditions();
        if (conditions === null) return null;

        const sequence = await initializeNextSequence();
        const envelope: FleetEventEnvelope = {
          kind: event.kind,
          sequence,
          cursor: encodeCursor(sequence),
          emittedAtMs: event.emittedAtMs,
          ...(event.workflowId !== undefined ? { workflowId: event.workflowId } : {}),
          payload: event.payload,
        };

        const operations: BatchOperation[] = [
          { type: 'put', key: KEYS.fleetEvent(sequence), value: encode(envelope) },
          { type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence }) },
        ];
        if (event.workflowId !== undefined) {
          operations.push({
            type: 'put',
            key: KEYS.fleetEventByWorkflow(event.workflowId, sequence),
            value: new Uint8Array(),
          });
        }

        if (conditions === undefined) {
          await storage.batch(operations);
        } else {
          const committed = await storageConditionalBatch(storage, [...conditions], operations);
          if (!committed) continue;
        }
        nextSequence = sequence + 1;
        fireLive(envelope);
        return envelope;
      }

      throw new Error(
        `Fleet event append for workflow "${event.workflowId ?? '<none>'}" lost its storage precondition after ${MAX_WORKFLOW_OWNED_APPEND_ATTEMPTS} attempts.`,
      );
    });

    appendChain = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  async function* replayPersistedFleetEvents(options: {
    afterSequence: number;
  }): AsyncIterable<FleetEventEnvelope> {
    const scanOptions =
      options.afterSequence >= 0 ? { gt: KEYS.fleetEvent(options.afterSequence) } : undefined;
    for await (const [key, value] of storage.scan(KEYS.fleetEventPrefix(), scanOptions)) {
      const sequence = parseFleetEventSequenceFromKey(key);
      if (sequence === null || sequence <= options.afterSequence) continue;
      const decoded = decodeStorageValue(value);
      if (!isFleetEventEnvelope(decoded)) continue;
      yield decoded;
    }
  }

  async function snapshotTailSequence(): Promise<number> {
    const storedTail = await storage.get(KEYS.fleetEventTail());
    const decodedTail = storedTail === null ? null : decodeStorageValue(storedTail);
    if (isTailRecord(decodedTail)) return decodedTail.sequence;

    for await (const [key] of storage.scan(KEYS.fleetEventPrefix(), { reverse: true })) {
      const sequence = parseFleetEventSequenceFromKey(key);
      if (sequence !== null) return sequence;
    }
    return -1;
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
    subscribe: (options) => replayLiveFeed.subscribe(options),
    snapshotTailSequence,
    dispose() {
      listeners.clear();
      replayLiveFeed.dispose();
    },
  };
}

function decodeStorageValue(value: Uint8Array): unknown {
  try {
    return decode(value);
  } catch {
    return null;
  }
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
    Number.isSafeInteger((value as { sequence: unknown }).sequence)
  );
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
