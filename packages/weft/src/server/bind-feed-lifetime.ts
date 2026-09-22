/**
 * Binding a replay-plus-live feed's subscriptions to the feed's own lifetime.
 *
 * Its own module rather than a few lines in `workflow-event-feed.ts`, which
 * is already at the file-length limit — and the separation reads correctly:
 * this composes the primitive from outside rather than being part of it.
 *
 * @module server/bind-feed-lifetime
 */

import type { ReplayLiveFeed, SequencedEventEnvelope } from './workflow-event-feed.ts';

/**
 * Binds every subscription a feed hands out to a lifetime signal.
 *
 * A subscriber returned by {@link createReplayLiveFeed} ends on its own
 * `signal` and on nothing else: `drainLive` loops until that signal aborts,
 * and a backend's `dispose()` clears its listener set without waking anybody,
 * so the generator parks on a waker that can never fire again. A host that
 * reaps a feed — a finished agent run, a disposed bureau — therefore has to
 * tell its subscribers, not merely stop feeding them.
 *
 * Composing that here rather than at each subscription site is deliberate:
 * the hazard belongs to the feed, so making correctness depend on every
 * caller remembering to compose would leave a direct `feed.subscribe()` (what
 * tests and in-process hosts use) parked forever.
 *
 * WHAT THIS DOES NOT PROMISE: a final envelope. Aborting the lifetime ends a
 * subscriber promptly, and `drainLive` returns on an aborted signal before
 * flushing whatever is still buffered — so an envelope published in the same
 * synchronous stretch as the abort may never be delivered. That is the right
 * trade for the signal's other job (a client cancelling should stop, not
 * drain), and a producer wanting a last word would have to let the loop turn
 * first, which would deliver it to a prompt reader and not a slow one. The
 * subscription ending is the signal; a client that needs a reason asks.
 *
 * @example
 * ```ts
 * import { bindFeedLifetime, createReplayLiveFeed } from '@lostgradient/weft';
 * declare const backend: Parameters<typeof createReplayLiveFeed>[0];
 * const lifetime = new AbortController();
 * const feed = bindFeedLifetime(createReplayLiveFeed(backend), lifetime.signal);
 * // `lifetime.abort()` now ends every live subscriber.
 * ```
 */
export function bindFeedLifetime<TEnvelope extends SequencedEventEnvelope>(
  feed: ReplayLiveFeed<TEnvelope>,
  lifetime: AbortSignal,
): ReplayLiveFeed<TEnvelope> {
  return {
    replay: (options) => feed.replay(options),
    subscribe: (options) =>
      feed.subscribe({
        ...options,
        signal:
          options?.signal === undefined ? lifetime : AbortSignal.any([options.signal, lifetime]),
      }),
    dispose: () => {
      feed.dispose();
    },
  };
}
