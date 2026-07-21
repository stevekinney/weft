/**
 * In-memory `WorkflowEventFeedBackend` for tests and local development —
 * no storage, no `Engine`, just a `Map` of buckets. Production code should
 * use `createEngineEventFeedBackend()` instead.
 *
 * @module server/in-memory-event-feed-backend
 */

import type {
  EventEnvelope,
  EventSelector,
  WorkflowEventFeedBackend,
} from './workflow-event-feed.ts';

export type InMemoryEventBackend = WorkflowEventFeedBackend & {
  append(envelope: EventEnvelope): Promise<void>;
  emitLive(envelope: EventEnvelope): Promise<void>;
};

function bucketKey(workflowId: string, selector: EventSelector): string {
  return `${workflowId}:${selector}`;
}

/**
 * Build an in-memory `WorkflowEventFeedBackend` — useful for tests and local
 * development that need a working feed without an `Engine` or storage
 * backend. Pass the result to `createWorkflowEventFeed()`. Not part of the
 * published package surface — an internal test/dev helper only.
 */
export function createInMemoryEventBackend(): InMemoryEventBackend {
  const storage = new Map<string, EventEnvelope[]>();
  const listeners = new Map<string, Set<(envelope: EventEnvelope) => void>>();

  function fireLive(envelope: EventEnvelope): void {
    const set = listeners.get(bucketKey(envelope.workflowId, envelope.selector));
    if (!set) return;
    for (const listener of set) {
      try {
        listener(envelope);
      } catch {
        // Listener errors must not corrupt the producer.
      }
    }
  }

  return {
    async *replay(options) {
      const bucket = storage.get(bucketKey(options.workflowId, options.selector));
      if (!bucket) return;
      // Always scan in sequence order, regardless of append order.
      const sorted = [...bucket].toSorted((a, b) => a.sequence - b.sequence);
      for (const envelope of sorted) {
        if (envelope.sequence > options.afterSequence) {
          yield envelope;
        }
      }
    },

    async snapshotTailSequence(workflowId, selector) {
      const bucket = storage.get(bucketKey(workflowId, selector));
      if (!bucket || bucket.length === 0) return -1;
      let max = -1;
      for (const envelope of bucket) {
        if (envelope.sequence > max) max = envelope.sequence;
      }
      return max;
    },

    subscribeLive(workflowId, selector, listener) {
      const k = bucketKey(workflowId, selector);
      let set = listeners.get(k);
      if (!set) {
        set = new Set();
        listeners.set(k, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) listeners.delete(k);
      };
    },

    async append(envelope) {
      const k = bucketKey(envelope.workflowId, envelope.selector);
      let bucket = storage.get(k);
      if (!bucket) {
        bucket = [];
        storage.set(k, bucket);
      }
      bucket.push(envelope);
      fireLive(envelope);
    },

    async emitLive(envelope) {
      fireLive(envelope);
    },
  };
}
