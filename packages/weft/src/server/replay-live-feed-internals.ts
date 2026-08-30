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
