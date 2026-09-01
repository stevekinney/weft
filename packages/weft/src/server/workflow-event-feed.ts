import type { WeftEventMap } from '../core/events.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { drainLive, replayUpTo, shouldDeliverEnvelope } from './replay-live-feed-internals.ts';

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

/**
 * Opaque cursor into a workflow or fleet event feed. Only `encodeCursor` /
 * `decodeCursor` know the format — treat it as an opaque string, pass it back
 * as `fromCursor` to resume a feed, and never parse it.
 *
 * @example
 * ```ts
 * import type { Cursor, EventEnvelope } from '@lostgradient/weft/server/handler';
 *
 * declare const envelope: EventEnvelope;
 * const lastCursor: Cursor = envelope.cursor;
 * void lastCursor;
 * ```
 */
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

/**
 * A single committed record from a workflow's event feed — the `events`
 * (durable log entries, e.g. `workflow:checkpoint`) or `tokens` (streamed
 * output chunks) selector, distinguished by `selector`. Returned by
 * `WorkflowEventFeed.replay()` / `WorkflowEventFeed.subscribe()`, and
 * consumed directly by the `/v1/workflows/:id/events/sse` REST route.
 *
 * @example
 * ```ts
 * import type { EventEnvelope } from '@lostgradient/weft/server/handler';
 *
 * declare const envelope: EventEnvelope;
 * console.log(envelope.selector); // 'events' | 'tokens'
 * console.log(envelope.kind); // e.g. 'workflow:checkpoint'
 * ```
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
 * The durable source a `WorkflowEventFeed` replays and subscribes against.
 * Most callers never implement this directly — `createEngineEventFeedBackend()`
 * builds the production, `Engine`-backed implementation. Implement it
 * yourself only to back a feed with a non-`Engine` source (e.g. a test
 * double).
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import {
 *   createEngineEventFeedBackend,
 *   type WorkflowEventFeedBackend,
 * } from '@lostgradient/weft/server/handler';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const backend: WorkflowEventFeedBackend = createEngineEventFeedBackend(engine);
 * void backend;
 * ```
 */
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

/**
 * A per-workflow event feed: replay committed history from a cursor, then
 * subscribe for live delivery. This is the shape of
 * `HandlerOptions.workflowEventFeed` — build a real one with
 * `createWorkflowEventFeed()` to drive `/v1/workflows/:id/events/sse`
 * through `handleRequest()` without `serve()`.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import {
 *   createEngineEventFeedBackend,
 *   createWorkflowEventFeed,
 *   type WorkflowEventFeed,
 * } from '@lostgradient/weft/server/handler';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const workflowEventFeed: WorkflowEventFeed = createWorkflowEventFeed(
 *   createEngineEventFeedBackend(engine),
 * );
 * void workflowEventFeed;
 * ```
 */
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

/**
 * A committed fleet-wide event, optionally scoped to one workflow.
 * @example
 * ```ts
 * import type { FleetEventEnvelope } from '@lostgradient/weft/server/handler';
 * declare const event: FleetEventEnvelope;
 * console.log(event.cursor);
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

/**
 * The caller-supplied fields for a new fleet event.
 * @example
 * ```ts
 * import type { FleetEventInput } from '@lostgradient/weft/server/handler';
 * const event: FleetEventInput = { kind: 'worker:connected', emittedAtMs: 1, payload: {} };
 * ```
 */
