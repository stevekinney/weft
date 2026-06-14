/**
 * `WorkflowEventFeed` — transport-neutral event replay + live-tail
 * contract shared by REST SSE, WebSocket watch/stream, and JSON-RPC
 * subscribe. Track 8 design decision 5 and 6.
 *
 * **Atomic handoff ordering** (the only sequence that avoids both
 * duplicates and gaps when a subscriber joins mid-stream):
 *
 *   1. Register a live listener into a bounded in-memory buffer.
 *      From this moment, every newly-emitted event is captured.
 *   2. Snapshot the current live-tail sequence `S` (read once).
 *   3. Stream storage replay from `fromCursor` up to and including `S`.
 *   4. Drain the buffer, dropping any envelope with `sequence <= S`
 *      (already replayed) and emitting the rest.
 *   5. Continue emitting live envelopes directly as the listener fires.
 *
 * Buffer bound is configurable (default 1000 envelopes per subscription).
 * Overflow closes the subscription with a `SubscriptionOverflow` signal
 * (the iterable terminates; the caller reopens with its last delivered
 * cursor). Unbounded-memory-growth is not an option here.
 *
 * **Cursor is opaque.** `encodeCursor(sequence)` and
 * `decodeCursor(cursor)` are the only code that knows the representation
 * — REST `Last-Event-ID`, WS `?resumeFrom=`, and JSON-RPC `fromCursor`
 * all round-trip through this module.
 */

import type { WeftEventMap } from '../core/events.ts';

/**
 * Discriminator string carried on every envelope. The union covers:
 *
 *   - Dispatched `WeftEventMap` event names (`workflow:started`,
 *     `activity:completed`, `stream:token`, …) — emitted when a
 *     future log entry type corresponds to a runtime `Event`.
 *   - Durable log entry types not in `WeftEventMap`
 *     (`workflow:checkpoint` — the only one today; add others here
 *     as new log kinds land).
 *   - Selector-scoped synthetic kinds (`stream:chunk`) for records
 *     that are not dispatched `Event` objects at all.
 *   - An open `(string & {})` tail so third-party event kinds don't
 *     fail typechecking at the envelope construction site while
 *     IntelliSense still suggests the known literals.
 *
 * Cross-transport consumers match on `selector` first, then on
 * `kind` within that selector. This union is extensible and preserves
 * completion for known kinds, but the open-string tail means it does
 * not by itself reject arbitrary or misspelled string literals.
 */
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

/**
 * Encode a non-negative integer sequence as an opaque cursor. The
 * current encoding is the decimal string form of the sequence, matching
 * the existing `sequence-cursor.ts` public representation so REST
 * `Last-Event-ID` / `?after=` clients continue to work unchanged. The
 * encoding is intentionally not part of the public API — a future change
 * to base64 / hex / compact binary can happen without breaking anything
 * that goes through this module.
 */
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

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type EventSelector = 'events' | 'tokens';

/**
 * Unified event envelope delivered by the feed. Transports serialize
 * this directly (REST SSE `data:` line, WS JSON frame, JSON-RPC
 * `weft.events.deliver` params). `kind` narrows `payload` shape in
 * caller code via discriminated-union typing.
 */
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

/**
 * Pluggable storage + live-event source. The in-memory implementation
 * is used by unit tests; the production implementation wraps
 * `engine.storage` event scans + `EngineEventTarget` subscription.
 */
export type WorkflowEventFeedBackend = {
  /**
   * Yield persisted envelopes with `sequence > afterSequence` in
   * sequence order. `afterSequence: -1` means "from the beginning."
   */
  replay(options: {
    workflowId: string;
    selector: EventSelector;
    afterSequence: number;
  }): AsyncIterable<EventEnvelope>;

  /**
   * Snapshot the current tail sequence for a workflow. Used in the
   * atomic-handoff sequence to bound the replay scan. Returns -1 if
   * no events have been emitted yet.
   */
  snapshotTailSequence(workflowId: string, selector: EventSelector): Promise<number>;

  /**
   * Register a live listener. Returns an unsubscribe function.
   *
   * Contract:
   *   - Envelopes MUST be delivered in monotonically increasing
   *     sequence order. The feed's live-buffer drain relies on this
   *     for its dedupe logic — an out-of-order emission would cause
   *     the feed to advance `lastDelivered` past a later-arriving
   *     lower-sequence event and silently drop it.
   *   - The listener SHOULD be invoked synchronously from the
   *     event-emitter context. Backends that defer to a microtask
   *     (or later) still work correctly because the feed's listener
   *     buffers envelopes off the fast path, but synchronous delivery
   *     minimizes handoff latency.
   *   - Listener exceptions MUST NOT propagate to the backend's
   *     event-emitter; the in-memory implementation wraps each
   *     invocation in try/catch. Production backends should match.
   */
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
  /**
   * Replay stored events only. No live subscription. Yields every
   * envelope with `sequence > decodeCursor(fromCursor)` up to an
   * optional `limit`, in sequence order, then completes.
   */
  replay(options: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<EventEnvelope>;

  /**
   * Replay + live-tail. Implements the atomic-handoff sequence so a
   * subscriber joining mid-stream sees every event exactly once.
   * Caller controls termination via `signal.abort()` or by exiting
   * the `for await` loop (the feed cleans up the live listener).
   */
  subscribe(options: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    signal?: AbortSignal;
  }): AsyncIterable<EventEnvelope>;

  /** Tear down any feed-level resources (no-op for the in-memory path). */
  dispose(): void;
};

