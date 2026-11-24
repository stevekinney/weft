import { drainLive, replayUpTo, shouldDeliverEnvelope } from './replay-live-feed-internals.ts';
type Cursor = string;
type SequencedEventEnvelope = { readonly sequence: number; readonly cursor: Cursor };
type ReplayLiveFeedBackend<T extends SequencedEventEnvelope> = {
  replay(options: { afterSequence: number; requestedCursor?: Cursor }): AsyncIterable<T>;
  snapshotTailSequence(): Promise<number>;
  subscribeLive(listener: (envelope: T) => void): () => void;
  decodeCursor?(cursor: Cursor): { sequence: number } | 'gap' | 'invalid';
  encodeCursor?(sequence: number): Cursor;
  snapshotFirstRetainedSequence?(): Promise<number>;
  createGapEnvelope?(options: {
    requestedCursor: Cursor;
    firstRetainedSequence: number;
    continuationCursor: Cursor;
  }): T;
};
type ReplayLiveSubscribeOptions<T> = {
  fromCursor?: Cursor;
  signal?: AbortSignal;
  replayLimit?: number;
  filterEnvelope?: (envelope: T) => boolean;
  countReplayEnvelope?: (envelope: T) => boolean;
  createReplayLimitError?: (count: number, limit: number) => unknown;
  onReplayComplete?: () => void;
};
type WorkflowEventFeedOptions = { liveBufferSize?: number };
type ReplayLiveFeed<T extends SequencedEventEnvelope> = {
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<T>;
  subscribe(options?: ReplayLiveSubscribeOptions<T>): AsyncIterable<T>;
  decodeCursor(cursor: Cursor): { sequence: number } | 'gap' | 'invalid';
  dispose(): void;
};

const decodeCursor = (cursor: string): number | null =>
  /^(?:-1|\d+)$/.test(cursor) && Number.isSafeInteger(Number(cursor)) ? Number(cursor) : null;
const encodeCursor = (sequence: number): Cursor => String(sequence);

const DEFAULT_LIVE_BUFFER_SIZE = 1000;

/** Builds a {@link ReplayLiveFeed} over a backend. `liveBufferSize` bounds the envelopes buffered for a subscriber that reads slowly. */
export function createReplayLiveFeed<TEnvelope extends SequencedEventEnvelope>(
  backend: ReplayLiveFeedBackend<TEnvelope>,
  options?: WorkflowEventFeedOptions,
): ReplayLiveFeed<TEnvelope> {
  const bufferSize = options?.liveBufferSize ?? DEFAULT_LIVE_BUFFER_SIZE;
  const decode = (cursor: Cursor): { sequence: number } | 'gap' | 'invalid' =>
    backend.decodeCursor?.(cursor) ??
    (() => {
      const sequence = decodeCursor(cursor);
      return sequence === null ? 'invalid' : { sequence };
    })();
  const decodeOrThrow = (cursor: Cursor): { sequence: number } | 'gap' => {
    const result = decode(cursor);
    if (result === 'invalid') throw new Error('Invalid cursor');
    return result;
  };
  const continuation = (sequence: number): Cursor =>
    backend.encodeCursor?.(sequence) ?? (sequence < 0 ? '-1' : encodeCursor(sequence));
  const subscriptionGap = async function* (
    cursor: Cursor | undefined,
    snapshot: number,
    signal: AbortSignal | undefined,
  ): AsyncIterable<TEnvelope> {
    if (
      signal?.aborted ||
      cursor === undefined ||
      backend.createGapEnvelope === undefined ||
      decode(cursor) !== 'gap'
    )
      return;
    const firstRetainedSequence =
      backend.snapshotFirstRetainedSequence === undefined
        ? snapshot + 1
        : await backend.snapshotFirstRetainedSequence();
    if (signal?.aborted) return;
    yield backend.createGapEnvelope({
      requestedCursor: cursor,
      firstRetainedSequence,
      continuationCursor: continuation(firstRetainedSequence - 1),
    });
  };
  const gap = async function* (
    fromCursor: Cursor | undefined,
    replayOperation: () => AsyncIterable<TEnvelope>,
  ): AsyncIterable<TEnvelope> {
    if (fromCursor !== undefined && decodeOrThrow(fromCursor) === 'gap') {
      const firstRetainedSequence =
        (await backend.snapshotFirstRetainedSequence?.()) ??
        (await backend.snapshotTailSequence()) + 1;
      const createGapEnvelope =
        backend.createGapEnvelope === undefined
          ? undefined
          : (input: Parameters<NonNullable<typeof backend.createGapEnvelope>>[0]) =>
              backend.createGapEnvelope!(input);
      if (createGapEnvelope !== undefined)
        yield createGapEnvelope({
          requestedCursor: fromCursor,
          firstRetainedSequence,
          continuationCursor: continuation(firstRetainedSequence - 1),
        });
    }
    yield* replayOperation();
  };
  async function* replay(args?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<TEnvelope> {
    const decoded =
      args?.fromCursor === undefined ? { sequence: -1 } : decodeOrThrow(args.fromCursor);
    let yielded = 0;
    for await (const envelope of gap(args?.fromCursor, () =>
      backend.replay({
        afterSequence: decoded === 'gap' ? -1 : decoded.sequence,
        ...(args?.fromCursor === undefined ? {} : { requestedCursor: args.fromCursor }),
      }),
    )) {
      if (args?.limit !== undefined && yielded >= args.limit) return;
      yield envelope;
      yielded += 1;
    }
  }
  function subscribe(args?: ReplayLiveSubscribeOptions<TEnvelope>): AsyncIterable<TEnvelope> {
    const buffer: TEnvelope[] = [];
    let overflowed = false;
    let waker: (() => void) | null = null;
    let cleanedUp = false;
    const signal = args?.signal;
    const fromCursor = args?.fromCursor;
    const decoded = fromCursor === undefined ? { sequence: -1 } : decodeOrThrow(fromCursor);
    const requestedAfter = decoded === 'gap' ? -1 : decoded.sequence;
    const unsubscribe = backend.subscribeLive((envelope) => {
      if (!shouldDeliverEnvelope(envelope, args)) return;
      if (buffer.length >= bufferSize) overflowed = true;
      else buffer.push(envelope);
      const wake = waker;
      waker = null;
      wake?.();
    });
    const wake = () => {
      const pending = waker;
      waker = null;
      pending?.();
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
    async function* generate(): AsyncIterable<TEnvelope> {
      try {
        if (signal?.aborted) return;
        const snapshot = await backend.snapshotTailSequence();
        yield* subscriptionGap(fromCursor, snapshot, signal);
        if (signal?.aborted) return;
        yield* replayUpTo(backend, requestedAfter, snapshot, signal, args, fromCursor, decode);
        if (signal?.aborted) return;
        args?.onReplayComplete?.();
        yield* drainLive(
          buffer,
          snapshot,
          signal,
          () => overflowed,
          (next) => {
            waker = next;
          },
        );
      } finally {
        cleanup();
      }
    }
    return generate();
  }
  return { replay, subscribe, decodeCursor: decode, dispose() {} };
}
