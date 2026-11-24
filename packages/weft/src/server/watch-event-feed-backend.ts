/**
 * `WorkflowEventFeedBackend` over the per-workflow watch events that `serve()` persists and that
 * `/v1/workflows/:id/watch` WebSocket clients read.
 *
 * `selector: "events"` is served from the stored watch events (`KEYS.watchEvent`), so a Server-Sent
 * Events subscriber on `/v1/workflows/:id/events/sse` receives the same lifecycle events, in the
 * same order and with the same sequence cursors, as a `/watch` subscriber. `selector: "tokens"`
 * still reads the engine's token stream.
 *
 * **Atomic handoff.** `wireEventBroadcasting` calls {@link WatchEventFeedBackend.notify} only after
 * the watch event's storage write resolved, so an envelope in the live buffer is already durable
 * and scannable by `replay`. That is the invariant `createReplayLiveFeed` relies on to splice
 * replay onto live delivery without a gap or a duplicate.
 *
 * @module server/watch-event-feed-backend
 */

import { encodeCursor } from "../embedded/backchannel/src/index.ts";
import { type EventSelector } from "../embedded/backchannel/src/internals.ts";
import type { Engine } from '../core/engine.ts';
import { KEYS } from '../storage/keys.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import {
  decodeStoredWatchEvent,
  getHighestStoredWatchSequence,
  isStoredWatchEvent,
  parseSequenceFromEventKey,
} from './runtime/websocket-stream.ts';
import {
  createWorkflowEventFeed,
  type EventEnvelope,
  type WorkflowEventFeed,
  type WorkflowEventFeedBackend,
} from './workflow-event-feed.ts';

type WatchEventFeedBackend = WorkflowEventFeedBackend & {
  notify(workflowId: string, sequence: number, message: string): void;
};

/** A workflow event feed over the stored watch events, which the server tells about each commit. */
export type WatchEventFeed = WorkflowEventFeed & {
  /**
   * Announce one watch event that is already stored under `sequence`. `message` is the exact JSON
   * text published to `/watch` sockets.
   */
  notify(workflowId: string, sequence: number, message: string): void;
};

type EnvelopeListener = (envelope: EventEnvelope) => void;

function storedWatchEventToEnvelope(
  workflowId: string,
  sequence: number,
  event: { type: string; timestamp: number; data: Record<string, unknown> },
): EventEnvelope {
  return {
    kind: event.type,
    workflowId,
    selector: 'events',
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: event.timestamp,
    payload: event.data,
  };
}

function createWatchEventFeedBackend(engine: Engine): WatchEventFeedBackend {
  const tokenBackend = createEngineEventFeedBackend(engine);
  const listeners = new Map<string, Set<EnvelopeListener>>();

  return {
    async *replay(options) {
      if (options.selector !== 'events') {
        yield* tokenBackend.replay(options);
        return;
      }
      const { workflowId, afterSequence } = options;
      const prefix = KEYS.watchEventPrefix(workflowId);
      const scanOptions =
        afterSequence >= 0 ? { gt: KEYS.watchEvent(workflowId, afterSequence) } : undefined;
      for await (const [storageKey, value] of engine.storage.scan(prefix, scanOptions)) {
        const sequence = parseSequenceFromEventKey(prefix, storageKey);
        if (sequence === null || sequence <= afterSequence) continue;
        const decoded = decodeStoredWatchEvent(value);
        if (!isStoredWatchEvent(decoded)) continue;
        yield storedWatchEventToEnvelope(workflowId, sequence, decoded);
      }
    },

    snapshotTailSequence(workflowId: string, selector: EventSelector) {
      if (selector !== 'events') return tokenBackend.snapshotTailSequence(workflowId, selector);
      return getHighestStoredWatchSequence(engine, workflowId);
    },

    subscribeLive(workflowId, selector, listener) {
      if (selector !== 'events') return tokenBackend.subscribeLive(workflowId, selector, listener);
      let bucket = listeners.get(workflowId);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(workflowId, bucket);
      }
      bucket.add(listener);
      return () => {
        const current = listeners.get(workflowId);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(workflowId);
      };
    },

    notify(workflowId, sequence, message) {
      const bucket = listeners.get(workflowId);
      if (bucket === undefined) return;
      const parsed: unknown = JSON.parse(message);
      if (!isStoredWatchEvent(parsed)) return;
      const envelope = storedWatchEventToEnvelope(workflowId, sequence, parsed);
      for (const listener of bucket) listener(envelope);
    },
  };
}

/**
 * Build the feed `serve()` hands the REST `/v1/workflows/:id/events/sse` route:
 * the stored watch events for `selector: "events"`, and the engine's token stream for `"tokens"`.
 */
export function createWatchEventFeed(engine: Engine): WatchEventFeed {
  const backend = createWatchEventFeedBackend(engine);
  return {
    ...createWorkflowEventFeed(backend),
    notify: (workflowId, sequence, message) => backend.notify(workflowId, sequence, message),
  };
}