export type WorkflowEventFeedOptions = {
  /** Max envelopes the live buffer holds before overflow terminates the subscription. */
  liveBufferSize?: number;
};

const DEFAULT_LIVE_BUFFER_SIZE = 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createWorkflowEventFeed(
  backend: WorkflowEventFeedBackend,
  options?: WorkflowEventFeedOptions,
): WorkflowEventFeed {
  const bufferSize = options?.liveBufferSize ?? DEFAULT_LIVE_BUFFER_SIZE;

  async function* replay(args: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<EventEnvelope> {
    const afterSequence =
      args.fromCursor !== undefined ? (decodeCursor(args.fromCursor) ?? -1) : -1;
    let yielded = 0;
    for await (const envelope of backend.replay({
      workflowId: args.workflowId,
      selector: args.selector,
      afterSequence,
    })) {
      if (args.limit !== undefined && yielded >= args.limit) return;
      yield envelope;
      yielded += 1;
    }
  }

  function subscribe(args: {
    workflowId: string;
    selector: EventSelector;
    fromCursor?: Cursor;
    signal?: AbortSignal;
  }): AsyncIterable<EventEnvelope> {
    // Step 1: register live listener eagerly (BEFORE the consumer
    // starts iterating). This is the core invariant of atomic handoff:
    // every event emitted between `subscribe()` and first `.next()`
    // must land in the buffer. If we deferred to the generator body,
    // the listener would only register on the first `.next()` and any
    // events emitted in between would be lost.
    const buffer: EventEnvelope[] = [];
    let bufferOverflowed = false;
    let waker: (() => void) | null = null;

    const unsubscribe = backend.subscribeLive(args.workflowId, args.selector, (envelope) => {
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
    args.signal?.addEventListener('abort', onAbort);

    async function* generator(): AsyncIterable<EventEnvelope> {
      try {
        if (args.signal?.aborted) return;

        // Step 2: snapshot the tail sequence AFTER listener is active.
        const snapshot = await backend.snapshotTailSequence(args.workflowId, args.selector);
        const requestedAfter =
          args.fromCursor !== undefined ? (decodeCursor(args.fromCursor) ?? -1) : -1;

        // Step 3: replay from `requestedAfter` up to `snapshot`.
        if (snapshot > requestedAfter) {
          yield* replayUpTo(backend, args, requestedAfter, snapshot);
          if (args.signal?.aborted) return;
        }

        // Step 4 + 5: drain buffer (sequence <= snapshot dropped),
        // then continue live-tail.
        yield* drainLive(
          buffer,
          snapshot,
          args.signal,
          () => bufferOverflowed,
          (w) => {
            waker = w;
          },
        );
      } finally {
        args.signal?.removeEventListener('abort', onAbort);
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

// ---------------------------------------------------------------------------
// In-memory backend (for tests + local development)
// ---------------------------------------------------------------------------

export type InMemoryEventBackend = WorkflowEventFeedBackend & {
  /** Append an envelope to storage (used by tests). */
  append(envelope: EventEnvelope): Promise<void>;
  /**
   * Emit a live event to any active listener WITHOUT persisting it
   * to storage. Used by tests to simulate the race between storage
   * writes and live dispatch. Production backends emit and persist in
   * one step.
   */
  emitLive(envelope: EventEnvelope): Promise<void>;
};

/** Storage-replay generator up to `snapshot` inclusive. */
async function* replayUpTo(
  backend: WorkflowEventFeedBackend,
  args: { workflowId: string; selector: EventSelector; signal?: AbortSignal },
  afterSequence: number,
  snapshot: number,
): AsyncIterable<EventEnvelope> {
  for await (const envelope of backend.replay({
    workflowId: args.workflowId,
    selector: args.selector,
    afterSequence,
  })) {
    if (envelope.sequence > snapshot) break;
    if (args.signal?.aborted) return;
    yield envelope;
  }
}

/**
 * Shift all buffered envelopes strictly above `watermark` into a batch,
 * advancing the watermark monotonically. Envelopes at or below `watermark`
 * are dropped (already covered by the storage replay phase).
 */
function flushPendingBuffer(
  buffer: EventEnvelope[],
  watermark: number,
): { batch: EventEnvelope[]; newWatermark: number } {
  const batch: EventEnvelope[] = [];
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

/**
 * Arm the waker and wait for the next buffer push, overflow, or abort.
 * Re-checks all three immediately after arming to close the lost-wakeup
 * race: an event that arrives in the window between the buffer-empty
 * check and waker installation cancels the wait rather than hanging.
 */
async function armAndWait(
  buffer: EventEnvelope[],
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

/**
 * Live-drain loop. Yields buffered envelopes above `snapshot`, deduping
 * events already covered by the storage replay phase. Uses
 * `flushPendingBuffer` for watermark-advancing dedup and `armAndWait`
 * for the lost-wakeup-safe idle wait.
 */
async function* drainLive(
  buffer: EventEnvelope[],
  snapshot: number,
  signal: AbortSignal | undefined,
  overflowed: () => boolean,
  installWaker: (fn: (() => void) | null) => void,
): AsyncIterable<EventEnvelope> {
  let watermark = snapshot;
  while (true) {
    if (signal?.aborted || overflowed()) return;
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
