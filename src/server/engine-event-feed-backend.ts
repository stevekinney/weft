/**
 * Engine-backed `WorkflowEventFeedBackend` — the production backing
 * for `createWorkflowEventFeed` (see `workflow-event-feed.ts`). REST
 * SSE, the JSON-RPC WebSocket session, and the JSON-RPC stdio session
 * all consume the feed; this module is where the feed meets the
 * `Engine`'s durable state.
 *
 * **Single committed sequence authority.** Replay and live delivery
 * share the same source of truth — the unified
 * `replayWorkflowFeed` / `snapshotWorkflowFeedTail` /
 * `subscribeWorkflowFeedCommits` triple on `Engine`. The subscription
 * fires only AFTER `storage.batch()` (events) or `storage.put()`
 * (tokens) resolves, so an event in the live buffer is already
 * durable and scannable by `replayWorkflowFeed`. This is the
 * invariant the feed's atomic-handoff (buffer-then-snapshot-then-
 * replay-then-drain) relies on.
 *
 * The backend is intentionally stateless — it holds only the `Engine`
 * reference. Listener state lives on the engine and is cleaned up by
 * the caller's unsubscribe function.
 *
 * @module server/engine-event-feed-backend
 */

import type { Engine, WorkflowFeedRecord, WorkflowFeedSelector } from '../core/engine.ts';
import {
  encodeCursor,
  type EventEnvelope,
  type EventSelector,
  type WorkflowEventFeedBackend,
} from './workflow-event-feed.ts';

/**
 * Build the production `WorkflowEventFeedBackend`. Call once per
 * engine instance and share the returned backend across every
 * transport that needs a feed.
 */
export function createEngineEventFeedBackend(engine: Engine): WorkflowEventFeedBackend {
  return {
    async *replay({ workflowId, selector, afterSequence }) {
      const coreSelector = toCoreSelector(selector);
      for await (const record of engine.replayWorkflowFeed(
        workflowId,
        coreSelector,
        afterSequence,
      )) {
        yield recordToEnvelope(record);
      }
    },

    snapshotTailSequence(workflowId, selector) {
      return engine.snapshotWorkflowFeedTail(workflowId, toCoreSelector(selector));
    },

    subscribeLive(workflowId, selector, listener) {
      return engine.subscribeWorkflowFeedCommits(
        workflowId,
        toCoreSelector(selector),
        // Return the listener's call result — if the listener is
        // structurally `(e) => void` but actually an async function
        // (TypeScript allows the widening), we must propagate its
        // returned promise to the engine's `#notifyWorkflowFeedCommit`
        // so the engine's rejection handler can swallow it. Wrapping
        // in a block body that discards the return value would leak
        // async rejections past the engine and surface as a
        // process-level unhandled-rejection event.
        (record) => listener(recordToEnvelope(record)),
      );
    },
  };
}

/**
 * The feed's `EventSelector` and the engine's `WorkflowFeedSelector`
 * are structurally identical (`'events' | 'tokens'`) but live in
 * different modules so the core engine does not depend on the server
 * package. This guard keeps the boundary explicit: if a new selector
 * is ever added to one side, the mismatch surfaces as a compile
 * error here instead of a silent fall-through in a switch.
 */
function toCoreSelector(selector: EventSelector): WorkflowFeedSelector {
  if (selector === 'events') return 'events';
  if (selector === 'tokens') return 'tokens';
  selector satisfies never;
  throw new Error(`Unhandled EventSelector: ${String(selector)}`);
}

function recordToEnvelope(record: WorkflowFeedRecord): EventEnvelope {
  return {
    kind: record.kind,
    workflowId: record.workflowId,
    selector: record.selector,
    sequence: record.sequence,
    cursor: encodeCursor(record.sequence),
    emittedAtMs: record.timestamp,
    payload: record.payload,
  };
}
