import type { WeftEventMap } from '../core/events.ts';

/** Discriminator string carried on every feed envelope. */
export type FeedEventKind =
  | keyof WeftEventMap
  | 'workflow:checkpoint'
  | 'stream:chunk'
  // The `& {}` trick preserves literal autocompletion while keeping
  // the union open — without it, TypeScript widens `FeedEventKind`
  // to `string` in most contexts and the literals disappear from
  // completion lists.
  | (string & {});

// ---------------------------------------------------------------------------
// Cursor (opaque)
// ---------------------------------------------------------------------------

/** Opaque cursor. Only `encodeCursor` / `decodeCursor` know the format. */
export type Cursor = string;

const CURSOR_PATTERN = /^(?:-1|\d+)$/;

/** Encode a non-negative integer sequence as an opaque cursor. */
export function encodeCursor(sequence: number): Cursor {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`encodeCursor: sequence must be a non-negative integer, got ${sequence}`);
  }
  return String(sequence);
}

/**
 * Decode an opaque cursor back to its sequence. `-1` is the initial
 * sentinel for "before the first event"; malformed input returns null.
 */
export function decodeCursor(cursor: Cursor): number | null {
  if (!CURSOR_PATTERN.test(cursor)) return null;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < -1) return null;
  return value;
}

function decodeCursorOrThrow(cursor: Cursor): number {
  const sequence = decodeCursor(cursor);
  if (sequence === null) throw new Error('Invalid cursor');
  return sequence;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type EventSelector = 'events' | 'tokens';

export type EventEnvelope = {
  readonly kind: FeedEventKind;
  readonly workflowId: string;
  readonly selector: EventSelector;
  readonly sequence: number;
  readonly cursor: Cursor;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export type WorkflowEventFeedBackend = {
  replay(options: {
    workflowId: string;
    selector: EventSelector;
    afterSequence: number;
  }): AsyncIterable<EventEnvelope>;

  snapshotTailSequence(workflowId: string, selector: EventSelector): Promise<number>;

  subscribeLive(
    workflowId: string,
    selector: EventSelector,
    listener: (envelope: EventEnvelope) => void,
  ): () => void;
};

// ---------------------------------------------------------------------------
// Feed contract
// ---------------------------------------------------------------------------

export type WorkflowEventFeed = {
  replay(options: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<EventEnvelope>;

  subscribe(
    options: {
      workflowId: string;
      selector: EventSelector;
    } & ReplayLiveSubscribeOptions<EventEnvelope>,
  ): AsyncIterable<EventEnvelope>;

  dispose(): void;
};

export type WorkflowEventFeedOptions = {
  /** Max envelopes the live buffer holds before overflow terminates the subscription. */
  liveBufferSize?: number;
};

export type SequencedEventEnvelope = {
  readonly sequence: number;
  readonly cursor: Cursor;
};

export type ReplayLiveFeedBackend<TEnvelope extends SequencedEventEnvelope> = {
  replay(options: { afterSequence: number }): AsyncIterable<TEnvelope>;
  snapshotTailSequence(): Promise<number>;
  subscribeLive(listener: (envelope: TEnvelope) => void): () => void;
};

export type ReplayLiveFeed<TEnvelope extends SequencedEventEnvelope> = {
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<TEnvelope>;
  subscribe(options?: ReplayLiveSubscribeOptions<TEnvelope>): AsyncIterable<TEnvelope>;
  dispose(): void;
};

export type ReplayLiveSubscribeOptions<TEnvelope extends SequencedEventEnvelope> = {
  fromCursor?: Cursor;
  signal?: AbortSignal;
  replayLimit?: number;
  filterEnvelope?: (envelope: TEnvelope) => boolean;
  countReplayEnvelope?: (envelope: TEnvelope) => boolean;
  createReplayLimitError?: (count: number, limit: number) => unknown;
};

export class ReplayWindowExceededError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(`Replay window is ${count} events; maximum is ${limit}.`);
    this.name = 'ReplayWindowExceededError';
  }
}

const DEFAULT_LIVE_BUFFER_SIZE = 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createReplayLiveFeed<TEnvelope extends SequencedEventEnvelope>(
  backend: ReplayLiveFeedBackend<TEnvelope>,
  options?: WorkflowEventFeedOptions,
): ReplayLiveFeed<TEnvelope> {
  const bufferSize = options?.liveBufferSize ?? DEFAULT_LIVE_BUFFER_SIZE;

  async function* replay(args?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<TEnvelope> {
    const afterSequence =
      args?.fromCursor !== undefined ? decodeCursorOrThrow(args.fromCursor) : -1;
    let yielded = 0;
    for await (const envelope of backend.replay({ afterSequence })) {
      if (args?.limit !== undefined && yielded >= args.limit) return;
      yield envelope;
      yielded += 1;
    }
  }

  function subscribe(args?: ReplayLiveSubscribeOptions<TEnvelope>): AsyncIterable<TEnvelope> {
    const buffer: TEnvelope[] = [];
    let bufferOverflowed = false;
    let waker: (() => void) | null = null;
    const signal = args?.signal;
    const fromCursor = args?.fromCursor;
    const requestedAfter = fromCursor !== undefined ? decodeCursorOrThrow(fromCursor) : -1;

    const unsubscribe = backend.subscribeLive((envelope) => {
      if (!shouldDeliverEnvelope(envelope, args)) return;
      if (buffer.length >= bufferSize) {
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
    signal?.addEventListener('abort', onAbort);

    async function* generator(): AsyncIterable<TEnvelope> {
      try {
        if (signal?.aborted) return;

        const snapshot = await backend.snapshotTailSequence();
        yield* replayUpTo(backend, requestedAfter, snapshot, signal, args);
        if (signal?.aborted) return;
        yield* drainLive(
          buffer,
          snapshot,
          signal,
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

  return {
    replay,
    subscribe,
    dispose() {
      /* in-memory feed holds no feed-level state; no-op. */
    },
  };
}

export function createWorkflowEventFeed(
  backend: WorkflowEventFeedBackend,
  options?: WorkflowEventFeedOptions,
): WorkflowEventFeed {
  function createScopedFeed(
    workflowId: string,
    selector: EventSelector,
  ): ReplayLiveFeed<EventEnvelope> {
    return createReplayLiveFeed<EventEnvelope>(
      {
        replay: ({ afterSequence }) => backend.replay({ workflowId, selector, afterSequence }),
        snapshotTailSequence: () => backend.snapshotTailSequence(workflowId, selector),
        subscribeLive: (listener) => backend.subscribeLive(workflowId, selector, listener),
      },
      options,
    );
  }

  async function* replay(args: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<EventEnvelope> {
    const replayOptions: { fromCursor?: Cursor; limit?: number } = {};
    if (args.fromCursor !== undefined) replayOptions.fromCursor = args.fromCursor;
    if (args.limit !== undefined) replayOptions.limit = args.limit;
    yield* createScopedFeed(args.workflowId, args.selector).replay(replayOptions);
  }

  function subscribe(args: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    signal?: AbortSignal;
    replayLimit?: number;
    filterEnvelope?: (envelope: EventEnvelope) => boolean;
    countReplayEnvelope?: (envelope: EventEnvelope) => boolean;
    createReplayLimitError?: (count: number, limit: number) => unknown;
  }): AsyncIterable<EventEnvelope> {
    const subscribeOptions: ReplayLiveSubscribeOptions<EventEnvelope> = {};
    if (args.fromCursor !== undefined) subscribeOptions.fromCursor = args.fromCursor;
    if (args.signal !== undefined) subscribeOptions.signal = args.signal;
    if (args.replayLimit !== undefined) subscribeOptions.replayLimit = args.replayLimit;
    if (args.filterEnvelope !== undefined) {
      subscribeOptions.filterEnvelope = args.filterEnvelope;
    }
    if (args.countReplayEnvelope !== undefined) {
      subscribeOptions.countReplayEnvelope = args.countReplayEnvelope;
    }
    if (args.createReplayLimitError !== undefined) {
      subscribeOptions.createReplayLimitError = args.createReplayLimitError;
    }
    return createScopedFeed(args.workflowId, args.selector).subscribe(subscribeOptions);
  }

  return {
    replay,
    subscribe,
    dispose() {
      /* in-memory feed holds no feed-level state; no-op. */
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory backend (for tests + local development)
// ---------------------------------------------------------------------------

export type InMemoryEventBackend = WorkflowEventFeedBackend & {
  append(envelope: EventEnvelope): Promise<void>;
  emitLive(envelope: EventEnvelope): Promise<void>;
};

async function* replayUpTo<TEnvelope extends SequencedEventEnvelope>(
  backend: ReplayLiveFeedBackend<TEnvelope>,
  afterSequence: number,
  snapshot: number,
  signal: AbortSignal | undefined,
  replayOptions: ReplayLiveSubscribeOptions<TEnvelope> | undefined,
): AsyncIterable<TEnvelope> {
  let replayCount = 0;
  for await (const envelope of backend.replay({ afterSequence })) {
    if (envelope.sequence > snapshot) break;
    if (signal?.aborted) return;
    if (!shouldDeliverEnvelope(envelope, replayOptions)) continue;
    if (shouldCountReplayEnvelope(envelope, replayOptions)) {
      replayCount += 1;
      const replayLimit = replayOptions?.replayLimit;
      if (replayLimit !== undefined && replayCount > replayLimit) {
        throw createReplayLimitError(replayOptions, replayCount, replayLimit);
      }
    }
    yield envelope;
  }
}

function shouldDeliverEnvelope<TEnvelope extends SequencedEventEnvelope>(
  envelope: TEnvelope,
  replayOptions: ReplayLiveSubscribeOptions<TEnvelope> | undefined,
): boolean {
  return replayOptions?.filterEnvelope?.(envelope) ?? true;
}

function shouldCountReplayEnvelope<TEnvelope extends SequencedEventEnvelope>(
  envelope: TEnvelope,
  replayOptions: ReplayLiveSubscribeOptions<TEnvelope> | undefined,
): boolean {
  return replayOptions?.countReplayEnvelope?.(envelope) ?? true;
}

function createReplayLimitError<TEnvelope extends SequencedEventEnvelope>(
  replayOptions: ReplayLiveSubscribeOptions<TEnvelope> | undefined,
  count: number,
  limit: number,
): unknown {
  return (
    replayOptions?.createReplayLimitError?.(count, limit) ??
    new ReplayWindowExceededError(count, limit)
  );
}

function flushPendingBuffer<TEnvelope extends SequencedEventEnvelope>(
  buffer: TEnvelope[],
  watermark: number,
): { batch: TEnvelope[]; newWatermark: number } {
  const batch: TEnvelope[] = [];
  let newWatermark = watermark;
  let head = buffer.shift();
  while (head !== undefined) {
    if (head.sequence > newWatermark) {
      batch.push(head);
      newWatermark = head.sequence;
    }
    head = buffer.shift();
  }
  return { batch, newWatermark };
}

async function armAndWait<TEnvelope extends SequencedEventEnvelope>(
  buffer: TEnvelope[],
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

async function* drainLive<TEnvelope extends SequencedEventEnvelope>(
  buffer: TEnvelope[],
  snapshot: number,
  signal: AbortSignal | undefined,
  overflowed: () => boolean,
  installWaker: (fn: (() => void) | null) => void,
): AsyncIterable<TEnvelope> {
  let watermark = snapshot;
  while (true) {
    if (signal?.aborted || overflowed()) break;
    const { batch, newWatermark } = flushPendingBuffer(buffer, watermark);
    watermark = newWatermark;
    for (const envelope of batch) {
      if (signal?.aborted || overflowed()) return;
      yield envelope;
    }
    if (batch.length > 0) continue;
    await armAndWait(buffer, overflowed, signal, installWaker);
  }
}

function bucketKey(workflowId: string, selector: EventSelector): string {
  return `${workflowId}:${selector}`;
}

export function createInMemoryEventBackend(): InMemoryEventBackend {
  const storage = new Map<string, EventEnvelope[]>();
  const listeners = new Map<string, Set<(envelope: EventEnvelope) => void>>();

  function fireLive(envelope: EventEnvelope): void {
    const set = listeners.get(bucketKey(envelope.workflowId, envelope.selector));
    if (!set) return;
    for (const listener of set) {
      try {
        listener(envelope);
      } catch {
        // Listener errors must not corrupt the producer.
      }
    }
  }

  return {
    async *replay(options) {
      const bucket = storage.get(bucketKey(options.workflowId, options.selector));
      if (!bucket) return;
      // Always scan in sequence order, regardless of append order.
      const sorted = [...bucket].toSorted((a, b) => a.sequence - b.sequence);
      for (const envelope of sorted) {
        if (envelope.sequence > options.afterSequence) {
          yield envelope;
        }
      }
    },

    async snapshotTailSequence(workflowId, selector) {
      const bucket = storage.get(bucketKey(workflowId, selector));
      if (!bucket || bucket.length === 0) return -1;
      let max = -1;
      for (const envelope of bucket) {
        if (envelope.sequence > max) max = envelope.sequence;
      }
      return max;
    },

    subscribeLive(workflowId, selector, listener) {
      const k = bucketKey(workflowId, selector);
      let set = listeners.get(k);
      if (!set) {
        set = new Set();
        listeners.set(k, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) listeners.delete(k);
      };
    },

    async append(envelope) {
      const k = bucketKey(envelope.workflowId, envelope.selector);
      let bucket = storage.get(k);
      if (!bucket) {
        bucket = [];
        storage.set(k, bucket);
      }
      bucket.push(envelope);
      fireLive(envelope);
    },

    async emitLive(envelope) {
      fireLive(envelope);
    },
  };
}
