/**
 * A `ReplayLiveFeedBackend` that keeps its log in memory.
 *
 * This is the live-only half of the feed's two shapes. `createReplayLiveFeed`
 * is generic over its backend, so a feed built on this one supports replay,
 * cursors, late joins, and filtering exactly as a durable feed does — for as
 * long as the process lives. Swapping in a persisted backend later changes
 * this file and nothing above it: not the feed, not a subscription operation,
 * not a client.
 *
 * WHAT IT COSTS TO CHOOSE THIS FIRST. Events are lost on restart, and a
 * client that reconnects after the process died cannot resume from its
 * cursor. `maxEvents` bounds the log so a long-lived producer cannot exhaust
 * memory; once it is reached the oldest envelopes are dropped, which a
 * reconnecting client observes as a cursor it can no longer replay from.
 *
 * Distinct from `in-memory-event-feed-backend.test-support.ts`, which
 * implements the workflow-specific `WorkflowEventFeedBackend` (bucketed by
 * workflow and selector) and is a test helper. This one is generic, carries
 * no domain keys, and is production code.
 *
 * @module server/in-memory-replay-live-backend
 */

import type {
  Cursor,
  ReplayLiveFeedBackend,
  SequencedEventEnvelope,
} from './workflow-event-feed.ts';

/** How many envelopes an in-memory log retains before dropping its oldest. */
const DEFAULT_MAX_EVENTS = 10_000;

export type InMemoryReplayLiveBackend<TEnvelope extends SequencedEventEnvelope> =
  ReplayLiveFeedBackend<TEnvelope> & {
    /** Records an envelope and delivers it to live subscribers. */
    append(envelope: TEnvelope): void;
    /** Envelopes currently retained, oldest first. */
    readonly size: number;
    /** Releases every subscriber and clears the log. */
    dispose(): void;
  };

export type InMemoryReplayLiveBackendOptions = {
  /** Retention bound. Defaults to 10,000 envelopes. */
  maxEvents?: number;
};

export function createInMemoryReplayLiveBackend<TEnvelope extends SequencedEventEnvelope>(
  options: InMemoryReplayLiveBackendOptions = {},
): InMemoryReplayLiveBackend<TEnvelope> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const log: TEnvelope[] = [];
  const listeners = new Set<(envelope: TEnvelope) => void>();

  return {
    async *replay(replayOptions: { afterSequence: number; requestedCursor?: Cursor }) {
      // Snapshotted before yielding: `append` may run between yields, and a
      // consumer replaying history must not be handed live events out of the
      // same pass — the feed layer is what joins replay to live.
      const snapshot = [...log];
      for (const envelope of snapshot) {
        if (envelope.sequence > replayOptions.afterSequence) yield envelope;
      }
    },

    async snapshotTailSequence() {
      return log.at(-1)?.sequence ?? -1;
    },

    subscribeLive(listener: (envelope: TEnvelope) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    append(envelope: TEnvelope) {
      log.push(envelope);
      // Bounded rather than unbounded: an agent run emits events per step, and
      // a feed nobody drains would otherwise grow for the process's lifetime.
      if (log.length > maxEvents) log.splice(0, log.length - maxEvents);
      // Copied before iteration: a listener that unsubscribes itself while
      // the set is being walked would otherwise skip the next one.
      for (const listener of Array.from(listeners)) {
        try {
          listener(envelope);
        } catch {
          // A listener that throws must not corrupt the producer or stop
          // delivery to the listeners after it.
        }
      }
    },

    get size() {
      return log.length;
    },

    dispose() {
      listeners.clear();
      log.length = 0;
    },
  };
}
