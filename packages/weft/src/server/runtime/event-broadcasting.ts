import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import {
  encodeStoredStreamTailSequence,
  loadStoredStreamTailSequence,
} from '../../core/engine/stream-chunk-loading.ts';
import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../../core/events.ts';
import { getWorkflowIdFromEvent } from '../../core/events/workflow-event-id.ts';
import { KEYS } from '../../storage/keys.ts';
import type { FleetEventFeed } from '../fleet-event-feed.ts';
import type { ServeOptions } from '../index.ts';
import { claimNextSequence } from '../runtime-helpers.ts';
import {
  CLIENT_VISIBLE_EVENT_TYPES,
  serializeClientVisibleEventData,
  TOKEN_EVENT_TYPE,
} from './client-visible-events.ts';
import type { ServerContext } from './context.ts';
import { cancelTask } from './task-dispatch.ts';
import { withRetry } from './websocket-worker.ts';

function workflowChannelPath(workflowId: string, connectionType: 'watch' | 'stream'): string {
  return `/v1/workflows/${encodeURIComponent(workflowId)}/${connectionType}`;
}

/**
 * Serialize an engine event to a JSON message for WebSocket clients.
 *
 * The wire format matches the dashboard's `WorkflowEvent` interface:
 * `{ type: string; timestamp: number; data: Record<string, unknown> }`.
 */
function serializeEvent(event: Event): string | null {
  const message: { type: string; timestamp: number; data: Record<string, unknown> } = {
    type: event.type,
    timestamp: Date.now(),
    data: serializeClientVisibleEventData(event),
  };

  return JSON.stringify(message);
}

/**
 * Result of wiring up engine-to-WebSocket event broadcasting.
 *
 * - `dispose`: removes all listeners (abort signal), then settles once every event write already
 *   in flight has settled: the storage write of each queued event and every fleet-feed append, so
 *   the caller may release the storage under them. An event dispatched after the call is not
 *   written. A write that fails is logged where it is logged otherwise and does not reject the
 *   returned promise. The wait has no deadline of its own: a write that never settles holds it.
 *   Called on server shutdown.
 * - `cleanupWorkflow`: drops the per-workflow sequence state for the given
 *   workflow id. Should be invoked when a workflow reaches a terminal state
 *   so the bookkeeping maps do not grow unbounded over the server's lifetime.
 *
 * @example
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { wireEventBroadcasting, type EventBroadcastingHandle } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * const bunServer = Bun.serve({ fetch: () => new Response('ok') });
 * const handle: EventBroadcastingHandle = wireEventBroadcasting(engine, bunServer);
 * // Later, on shutdown:
 * await handle.dispose();
 * ```
 */
export interface EventBroadcastingHandle {
  dispose: () => Promise<void>;
  cleanupWorkflow: (workflowId: string) => void;
}

export function registerWorkflowEventLifecycle(
  engine: Engine,
  context: ServerContext,
  broadcastingHandle: EventBroadcastingHandle,
  options: ServeOptions,
): () => void {
  // Clean up per-workflow state when workflows reach a terminal state:
  // both the sticky-routing affinity map and the event-broadcasting sequence
  // maps retain entries keyed by workflow id, and neither is bounded by
  // anything other than "workflows observed for the lifetime of the process".
  const affinityController = new AbortController();
  const terminalEventTypes = [
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
  ] as const;

  for (const eventType of terminalEventTypes) {
    engine.addEventListener(
      eventType,
      (event) => {
        const workflowId = getWorkflowIdFromEvent(event);
        if (workflowId) {
          context.workerAffinity.delete(workflowId);
          broadcastingHandle.cleanupWorkflow(workflowId);
        }
      },
      { signal: affinityController.signal },
    );
  }

  // Propagate workflow cancellation to in-flight workers.
  const cancelPropagationController = new AbortController();
  engine.addEventListener(
    WorkflowCancelledEvent.type,
    (event) => {
      const workflowId = getWorkflowIdFromEvent(event);
      if (!workflowId) return;

      const operationIds = context.workflowOperations.get(workflowId);
      if (!operationIds || operationIds.size === 0) return;

      for (const operationId of operationIds) {
        void cancelTask(context, options, operationId, 'Workflow cancelled').catch((error) => {
          console.error(
            `[weft] Failed to propagate workflow cancellation to task "${operationId}":`,
            error,
          );
        });
        context.operationToWorkflow.delete(operationId);
      }

      // Clean up the reverse index entry now that all operations are cancelled.
      context.workflowOperations.delete(workflowId);
    },
    { signal: cancelPropagationController.signal },
  );

  return () => {
    affinityController.abort();
    cancelPropagationController.abort();
  };
}

