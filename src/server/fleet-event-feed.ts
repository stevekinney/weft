import { decode, encode } from '../core/codec.ts';
import { KEYS, type BatchOperation, type Storage } from '../storage/interface.ts';
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

export type FleetEventFeed = {
  append(event: FleetEventInput): Promise<FleetEventEnvelope>;
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<FleetEventEnvelope>;
  subscribe(
    options?: ReplayLiveSubscribeOptions<FleetEventEnvelope>,
  ): AsyncIterable<FleetEventEnvelope>;
  snapshotTailSequence(): Promise<number>;
  dispose(): void;
};

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
    const appended = appendChain.then(async () => {
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

      await storage.batch(operations);
      nextSequence = sequence + 1;
      fireLive(envelope);
      return envelope;
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
