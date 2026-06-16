import { decode, encode } from '../core/codec.ts';
import { KEYS, type Storage } from '../storage/interface.ts';
import {
  decodeCursor,
  encodeCursor,
  type Cursor,
  type FeedEventKind,
} from './workflow-event-feed.ts';

export type FleetEventEnvelope = {
  readonly kind: FeedEventKind;
  readonly workflowId?: string;
  readonly sequence: number;
  readonly cursor: Cursor;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

export type FleetEventInput = {
  readonly kind: FeedEventKind;
  readonly workflowId?: string;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

export type FleetEventFeed = {
  append(event: FleetEventInput): Promise<FleetEventEnvelope>;
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<FleetEventEnvelope>;
  subscribe(options?: {
    fromCursor?: Cursor;
    signal?: AbortSignal;
  }): AsyncIterable<FleetEventEnvelope>;
  snapshotTailSequence(): Promise<number>;
  dispose(): void;
};

const DEFAULT_LIVE_BUFFER_SIZE = 1000;

export function createFleetEventFeed(
  storage: Storage,
  feedOptions?: { liveBufferSize?: number },
): FleetEventFeed {
  const liveBufferSize = feedOptions?.liveBufferSize ?? DEFAULT_LIVE_BUFFER_SIZE;
  const listeners = new Set<(envelope: FleetEventEnvelope) => void>();
  let sequenceInitPromise: Promise<number> | null = null;
  let nextSequence: number | null = null;
  let appendChain = Promise.resolve();

  async function initializeNextSequence(): Promise<number> {
    if (nextSequence !== null) return nextSequence;
    if (sequenceInitPromise) return sequenceInitPromise;

    sequenceInitPromise = (async () => {
      const storedTail = await storage.get(KEYS.fleetEventTail());
      if (storedTail !== null) {
        const decodedTail = decode(storedTail);
        if (isTailRecord(decodedTail)) {
          nextSequence = decodedTail.sequence + 1;
          return nextSequence;
        }
      }

      let highestSequence = -1;
      for await (const [key] of storage.scan(KEYS.fleetEventPrefix(), {
        reverse: true,
        limit: 50,
      })) {
        const sequence = parseFleetEventSequenceFromKey(key);
        if (sequence !== null && sequence > highestSequence) {
          highestSequence = sequence;
          break;
        }
      }
      nextSequence = highestSequence + 1;
      return nextSequence;
    })().catch((error) => {
      sequenceInitPromise = null;
      throw error;
    });

    return sequenceInitPromise;
  }

  async function append(event: FleetEventInput): Promise<FleetEventEnvelope> {
    const appended = appendChain.then(async () => {
      const sequence = await initializeNextSequence();
      nextSequence = sequence + 1;
      const envelope: FleetEventEnvelope = {
        kind: event.kind,
        sequence,
        cursor: encodeCursor(sequence),
        emittedAtMs: event.emittedAtMs,
        ...(event.workflowId !== undefined ? { workflowId: event.workflowId } : {}),
        payload: event.payload,
      };

      await storage.batch([
        { type: 'put', key: KEYS.fleetEvent(sequence), value: encode(envelope) },
        { type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence }) },
      ]);
      fireLive(envelope);
      return envelope;
    });

    appendChain = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  async function* replay(replayOptions?: {
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<FleetEventEnvelope> {
    const afterSequence =
      replayOptions?.fromCursor !== undefined ? (decodeCursor(replayOptions.fromCursor) ?? -1) : -1;
    let yielded = 0;
    for await (const [key, value] of storage.scan(KEYS.fleetEventPrefix())) {
      if (hasReachedLimit(yielded, replayOptions?.limit)) return;
      const sequence = parseFleetEventSequenceFromKey(key);
      const decoded = decode(value);
      if (!shouldReplayFleetEvent(sequence, afterSequence, decoded)) continue;
      yield decoded;
      yielded += 1;
    }
  }

  async function snapshotTailSequence(): Promise<number> {
    const storedTail = await storage.get(KEYS.fleetEventTail());
    if (storedTail === null) return -1;
    const decodedTail = decode(storedTail);
    return isTailRecord(decodedTail) ? decodedTail.sequence : -1;
  }

  function subscribe(subscribeOptions?: {
    fromCursor?: Cursor;
    signal?: AbortSignal;
  }): AsyncIterable<FleetEventEnvelope> {
    const buffer: FleetEventEnvelope[] = [];
    let bufferOverflowed = false;
    let waker: (() => void) | null = null;

    const unsubscribe = subscribeLive((envelope) => {
      if (buffer.length >= liveBufferSize) {
        bufferOverflowed = true;
      } else {
        buffer.push(envelope);
      }
      if (waker) {
        const fire = waker;
        waker = null;
        fire();
      }
    });

    const onAbort = () => {
      if (waker) {
        const fire = waker;
        waker = null;
        fire();
      }
    };
    const signal = subscribeOptions?.signal;
    const fromCursor = subscribeOptions?.fromCursor;
    signal?.addEventListener('abort', onAbort);

    async function* generator(): AsyncIterable<FleetEventEnvelope> {
      try {
        yield* streamSubscription(
          fromCursor,
          signal,
          buffer,
          () => bufferOverflowed,
          (w) => {
            waker = w;
          },
        );
      } finally {
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
      }
    }

    return generator();
  }

  async function* streamSubscription(
    fromCursor: Cursor | undefined,
    signal: AbortSignal | undefined,
    buffer: FleetEventEnvelope[],
    overflowed: () => boolean,
    installWaker: (fn: (() => void) | null) => void,
  ): AsyncIterable<FleetEventEnvelope> {
    if (signal?.aborted) return;
    const snapshot = await snapshotTailSequence();
    const requestedAfter = fromCursor !== undefined ? (decodeCursor(fromCursor) ?? -1) : -1;

    yield* replaySnapshot(requestedAfter, snapshot, signal);
    if (signal?.aborted) return;
    yield* drainLive(buffer, snapshot, signal, overflowed, installWaker);
  }

  async function* replayUpTo(
    afterSequence: number,
    snapshot: number,
    signal: AbortSignal | undefined,
  ): AsyncIterable<FleetEventEnvelope> {
    for await (const envelope of replay({ fromCursor: encodeInitialCursor(afterSequence) })) {
      if (envelope.sequence > snapshot) break;
      if (signal?.aborted) return;
      yield envelope;
    }
  }

  async function* replaySnapshot(
    requestedAfter: number,
    snapshot: number,
    signal: AbortSignal | undefined,
  ): AsyncIterable<FleetEventEnvelope> {
    if (snapshot <= requestedAfter) return;
    yield* replayUpTo(requestedAfter, snapshot, signal);
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
    replay,
    subscribe,
    snapshotTailSequence,
    dispose() {
      listeners.clear();
    },
  };
}

async function* drainLive(
  buffer: FleetEventEnvelope[],
  snapshot: number,
  signal: AbortSignal | undefined,
  overflowed: () => boolean,
  installWaker: (fn: (() => void) | null) => void,
): AsyncIterable<FleetEventEnvelope> {
  let watermark = snapshot;
  while (true) {
    if (shouldStopLiveDrain(signal, overflowed)) return;
    const { batch, nextWatermark } = takeLiveBatch(buffer, watermark);
    watermark = nextWatermark;
    for (const envelope of batch) {
      if (shouldStopLiveDrain(signal, overflowed)) return;
      yield envelope;
    }
    if (batch.length > 0) continue;
    await armAndWait(buffer, overflowed, signal, installWaker);
  }
}

async function armAndWait(
  buffer: FleetEventEnvelope[],
  overflowed: () => boolean,
  signal: AbortSignal | undefined,
  installWaker: (fn: (() => void) | null) => void,
): Promise<void> {
  const armed = new Promise<void>((resolve) => {
    installWaker(resolve);
  });
  if (buffer.length > 0 || overflowed() || signal?.aborted) {
    installWaker(null);
    return;
  }
  await armed;
}

function hasReachedLimit(yielded: number, limit: number | undefined): boolean {
  return limit !== undefined && yielded >= limit;
}

function shouldReplayFleetEvent(
  sequence: number | null,
  afterSequence: number,
  decoded: unknown,
): decoded is FleetEventEnvelope {
  return sequence !== null && sequence > afterSequence && isFleetEventEnvelope(decoded);
}

function shouldStopLiveDrain(signal: AbortSignal | undefined, overflowed: () => boolean): boolean {
  return signal?.aborted === true || overflowed();
}

function takeLiveBatch(
  buffer: FleetEventEnvelope[],
  watermark: number,
): { batch: FleetEventEnvelope[]; nextWatermark: number } {
  const batch: FleetEventEnvelope[] = [];
  let nextWatermark = watermark;
  let head = buffer.shift();
  while (head !== undefined) {
    if (head.sequence > nextWatermark) {
      batch.push(head);
      nextWatermark = head.sequence;
    }
    head = buffer.shift();
  }
  return { batch, nextWatermark };
}

function encodeInitialCursor(sequence: number): Cursor {
  return sequence < 0 ? '-1' : encodeCursor(sequence);
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
    Number.isFinite(record['emittedAtMs']) &&
    (record['workflowId'] === undefined || typeof record['workflowId'] === 'string') &&
    Object.hasOwn(record, 'payload')
  );
}
