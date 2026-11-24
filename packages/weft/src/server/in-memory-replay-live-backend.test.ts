import { describe, expect, it } from 'bun:test';

import {
  createInMemoryReplayLiveBackend,
  createReplayLiveFeed,
  encodeCursor,
  type SequencedEventEnvelope,
} from "../embedded/backchannel/src/index.ts";

type ProbeEnvelope = SequencedEventEnvelope & { readonly kind: string; readonly payload?: unknown };

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
    for await (const item of feed.replay({
      fromCursor: backend.encodeCursor?.(0) ?? encodeCursor(0),
    }))
      resumed.push(item);

    expect(resumed.map((item) => item.sequence)).toEqual([1, 2]);
    feed.dispose();
  });

  it('distinguishes contiguous replay from a retention gap and advances its cursor', async () => {
    const makeGap = ({
      requestedCursor,
      firstRetainedSequence,
      continuationCursor,
    }: {
      requestedCursor: string;
      firstRetainedSequence: number;
      continuationCursor: string;
    }): ProbeEnvelope => ({
      sequence: firstRetainedSequence - 1,
      cursor: continuationCursor,
      kind: 'gap',
      payload: { requestedCursor, firstRetainedSequence },
    });
    const first = createInMemoryReplayLiveBackend<ProbeEnvelope>({
      maxEvents: 2,
      createGapEnvelope: makeGap,
    });
    first.append(envelope(0));
    first.append(envelope(1));
    first.append(envelope(2));
    const feed = createReplayLiveFeed(first);
    const currentCursor = first.encodeCursor?.(0) ?? '';
    expect(first.decodeCursor?.(currentCursor)).toEqual({ sequence: 0 });
    expect(first.decodeCursor?.('0')).toBe('gap');
    expect(first.decodeCursor?.('bad')).toBe('invalid');
    expect(first.decodeCursor?.('not-an-incarnation:0')).toBe('invalid');
    expect(first.decodeCursor?.('-1')).toEqual({ sequence: -1 });
    const contiguous: ProbeEnvelope[] = [];
    for await (const item of feed.replay({ fromCursor: currentCursor, limit: 1 }))
      contiguous.push(item);
    expect(contiguous.map((item) => item.sequence)).toEqual([1]);
    expect(contiguous.map((item) => item.kind)).toEqual(['probe']);

    first.append(envelope(3));
    const replayed: ProbeEnvelope[] = [];
    for await (const item of feed.replay({ fromCursor: currentCursor })) replayed.push(item);
    expect(replayed.map((item) => item.kind)).toEqual(['gap', 'probe', 'probe']);
    expect(replayed[0]?.payload).toEqual({
      requestedCursor: currentCursor,
      firstRetainedSequence: 2,
    });
    const continued: ProbeEnvelope[] = [];
    for await (const item of feed.replay({ fromCursor: replayed[0]!.cursor, limit: 1 }))
      continued.push(item);
    expect(continued.map((item) => item.sequence)).toEqual([2]);
    expect(continued.map((item) => item.kind)).toEqual(['probe']);
  });

  it('emits a gap when a cursor belongs to a previous backend instance', async () => {
    const makeGap = ({
      requestedCursor,
      firstRetainedSequence,
      continuationCursor,
    }: {
      requestedCursor: string;
      firstRetainedSequence: number;
      continuationCursor: string;
    }): ProbeEnvelope => ({
      sequence: firstRetainedSequence - 1,
      cursor: continuationCursor,
      kind: 'gap',
      payload: { requestedCursor, firstRetainedSequence },
    });
    const previous = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    previous.append(envelope(0));
    const cursor = previous.encodeCursor?.(0) ?? '';
    const current = createInMemoryReplayLiveBackend<ProbeEnvelope>({ createGapEnvelope: makeGap });
    current.append(envelope(0));
    const replayed: ProbeEnvelope[] = [];
    for await (const item of createReplayLiveFeed(current).replay({ fromCursor: cursor }))
      replayed.push(item);
    expect(replayed.map((item) => item.kind)).toEqual(['gap', 'probe']);
    expect(replayed[0]?.payload).toEqual({ requestedCursor: cursor, firstRetainedSequence: 0 });
  });

  it('stops a canceled subscription before emitting a gap after retention lookup', async () => {
    const prior = createInMemoryReplayLiveBackend<ProbeEnvelope>();
    const cursor = prior.encodeCursor?.(0) ?? '';
    const lookup = Promise.withResolvers<number>();
    const started = Promise.withResolvers<void>();
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>({
      createGapEnvelope: ({ firstRetainedSequence, continuationCursor }) => ({
        sequence: firstRetainedSequence - 1,
        cursor: continuationCursor,
        kind: 'gap',
      }),
    });
    const feed = createReplayLiveFeed({
      ...backend,
      snapshotFirstRetainedSequence: () => {
        started.resolve();
        return lookup.promise;
      },
    });
    const controller = new AbortController();
    const subscription = feed.subscribe({ fromCursor: cursor, signal: controller.signal });
    const iterator = subscription[Symbol.asyncIterator]();
    const next = iterator.next();
    await started.promise;
    controller.abort();
    lookup.resolve(0);
    expect(await next).toEqual({ done: true, value: undefined });
    await iterator.return?.();
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

  it('rejects a digit string beyond the safe integers from the default cursor decoder', () => {
    const feed = createReplayLiveFeed<ProbeEnvelope>({
      replay: async function* () {},
      snapshotTailSequence: () => Promise.resolve(-1),
      subscribeLive: () => () => {},
    });

    expect(feed.decodeCursor('9'.repeat(400))).toBe('invalid');
    expect(feed.decodeCursor('12')).toEqual({ sequence: 12 });
    feed.dispose();
  });

  it('encodes only the sequences a cursor can name', () => {
    const backend = createInMemoryReplayLiveBackend<ProbeEnvelope>();

    expect(backend.encodeCursor?.(-1)).toEndWith(':-1');
    expect(backend.encodeCursor?.(7)).toEndWith(':7');
    for (const sequence of [-2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => backend.encodeCursor?.(sequence)).toThrow('Invalid sequence');
    }
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
