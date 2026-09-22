import { describe, expect, it } from 'bun:test';

import { createInMemoryReplayLiveBackend } from './in-memory-replay-live-backend.ts';
import {
  createReplayLiveFeed,
  encodeCursor,
  type SequencedEventEnvelope,
} from './workflow-event-feed.ts';

type ProbeEnvelope = SequencedEventEnvelope & { readonly kind: string };

function envelope(sequence: number, kind = 'probe'): ProbeEnvelope {
  return { sequence, cursor: encodeCursor(sequence), kind };
}

async function collect(
  iterable: AsyncIterable<ProbeEnvelope>,
  count: number,
): Promise<ProbeEnvelope[]> {
  const seen: ProbeEnvelope[] = [];
  for await (const item of iterable) {
    seen.push(item);
    if (seen.length >= count) break;
  }
  return seen;
}

describe('the in-memory replay-live backend', () => {
  it('replays only what follows the requested sequence', async () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    for (let sequence = 0; sequence < 4; sequence += 1) backend.append(envelope(sequence));

    const replayed: ProbeEnvelope[] = [];
    for await (const item of backend.replay({ afterSequence: 1 })) replayed.push(item);

    expect(replayed.map((item) => item.sequence)).toEqual([2, 3]);
  });

  it('reports the tail sequence, and -1 for an empty log', async () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    expect(await backend.snapshotTailSequence()).toBe(-1);

    backend.append(envelope(0));
    backend.append(envelope(1));
    expect(await backend.snapshotTailSequence()).toBe(1);
  });

  it('drops the oldest envelopes once retention is reached', async () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>({ maxEvents: 3 });
    for (let sequence = 0; sequence < 5; sequence += 1) backend.append(envelope(sequence));

    expect(backend.size).toBe(3);
    const replayed: ProbeEnvelope[] = [];
    for await (const item of backend.replay({ afterSequence: -1 })) replayed.push(item);
    // The bound is the cost of choosing an in-memory log: a client holding
    // cursor 0 can no longer replay from it.
    expect(replayed.map((item) => item.sequence)).toEqual([2, 3, 4]);
  });

  it('keeps delivering to later listeners when an earlier one throws', () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const delivered: number[] = [];
    backend.subscribeLive(() => {
      throw new Error('listener exploded');
    });
    backend.subscribeLive((item) => delivered.push(item.sequence));

    // A subscriber that throws must not corrupt the producer or starve the
    // subscribers registered after it.
    expect(() => backend.append(envelope(0))).not.toThrow();
    expect(delivered).toEqual([0]);
  });

  it('stops delivering after unsubscribe', () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const delivered: number[] = [];
    const unsubscribe = backend.subscribeLive((item) => delivered.push(item.sequence));

    backend.append(envelope(0));
    unsubscribe();
    backend.append(envelope(1));

    expect(delivered).toEqual([0]);
  });

  it('drives a replay-then-live feed: a late joiner catches up, then follows', async () => {
    // The property the whole feed exists for. A subscriber that arrives after
    // two events have already happened must see those two before the third,
    // in order, with no gap and no duplicate.
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const feed = createReplayLiveFeed<ProbeEnvelope>(backend);

    backend.append(envelope(0, 'before'));
    backend.append(envelope(1, 'before'));

    const subscription = feed.subscribe();
    const collected = collect(subscription, 3);
    await Promise.resolve();
    backend.append(envelope(2, 'after'));

    const seen = await collected;
    expect(seen.map((item) => item.sequence)).toEqual([0, 1, 2]);
    expect(seen.map((item) => item.kind)).toEqual(['before', 'before', 'after']);
    feed.dispose();
  });

  it('resumes from a cursor, delivering only what the client missed', async () => {
    // Reconnect-without-loss, which is the capability a durable backend later
    // extends across a process restart rather than introduces.
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const feed = createReplayLiveFeed<ProbeEnvelope>(backend);
    for (let sequence = 0; sequence < 3; sequence += 1) backend.append(envelope(sequence));

    const resumed: ProbeEnvelope[] = [];
    for await (const item of feed.replay({ fromCursor: encodeCursor(0) })) resumed.push(item);

    expect(resumed.map((item) => item.sequence)).toEqual([1, 2]);
    feed.dispose();
  });

  it('counts the replay cap against filtered-in envelopes only', async () => {
    // Pins the ordering in `replay-live-feed-internals.ts`: `filterEnvelope`
    // runs first and `countReplayEnvelope` sees only what survived it. A
    // caller therefore does NOT need to repeat its filter in the counter —
    // and one that does just runs the predicate twice per envelope.
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const feed = createReplayLiveFeed<ProbeEnvelope>(backend);
    for (let sequence = 0; sequence < 5; sequence += 1) {
      backend.append(envelope(sequence, sequence === 4 ? 'wanted' : 'ignored'));
    }

    const delivered: ProbeEnvelope[] = [];
    for await (const item of feed.subscribe({
      filterEnvelope: (item) => item.kind === 'wanted',
      // A cap of one would be exceeded immediately if the four filtered-out
      // envelopes were counted.
      replayLimit: 1,
      createReplayLimitError: () => new Error('replay cap exceeded'),
    })) {
      delivered.push(item);
      break;
    }

    expect(delivered.map((item) => item.sequence)).toEqual([4]);
    feed.dispose();
  });

  it('releases subscribers on dispose', () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const delivered: number[] = [];
    backend.subscribeLive((item) => delivered.push(item.sequence));

    backend.dispose();
    backend.append(envelope(0));

    expect(delivered).toEqual([]);
    expect(backend.size).toBe(1);
  });
});
