import { describe, expect, it } from 'bun:test';

import { bindFeedLifetime } from './bind-feed-lifetime.ts';
import { createInMemoryReplayLiveBackend } from './in-memory-replay-live-backend.ts';
import { createReplayLiveFeed, encodeCursor } from './workflow-event-feed.ts';

type TestEnvelope = { sequence: number; cursor: string; value: string };

function envelope(sequence: number, value: string): TestEnvelope {
  return { sequence, cursor: encodeCursor(sequence), value };
}

function buildFeed() {
  const backend = createInMemoryReplayLiveBackend<TestEnvelope>();
  const lifetime = new AbortController();
  return {
    backend,
    lifetime,
    feed: bindFeedLifetime(createReplayLiveFeed(backend), lifetime.signal),
  };
}

describe('bindFeedLifetime', () => {
  it('ends a subscriber that supplied no signal of its own', async () => {
    // Without the binding this generator parks forever: `drainLive` breaks
    // only on an aborted signal, and there is none. The failure mode is a
    // timeout rather than an assertion, which is why `ended` is what the
    // test asserts on.
    const { lifetime, feed } = buildFeed();
    let ended = false;
    const reading = (async () => {
      for await (const received of feed.subscribe()) {
        expect(received.value).toBe('unreachable');
      }
      ended = true;
    })();

    await Promise.resolve();
    lifetime.abort();
    await reading;

    expect(ended).toBe(true);
  });

  it('still honours a subscriber’s own signal', async () => {
    const { feed } = buildFeed();
    const own = new AbortController();
    let ended = false;
    const reading = (async () => {
      for await (const received of feed.subscribe({ signal: own.signal })) {
        expect(received.value).toBe('unreachable');
      }
      ended = true;
    })();

    await Promise.resolve();
    own.abort();
    await reading;

    expect(ended).toBe(true);
  });

  it('delivers live envelopes while the lifetime is open', async () => {
    const { backend, lifetime, feed } = buildFeed();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const received of feed.subscribe()) {
        seen.push(received.value);
        if (seen.length >= 2) break;
      }
    })();

    await Promise.resolve();
    backend.append(envelope(0, 'first'));
    backend.append(envelope(1, 'second'));
    await reading;

    expect(seen).toEqual(['first', 'second']);
    expect(lifetime.signal.aborted).toBe(false);
  });

  it('replays through the wrapper unchanged', async () => {
    const { backend, feed } = buildFeed();
    backend.append(envelope(0, 'first'));
    backend.append(envelope(1, 'second'));

    const seen: string[] = [];
    for await (const received of feed.replay()) seen.push(received.value);

    expect(seen).toEqual(['first', 'second']);
  });

  it('disposes the underlying feed through the wrapper', async () => {
    // The wrapper forwards `dispose()` rather than owning a lifetime of its
    // own: after it, the backend has no listeners, so an envelope appended
    // next reaches nobody — the same observation the backend's own test
    // makes, taken through the wrapper. The reader is then ended by the
    // lifetime signal, which is the only thing that ends it (see above).
    const { backend, lifetime, feed } = buildFeed();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const received of feed.subscribe()) seen.push(received.value);
    })();

    await Promise.resolve();
    feed.dispose();
    backend.append(envelope(0, 'after-dispose'));
    lifetime.abort();
    await reading;

    expect(seen).toEqual([]);
    expect(backend.size).toBe(1);
  });
});
