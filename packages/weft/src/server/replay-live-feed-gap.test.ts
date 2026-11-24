/**
 * How `createReplayLiveFeed` reports a cursor its backend calls a gap when the backend cannot
 * say where its log now starts, and when it cannot build a gap envelope at all.
 *
 * The backend here is the smallest one the feed accepts: its log is empty, every cursor is a gap,
 * and `snapshotFirstRetainedSequence` is absent, so the feed derives the first retained sequence
 * from the log's tail.
 */
import { describe, expect, it } from 'bun:test';

import {
  bindFeedLifetime,
  createReplayLiveFeed,
  encodeCursor,
  type ReplayLiveFeedBackend,
  type SequencedEventEnvelope,
} from "../embedded/backchannel/src/index.ts";

type GapAwareEnvelope = SequencedEventEnvelope & { readonly kind: 'event' | 'gap' };

function createBackend(options: {
  tailSequence: number;
  withGapEnvelopes: boolean;
}): ReplayLiveFeedBackend<GapAwareEnvelope> {
  return {
    async *replay() {},
    snapshotTailSequence: async () => options.tailSequence,
    subscribeLive: () => () => {},
    decodeCursor: () => 'gap',
    ...(options.withGapEnvelopes
      ? {
          createGapEnvelope: ({ continuationCursor, firstRetainedSequence }) => ({
            kind: 'gap' as const,
            sequence: firstRetainedSequence,
            cursor: continuationCursor,
          }),
        }
      : {}),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) results.push(item);
  return results;
}

describe('createReplayLiveFeed gap reporting', () => {
  it('starts a replayed gap one past the tail when the backend has no retained-sequence snapshot', async () => {
    const feed = createReplayLiveFeed(createBackend({ tailSequence: 4, withGapEnvelopes: true }));

    const received = await collect(feed.replay({ fromCursor: 'stale' }));

    expect(received).toEqual([{ kind: 'gap', sequence: 5, cursor: encodeCursor(4) }]);
  });

  it('replays without a gap envelope when the backend cannot build one', async () => {
    const feed = createReplayLiveFeed(createBackend({ tailSequence: 4, withGapEnvelopes: false }));

    expect(await collect(feed.replay({ fromCursor: 'stale' }))).toEqual([]);
  });

  it('starts a subscribed gap one past the snapshot when the backend has no retained-sequence snapshot', async () => {
    const feed = createReplayLiveFeed(createBackend({ tailSequence: 4, withGapEnvelopes: true }));
    const lifetime = new AbortController();

    const received: GapAwareEnvelope[] = [];
    for await (const envelope of bindFeedLifetime(feed, lifetime.signal).subscribe({
      fromCursor: 'stale',
    })) {
      received.push(envelope);
      lifetime.abort();
    }

    expect(received).toEqual([{ kind: 'gap', sequence: 5, cursor: encodeCursor(4) }]);
  });

  it('reports a cursor as a gap through a feed bound to a lifetime', () => {
    const feed = createReplayLiveFeed(createBackend({ tailSequence: 0, withGapEnvelopes: false }));
    const bound = bindFeedLifetime(feed, new AbortController().signal);

    expect(bound.decodeCursor('stale')).toBe('gap');
    bound.dispose();
  });
});