export type FleetEventInput = {
  readonly kind: FeedEventKind;
  readonly workflowId?: string | undefined;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

/**
 * A fleet event input guaranteed to identify its workflow.
 * @example
 * ```ts
 * import type { FleetWorkflowEventInput } from '@lostgradient/weft/server/handler';
 * declare const event: FleetWorkflowEventInput;
 * console.log(event.workflowId);
 * ```
 */
export type FleetWorkflowEventInput = FleetEventInput & { readonly workflowId: string };

/**
 * Caller-owned state operations committed atomically with an event.
 * @example
 * ```ts
 * import type { FleetEventAppendOptions } from '@lostgradient/weft/server/handler';
 * const options: FleetEventAppendOptions = { operations: [{ type: 'delete', key: 'app:pending' }] };
 * ```
 */
export type FleetEventAppendOptions = {
  readonly conditions?: readonly ConditionalBatchCondition[];
  readonly operations?: readonly BatchOperation[];
};

/**
 * The compaction boundary returned when a cursor predates retained history.
 * @example
 * ```ts
 * import type { FleetEventGapEnvelope } from '@lostgradient/weft/server/handler';
 * declare const gap: FleetEventGapEnvelope;
 * console.log(gap.payload.firstRetainedSequence);
 * ```
 */
export type FleetEventGapEnvelope = {
  readonly kind: 'fleet:gap';
  readonly sequence: number;
  readonly cursor: Cursor;
  readonly emittedAtMs: number;
  readonly payload: { readonly requestedCursor: Cursor; readonly firstRetainedSequence: number };
};

/**
 * Durable fleet-feed polling and replay handoff options.
 * @example
 * ```ts
 * import type { FleetEventFeedOptions } from '@lostgradient/weft/server/handler';
 * const options: FleetEventFeedOptions = { livePollIntervalMs: 100 };
 * ```
 */
export type FleetEventFeedOptions = {
  /** How often a subscriber checks durable storage for commits from another process. */
  readonly livePollIntervalMs?: number;
};

export type SequencedEventEnvelope = {
  readonly sequence: number;
  readonly cursor: Cursor;
};

export type ReplayLiveFeedBackend<TEnvelope extends SequencedEventEnvelope> = {
  replay(options: { afterSequence: number; requestedCursor?: Cursor }): AsyncIterable<TEnvelope>;
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
  onReplayComplete?: () => void;
};

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
    for await (const envelope of backend.replay({
      afterSequence,
      ...(args?.fromCursor === undefined ? {} : { requestedCursor: args.fromCursor }),
    })) {
      if (args?.limit !== undefined && yielded >= args.limit) return;
      yield envelope;
      yielded += 1;
    }
  }

  function subscribe(args?: ReplayLiveSubscribeOptions<TEnvelope>): AsyncIterable<TEnvelope> {
    const buffer: TEnvelope[] = [];
    let bufferOverflowed = false;
    let waker: (() => void) | null = null;
    let cleanedUp = false;
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

    const wake = () => {
      if (waker) {
        const fire = waker;
        waker = null;
        fire();
      }
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      wake();
    };

    const onAbort = () => cleanup();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) cleanup();

    async function* generator(): AsyncIterable<TEnvelope> {
      try {
        if (signal?.aborted) return;

        const snapshot = await backend.snapshotTailSequence();
        yield* replayUpTo(backend, requestedAfter, snapshot, signal, args);
        if (signal?.aborted) return;
        args?.onReplayComplete?.();
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
        cleanup();
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

/**
 * Build a `WorkflowEventFeed` over the given backend. Pass the result as
 * `HandlerOptions.workflowEventFeed` to drive `/v1/workflows/:id/events/sse`
 * through `handleRequest()` directly, without `serve()`. Call once and share
 * the returned feed across every workflow and transport that needs it —
 * `createWorkflowEventFeed()` itself holds no per-workflow state.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import {
 *   createEngineEventFeedBackend,
 *   createWorkflowEventFeed,
 *   handleRequest,
 *   type HandlerOptions,
 * } from '@lostgradient/weft/server/handler';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const workflowEventFeed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
 * const options: HandlerOptions = { workflowEventFeed };
 *
 * async function handleWorkflowEventsSse(request: Request): Promise<Response> {
 *   return handleRequest(request, engine, options);
 * }
 * void handleWorkflowEventsSse;
 * ```
 */
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
    onReplayComplete?: () => void;
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
    if (args.onReplayComplete !== undefined) {
      subscribeOptions.onReplayComplete = args.onReplayComplete;
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
