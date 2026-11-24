/**
 * The types of a replay-and-live feed: its storage backend, the feed over it, and its subscribe
 * options. The implementation is `replay-live-feed.ts`.
 *
 * @module server/replay-live-feed-types
 */

import type { Cursor, SequencedEventEnvelope } from './sequence-cursor.ts';

/** The storage a {@link ReplayLiveFeed} reads: a replayable log plus a live subscription. Only `replay`, `snapshotTailSequence` and `subscribeLive` are required. */
export type ReplayLiveFeedBackend<TEnvelope extends SequencedEventEnvelope> = {
  /** Yields the retained envelopes after the given sequence. */
  replay(options: { afterSequence: number; requestedCursor?: Cursor }): AsyncIterable<TEnvelope>;
  /** The sequence of the newest envelope, which bounds the replay. */
  snapshotTailSequence(): Promise<number>;
  /** Calls the listener for each new envelope and returns a function that stops it. */
  subscribeLive(listener: (envelope: TEnvelope) => void): () => void;
  /** Decodes a backend-specific cursor, or reports it as `gap` or `invalid`. */
  decodeCursor?(cursor: Cursor): { sequence: number } | 'gap' | 'invalid';
  /** Encodes a sequence as a backend-specific cursor. */
  encodeCursor?(sequence: number): Cursor;
  /** The sequence of the oldest retained envelope, so the feed can detect a gap. */
  snapshotFirstRetainedSequence?(): Promise<number>;
  /** Builds the envelope that tells a subscriber its cursor fell outside the retained window. */
  createGapEnvelope?(options: {
    requestedCursor: Cursor;
    firstRetainedSequence: number;
    continuationCursor: Cursor;
  }): TEnvelope;
};

/** A replay-and-live feed over one {@link ReplayLiveFeedBackend}: replay from a cursor, then follow live envelopes without a gap or a duplicate. */
export type ReplayLiveFeed<TEnvelope extends SequencedEventEnvelope> = {
  /** Yields the retained envelopes after `fromCursor`, up to `limit`. */
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<TEnvelope>;
  /** Yields the envelopes after `fromCursor`, then live ones, until the signal aborts. */
  subscribe(options?: ReplayLiveSubscribeOptions<TEnvelope>): AsyncIterable<TEnvelope>;
  /** Decodes a cursor to its sequence, or reports it as `gap` or `invalid`. */
  decodeCursor(cursor: Cursor): { sequence: number } | 'gap' | 'invalid';
  /** Releases the feed's live subscription. */
  dispose(): void;
};

/** Options for {@link ReplayLiveFeed.subscribe}: where to resume, how to stop, and how to bound and filter the replay. */
export type ReplayLiveSubscribeOptions<TEnvelope extends SequencedEventEnvelope> = {
  /** Resume after this cursor. */
  fromCursor?: Cursor;
  /** Ends the subscription when aborted. */
  signal?: AbortSignal;
  /** The most envelopes a replay may deliver. */
  replayLimit?: number;
  /** Drops the envelopes for which this returns false. */
  filterEnvelope?: (envelope: TEnvelope) => boolean;
  /** Whether a replayed envelope counts toward `replayLimit`. */
  countReplayEnvelope?: (envelope: TEnvelope) => boolean;
  /** Builds the error thrown when the replay exceeds `replayLimit`. */
  createReplayLimitError?: (count: number, limit: number) => unknown;
  /** Called once the replay has been delivered and live envelopes begin. */
  onReplayComplete?: () => void;
};