/**
 * Attach event listeners to the engine that broadcast events via WebSocket
 * and persist each event to storage so `GET /v1/workflows/:id/events` returns data.
 * Returns a handle exposing a cleanup function and a per-workflow eviction hook.
 *
 * @param engine - The engine whose events will be listened to.
 * @param server - The Bun server used to `server.publish()` WebSocket messages.
 * @param options.publishTokenMessage - Optional override for token-event delivery.
 *   When provided, this callback is called instead of `server.publish()` for
 *   token messages, enabling per-workflow stream sockets to be used in
 *   place of the default pub/sub channel. Leave unset unless you manage stream
 *   sockets separately (as `serve()` does internally).
 * @param options.publishWatchMessage - Optional override for watch-event delivery.
 *   When provided, this callback is called instead of `server.publish()` for
 *   watch messages, enabling per-socket replay buffering during catch-up.
 *
 * @example
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 * import { wireEventBroadcasting } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * const bunServer = Bun.serve({ fetch: () => new Response('ok') });
 * const handle = wireEventBroadcasting(engine, bunServer);
 *
 * // Wire a terminal-event listener to clean up per-workflow bookkeeping.
 * engine.addEventListener('workflow:completed', (e) => {
 *   const workflowId = (e as { workflowId?: string }).workflowId;
 *   if (workflowId) handle.cleanupWorkflow(workflowId);
 * });
 *
 * // On server shutdown, remove all event listeners.
 * handle.dispose();
 * ```
 */
