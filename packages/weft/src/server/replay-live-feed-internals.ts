/**
 * Private replay/live-drain algorithm shared by every `createReplayLiveFeed()`
 * instance (`workflow-event-feed.ts`'s per-workflow feed and
 * `fleet-event-feed.ts`'s fleet-wide feed). Split out of
 * `workflow-event-feed.ts` purely to keep that file under the repository's
 * implementation-file line limit — nothing here is public API.
 *
 * @module server/replay-live-feed-internals
 */

import type {
  ReplayLiveFeedBackend,
  ReplayLiveSubscribeOptions,
  SequencedEventEnvelope,
} from './workflow-event-feed.ts';

type DurableSubscriptionOptions = {
  readonly liveBufferSize: number;
  readonly pollIntervalMs: number;
  readonly lifecycleSignal?: AbortSignal;
};

export function createDurableSubscription<TEnvelope extends SequencedEventEnvelope>(
  backend: ReplayLiveFeedBackend<TEnvelope>,
  options: DurableSubscriptionOptions,
  args?: ReplayLiveSubscribeOptions<TEnvelope>,
): AsyncIterable<TEnvelope> {
  const requestedAfter = decodeRequestedCursor(args?.fromCursor);
  const signal =
    args?.signal === undefined
      ? options.lifecycleSignal
      : options.lifecycleSignal === undefined
        ? args.signal
        : AbortSignal.any([args.signal, options.lifecycleSignal]);
  const buffer: TEnvelope[] = [];
  let bufferOverflowed = false;
  let replayComplete = false;
  let waker: (() => void) | null = null;
  let cleanedUp = false;
  const wake = () => {
    const pending = waker;
    waker = null;
    pending?.();
  };
  const unsubscribe = backend.subscribeLive((envelope) => {
    if (!shouldDeliverEnvelope(envelope, args)) return;
    if (replayComplete) {
      wake();
      return;
    }
    if (buffer.length >= options.liveBufferSize) bufferOverflowed = true;
    else buffer.push(envelope);
    wake();
  });
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal?.removeEventListener('abort', cleanup);
    unsubscribe();
    wake();
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  if (signal?.aborted) cleanup();
  async function* generator(): AsyncIterable<TEnvelope> {
    try {
      if (signal?.aborted) return;
      const snapshot = await backend.snapshotTailSequence();
      yield* replayUpTo(backend, requestedAfter, snapshot, signal, args);
      if (signal?.aborted || bufferOverflowed) return;
      args?.onReplayComplete?.();
      buffer.length = 0;
      replayComplete = true;
      yield* tailDurableEvents(backend, snapshot, signal, args, options.pollIntervalMs, (next) => {
        waker = next;
      });
    } finally {
      cleanup();
    }
  }
  return generator();
}

async function* tailDurableEvents<TEnvelope extends SequencedEventEnvelope>(
  backend: ReplayLiveFeedBackend<TEnvelope>,
  snapshot: number,
  signal: AbortSignal | undefined,
  args: ReplayLiveSubscribeOptions<TEnvelope> | undefined,
  pollIntervalMs: number,
  installWaker: (waker: (() => void) | null) => void,
): AsyncIterable<TEnvelope> {
  let deliveredSequence = snapshot;
  while (true) {
    if (signal?.aborted) break;
    let found = false;
    for await (const envelope of backend.replay({ afterSequence: deliveredSequence })) {
      if (signal?.aborted) break;
      found = true;
      deliveredSequence = Math.max(deliveredSequence, envelope.sequence);
      if (shouldDeliverEnvelope(envelope, args)) yield envelope;
    }
    if (found) continue;
    await waitForAppendOrPoll(pollIntervalMs, signal, installWaker);
  }
}

function decodeRequestedCursor(cursor: string | undefined): number {
  if (cursor === undefined) return -1;
  if (!/^(?:-1|\d+)$/.test(cursor)) throw new Error('Invalid cursor');
  const sequence = Number(cursor);
  if (!Number.isSafeInteger(sequence) || sequence < -1) throw new Error('Invalid cursor');
  return sequence;
}

async function waitForAppendOrPoll(
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
  installWaker: (waker: (() => void) | null) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      installWaker(null);
      resolve();
    };
    installWaker(finish);
    timer = setTimeout(finish, pollIntervalMs);
    if (signal?.aborted) finish();
  });
}

/** Thrown when a replay window exceeds the caller's configured limit. */
export class ReplayWindowExceededError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(`Replay window is ${count} events; maximum is ${limit}.`);
    this.name = 'ReplayWindowExceededError';
  }
}

export async function* replayUpTo<TEnvelope extends SequencedEventEnvelope>(
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

export function shouldDeliverEnvelope<TEnvelope extends SequencedEventEnvelope>(
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

export async function* drainLive<TEnvelope extends SequencedEventEnvelope>(
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
