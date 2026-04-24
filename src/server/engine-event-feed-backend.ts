/**
 * Engine-backed `WorkflowEventFeedBackend` — the production backing
 * for `createWorkflowEventFeed` (see `workflow-event-feed.ts`). REST
 * SSE, the JSON-RPC WebSocket session, and the JSON-RPC stdio session
 * all consume the feed; this module is where the feed meets the
 * `Engine`'s durable state.
 *
 * **Single committed sequence authority.** Replay and live delivery
 * share the same source of truth:
 *
 *   - `selector: 'events'` → `Engine.replayEventLog()` for replay,
 *     `Engine.subscribeEventLogCommits()` for live. The subscription
 *     fires only AFTER the `storage.batch()` carrying the new entry
 *     resolves, so an event in the live buffer is already durable
 *     and scannable by `replayEventLog`. This is the invariant the
 *     feed's atomic-handoff (buffer-then-snapshot-then-replay-then-drain)
 *     relies on.
 *
 *   - `selector: 'tokens'` → `Engine.replayStreamChunks()` /
 *     `Engine.subscribeStreamChunkCommits()` keyed on the literal
 *     stream key `'tokens'`. This mirrors what legacy REST SSE has
 *     always served under `GET /v1/workflows/:id/sse` so dashboards
 *     that resume off a `Last-Event-ID` cursor see the same sequence
 *     space.
 *
 * The backend is intentionally stateless — it holds only the `Engine`
 * reference. Listener state lives on the engine (keyed by workflow id
 * + stream key) and is cleaned up by the caller's unsubscribe function.
 *
 * @module server/engine-event-feed-backend
 */

import type { Engine, EventLogCommitRecord, StreamChunkCommitRecord } from '../core/engine.ts';
import {
  encodeCursor,
  type EventEnvelope,
  type EventSelector,
  type WorkflowEventFeedBackend,
} from './workflow-event-feed.ts';

/**
 * Stream key used for the `'tokens'` selector. Matches the legacy REST
 * SSE endpoint's hard-coded key so resumption cursors round-trip
 * across transports.
 */
const TOKENS_STREAM_KEY = 'tokens';

/**
 * Envelope `kind` for token stream chunks. Stream chunks are not
 * dispatched as runtime `Event` objects, so they are not members of
 * `WeftEventMap` — `FeedEventKind` widens to plain `string` to cover
 * selector-scoped discriminators like this one alongside the
 * dispatched event map.
 */
const STREAM_CHUNK_KIND = 'stream:chunk';

/**
 * Build the production `WorkflowEventFeedBackend`. Call once per
 * engine instance and share the returned backend across every
 * transport that needs a feed.
 */
export function createEngineEventFeedBackend(engine: Engine): WorkflowEventFeedBackend {
  return {
    replay({ workflowId, selector, afterSequence }) {
      if (selector === 'events') {
        return replayEventLog(engine, workflowId, afterSequence);
      }
      return replayTokenChunks(engine, workflowId, afterSequence);
    },

    async snapshotTailSequence(workflowId, selector) {
      if (selector === 'events') {
        return engine.snapshotEventLogTail(workflowId);
      }
      return engine.snapshotStreamChunkTail(workflowId, TOKENS_STREAM_KEY);
    },

    subscribeLive(workflowId, selector, listener) {
      if (selector === 'events') {
        return engine.subscribeEventLogCommits(workflowId, (record) => {
          listener(eventRecordToEnvelope(record, selector));
        });
      }
      return engine.subscribeStreamChunkCommits(workflowId, TOKENS_STREAM_KEY, (record) => {
        listener(streamRecordToEnvelope(record, selector));
      });
    },
  };
}

async function* replayEventLog(
  engine: Engine,
  workflowId: string,
  afterSequence: number,
): AsyncIterable<EventEnvelope> {
  for await (const record of engine.replayEventLog(workflowId, afterSequence)) {
    yield eventRecordToEnvelope(record, 'events');
  }
}

async function* replayTokenChunks(
  engine: Engine,
  workflowId: string,
  afterSequence: number,
): AsyncIterable<EventEnvelope> {
  for await (const record of engine.replayStreamChunks(
    workflowId,
    TOKENS_STREAM_KEY,
    afterSequence,
  )) {
    yield streamRecordToEnvelope(record, 'tokens');
  }
}

function eventRecordToEnvelope(
  record: EventLogCommitRecord,
  selector: EventSelector,
): EventEnvelope {
  return {
    kind: record.type,
    workflowId: record.workflowId,
    selector,
    sequence: record.sequence,
    cursor: encodeCursor(record.sequence),
    emittedAtMs: record.timestamp,
    payload: record.payload,
  };
}

function streamRecordToEnvelope(
  record: StreamChunkCommitRecord,
  selector: EventSelector,
): EventEnvelope {
  return {
    kind: STREAM_CHUNK_KIND,
    workflowId: record.workflowId,
    selector,
    sequence: record.sequence,
    cursor: encodeCursor(record.sequence),
    emittedAtMs: record.emittedAtMs,
    payload: record.value,
  };
}