export function wireEventBroadcasting(
  engine: Engine,
  server: ReturnType<typeof Bun.serve>,
  options?: {
    publishTokenMessage?: (workflowId: string, sequence: number, message: string) => void;
    publishWatchMessage?: (workflowId: string, sequence: number, message: string) => void;
    fleetEventFeed?: FleetEventFeed;
  },
): EventBroadcastingHandle {
  const controller = new AbortController();
  const { signal } = controller;

  /**
   * Per-workflow monotonic sequence counter for event storage keys.
   *
   * On first access for a given workflow, the counter is initialized from
   * storage by scanning for the highest existing event key. This prevents
   * sequence numbers from resetting to 0 after a server restart, which would
   * silently overwrite previously persisted events.
   */
  const sequenceCounters = new Map<string, number>();
  const sequenceInitPromises = new Map<string, Promise<void>>();
  const tokenSequenceCounters = new Map<string, number>();
  const tokenSequenceInitPromises = new Map<string, Promise<void>>();

  /**
   * Per-workflow serialization chain. Each workflow's events are persisted
   * sequentially by chaining promises—this eliminates the read-modify-write
   * race on `sequenceCounters` without requiring an explicit mutex.
   */
  const sequenceChains = new Map<string, Promise<void>>();
  // Fleet-feed appends of events that belong to no workflow, so they sit on no chain. `dispose`
  // waits for them too.
  const pendingWorkflowlessAppends = new Set<Promise<void>>();

  /** Ensure the sequence counter for a workflow is seeded from storage. */
  function ensureSequenceInitialized(workflowId: string): Promise<void> {
    const existing = sequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = KEYS.watchEventPrefix(workflowId);
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        // Key format: watch-event:{workflowId}:{zero-padded sequence}
        const parts = key.split(':');
        const sequencePart = parts[parts.length - 1];
        if (sequencePart !== undefined) {
          highestSequence = parseInt(sequencePart, 10);
        }
      }

      // Start after the highest existing sequence number.
      sequenceCounters.set(workflowId, highestSequence + 1);
    })().catch((error) => {
      // Clear the cached promise so a subsequent event can retry initialization
      // instead of perpetually reusing a rejected promise.
      sequenceInitPromises.delete(workflowId);
      throw error;
    });

    sequenceInitPromises.set(workflowId, promise);
    return promise;
  }

  /** Ensure the token-stream chunk counter is seeded from durable storage. */
  function ensureTokenSequenceInitialized(workflowId: string): Promise<void> {
    const existing = tokenSequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const storedTailSequence = await loadStoredStreamTailSequence(
        engine.storage,
        workflowId,
        'tokens',
      );
      if (storedTailSequence !== null) {
        tokenSequenceCounters.set(workflowId, storedTailSequence + 1);
        return;
      }

      const prefix = KEYS.streamChunkPrefix(workflowId, 'tokens');
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        const sequenceText = key.slice(prefix.length);
        const parsedSequence = Number.parseInt(sequenceText, 10);
        if (Number.isSafeInteger(parsedSequence)) {
          highestSequence = parsedSequence;
        }
      }

      tokenSequenceCounters.set(workflowId, highestSequence + 1);
    })().catch((error) => {
      tokenSequenceInitPromises.delete(workflowId);
      throw error;
    });

    tokenSequenceInitPromises.set(workflowId, promise);
    return promise;
  }

  /** Persist an event to storage and publish to WebSocket channels. */
  async function persistAndPublishEvent(
    workflowId: string,
    eventType: string,
    message: string,
  ): Promise<void> {
    const parsed = JSON.parse(message) as {
      type: string;
      timestamp: number;
      data: Record<string, unknown>;
    };

    if (eventType === TOKEN_EVENT_TYPE) {
      const tokenPayload = {
        workflowId:
          typeof parsed.data['workflowId'] === 'string' ? parsed.data['workflowId'] : workflowId,
        token: typeof parsed.data['token'] === 'string' ? parsed.data['token'] : '',
        model: typeof parsed.data['model'] === 'string' ? parsed.data['model'] : '',
      };
      await ensureTokenSequenceInitialized(workflowId);
      const tokenSequence = claimNextSequence(tokenSequenceCounters, workflowId);
      await withRetry(
        async () =>
          engine.storage.batch([
            {
              type: 'put',
              key: KEYS.streamChunk(workflowId, 'tokens', tokenSequence),
              value: encode(tokenPayload),
            },
            {
              type: 'put',
              key: KEYS.streamTail(workflowId, 'tokens'),
              value: encodeStoredStreamTailSequence(tokenSequence),
            },
          ]),
        `persist token stream chunk for workflow "${workflowId}"`,
      );

      const streamMessage = JSON.stringify({
        type: parsed.type,
        timestamp: parsed.timestamp,
        sequence: tokenSequence,
        cursor: String(tokenSequence),
        data: tokenPayload,
      });
      if (options?.publishTokenMessage) {
        options.publishTokenMessage(workflowId, tokenSequence, streamMessage);
      } else {
        const streamChannel = workflowChannelPath(workflowId, 'stream');
        server.publish(streamChannel, streamMessage);
      }
      return;
    }

    await ensureSequenceInitialized(workflowId);

    // Claim the sequence number once — outside the retry scope so a
    // failed storage write doesn't consume an additional number.
    const sequence = claimNextSequence(sequenceCounters, workflowId);
    const watchMessage = JSON.stringify({
      type: parsed.type,
      timestamp: parsed.timestamp,
      data: parsed.data,
      sequence,
      cursor: String(sequence),
    });
    const storageKey = KEYS.watchEvent(workflowId, sequence);
    const encoded = encode(JSON.parse(watchMessage));

    await withRetry(
      async () => engine.storage.put(storageKey, encoded),
      `persist event "${eventType}" for workflow "${workflowId}"`,
    );

    await appendFleetEvent(options?.fleetEventFeed, eventType, workflowId, message);

    // Publish to the workflow's watch channel
    if (options?.publishWatchMessage) {
      options.publishWatchMessage(workflowId, sequence, watchMessage);
    } else {
      const watchChannel = workflowChannelPath(workflowId, 'watch');
      server.publish(watchChannel, watchMessage);
    }
  }

  for (const eventType of CLIENT_VISIBLE_EVENT_TYPES) {
    engine.addEventListener(
      eventType,
      (event) => {
        const workflowId = getWorkflowIdFromEvent(event);
        const message = serializeEvent(event);
        if (message === null) return;
        if (workflowId === undefined) {
          // `appendFleetEvent` reports its own failure and never rejects.
          const append = appendFleetEvent(options?.fleetEventFeed, eventType, undefined, message);
          pendingWorkflowlessAppends.add(append);
          void append.then(() => pendingWorkflowlessAppends.delete(append));
          return;
        }

        // Persist the event to storage for the REST events endpoint.
        // Sequence initialization is async (reads storage on first access per
        // workflow), so chain the persistence behind it. WebSocket publishing
        // is deferred until persistence succeeds so clients never see events
        // that failed to store.
        //
        // Events for the same workflow are serialized through `sequenceChains`
        // to prevent concurrent handlers from racing on `nextSequence`.
        const previousChain = sequenceChains.get(workflowId) ?? Promise.resolve();
        const nextChain = previousChain
          .then(() => persistAndPublishEvent(workflowId, eventType, message))
          .catch((error) => {
            console.error(
              `[weft] Failed to persist event "${eventType}" for workflow "${workflowId}":`,
              error,
            );
          });
        sequenceChains.set(workflowId, nextChain);
        // Cleanup for terminal events lives in a dedicated listener that
        // calls `cleanupWorkflow(workflowId)` — see the consumer of the
        // returned handle in `serve()`. That path handles chain extension
        // (new events arriving after the terminal event) correctly; doing
        // the cleanup inline here would race with it.
      },
      { signal },
    );
  }

  /**
   * Drop the per-workflow bookkeeping for a workflow that has reached a
   * terminal state. Waits for any in-flight persistence on the workflow's
   * serialization chain to settle before removing the entries — otherwise a
   * racing handler could reinsert them via `persistAndPublishEvent`.
   *
   * Concurrency: between capturing `pendingChain` and the `finally` running
   * `drop`, another event for the same workflow could arrive and extend the
   * chain. We drop the entries only once we observe that the chain has not
   * advanced during the await, and otherwise recurse to wait for the new
   * tail. Without this loop, `drop` could fire while a subsequent
   * `persistAndPublishEvent` was still using the counter, producing a
   * "counter accessed before initialization" error on the next event.
   */
  function cleanupWorkflow(workflowId: string): void {
    const pendingChain = sequenceChains.get(workflowId);
    const drop = (): void => {
      sequenceCounters.delete(workflowId);
      sequenceInitPromises.delete(workflowId);
      tokenSequenceCounters.delete(workflowId);
      tokenSequenceInitPromises.delete(workflowId);
      sequenceChains.delete(workflowId);
    };
    if (!pendingChain) {
      drop();
      return;
    }
    void pendingChain.finally(() => {
      // If another event extended the chain while we were awaiting the
      // previous tail, recurse to wait on the new tail.
      if (sequenceChains.get(workflowId) !== pendingChain) {
        cleanupWorkflow(workflowId);
        return;
      }
      drop();
    });
  }

  return {
    dispose: async () => {
      // Listeners go first, so no chain starts after this snapshot. Every chain already catches
      // its own failure, so none of these rejects.
      controller.abort();
      await Promise.all([...sequenceChains.values(), ...pendingWorkflowlessAppends]);
    },
    cleanupWorkflow,
  };
}

async function appendFleetEvent(
  fleetEventFeed: FleetEventFeed | undefined,
  eventType: string,
  workflowId: string | undefined,
  message: string,
): Promise<void> {
  if (eventType === TOKEN_EVENT_TYPE) return;
  if (fleetEventFeed === undefined) return;
  try {
    const parsed = JSON.parse(message) as {
      type: string;
      timestamp: number;
      data: Record<string, unknown>;
    };
    const event = {
      kind: eventType,
      emittedAtMs: parsed.timestamp,
      payload: parsed.data,
    };
    if (workflowId === undefined) {
      await fleetEventFeed.append(event);
      return;
    }
    await fleetEventFeed.appendWorkflowEventIfPresent({
      ...event,
      workflowId,
    });
  } catch (error) {
    console.error(`[weft] Failed to append fleet event "${eventType}":`, error);
  }
}
