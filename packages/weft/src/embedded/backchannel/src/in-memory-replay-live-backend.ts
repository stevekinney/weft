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
 * client that reconnects after the process died receives a gap and can
 * continue from the new log, but cannot recover lost events. `maxEvents`
 * bounds the log so a long-lived producer cannot exhaust memory; once it is
 * reached the oldest envelopes are dropped and a reconnect also sees a gap.
 *
 * Distinct from `in-memory-event-feed-backend.test-support.ts`, which
 * implements the workflow-specific `WorkflowEventFeedBackend` (bucketed by
 * workflow and selector) and is a test helper. This one is generic, carries
 * no domain keys, and is production code.
 *
 * @module server/in-memory-replay-live-backend
 */

import type { ReplayLiveFeedBackend } from './replay-live-feed-types.ts';
import type { Cursor, SequencedEventEnvelope } from './sequence-cursor.ts';

const INCARNATION_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(-1|\d+)$/i;

/** How many envelopes an in-memory log retains before dropping its oldest. */
const DEFAULT_MAX_EVENTS = 10_000;

/** An in-memory {@link ReplayLiveFeedBackend}: a bounded log of envelopes with an append method, for hosts and tests that have no durable event log. */
export type InMemoryReplayLiveBackend<TEnvelope extends SequencedEventEnvelope> =
  ReplayLiveFeedBackend<TEnvelope> & {
    /** Records an envelope and delivers it to live subscribers. */
    append(envelope: TEnvelope): void;
    /** Envelopes currently retained, oldest first. */
    readonly size: number;
    /** Releases every subscriber and clears the log. */
    dispose(): void;
  };

/** Options for {@link createInMemoryReplayLiveBackend}. */
export type InMemoryReplayLiveBackendOptions = {
  /** Retention bound. Defaults to 10,000 envelopes. */
  maxEvents?: number;
  /** Builds the envelope that tells a subscriber its cursor fell outside the retained window. */
  createGapEnvelope?: (options: {
    requestedCursor: Cursor;
    firstRetainedSequence: number;
    continuationCursor: Cursor;
  }) => SequencedEventEnvelope;
};

/** Creates an {@link InMemoryReplayLiveBackend} that keeps at most `maxEvents` envelopes and signals a gap to a cursor from an earlier incarnation. */
export function createInMemoryReplayLiveBackend<TEnvelope extends SequencedEventEnvelope>(
  options: InMemoryReplayLiveBackendOptions = {},
): InMemoryReplayLiveBackend<TEnvelope> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const incarnation = crypto.randomUUID();
  const log: TEnvelope[] = [];
  const listeners = new Set<(envelope: TEnvelope) => void>();
  const decode = (cursor: Cursor): { sequence: number } | 'gap' | 'invalid' => {
    if (cursor === '-1') return { sequence: -1 };
    const structured = INCARNATION_PATTERN.exec(cursor);
    if (structured !== null) {
      const sequence = Number(structured[2]);
      if (!Number.isSafeInteger(sequence)) return 'invalid';
      return structured[1] === incarnation ? { sequence } : 'gap';
    }
    if (/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor))) return 'gap';
    return 'invalid';
  };
  const retentionGap = (
    replayOptions: { afterSequence: number; requestedCursor?: Cursor },
    first: number,
    decoded: { sequence: number } | 'gap' | 'invalid',
  ) =>
    log.length > 0 &&
    first > 0 &&
    replayOptions.afterSequence < first - 1 &&
    decoded !== 'gap' &&
    decoded !== 'invalid';

  return {
    async *replay(replayOptions: { afterSequence: number; requestedCursor?: Cursor }) {
      // Snapshotted before yielding: `append` may run between yields, and a
      // consumer replaying history must not be handed live events out of the
      // same pass — the feed layer is what joins replay to live.
      const snapshot = [...log];
      const firstRetainedSequence = snapshot[0]?.sequence ?? 0;
      const requested = replayOptions.requestedCursor;
      const decoded =
        requested === undefined ? { sequence: replayOptions.afterSequence } : decode(requested);
      if (
        options.createGapEnvelope !== undefined &&
        retentionGap(replayOptions, firstRetainedSequence, decoded)
      ) {
        yield options.createGapEnvelope({
          requestedCursor: requested ?? String(replayOptions.afterSequence),
          firstRetainedSequence,
          continuationCursor: `${incarnation}:${firstRetainedSequence - 1}`,
        }) as TEnvelope;
      }
      for (const envelope of snapshot) {
        if (envelope.sequence > replayOptions.afterSequence) yield envelope;
      }
    },

    async snapshotTailSequence() {
      return log.at(-1)?.sequence ?? -1;
    },

    decodeCursor(cursor: Cursor) {
      return decode(cursor);
    },

    encodeCursor(sequence: number) {
      if (!Number.isSafeInteger(sequence) || sequence < -1)
        throw new RangeError('Invalid sequence');
      return `${incarnation}:${sequence}`;
    },

    async snapshotFirstRetainedSequence() {
      return log[0]?.sequence ?? 0;
    },

    ...(options.createGapEnvelope === undefined
      ? {}
      : {
          createGapEnvelope: ({ requestedCursor, firstRetainedSequence, continuationCursor }) =>
            options.createGapEnvelope!({
              requestedCursor,
              firstRetainedSequence,
              continuationCursor,
            }) as TEnvelope,
        }),

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
