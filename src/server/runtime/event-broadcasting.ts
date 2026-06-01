import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import {
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AttributesChangedEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from '../../core/events.ts';
import { KEYS } from '../../storage/interface.ts';
import { claimNextSequence } from '../runtime-helpers.ts';
import type { ServerContext } from './context.ts';
import { cancelTask } from './task-dispatch.ts';
import { withRetry } from './websocket-worker.ts';

const TOKEN_EVENT_TYPE = 'stream:token';

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
  const data: Record<string, unknown> = {};

  // Extract all public properties from the event into the nested data bag
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    // Serialize Error objects to plain strings
    if (value instanceof Error) {
      data[key] = value.message;
    } else {
      data[key] = value;
    }
  }

  const message: { type: string; timestamp: number; data: Record<string, unknown> } = {
    type: event.type,
    timestamp: Date.now(),
    data,
  };

  return JSON.stringify(message);
}

/**
 * Result of wiring up engine-to-WebSocket event broadcasting.
 *
 * - `dispose`: removes all listeners (abort signal). Called on server shutdown.
 * - `cleanupWorkflow`: drops the per-workflow sequence state for the given
 *   workflow id. Should be invoked when a workflow reaches a terminal state
 *   so the bookkeeping maps do not grow unbounded over the server's lifetime.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import { wireEventBroadcasting, type EventBroadcastingHandle } from '@lostgradient/weft/server';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * const bunServer = Bun.serve({ fetch: () => new Response('ok') });
 * const handle: EventBroadcastingHandle = wireEventBroadcasting(engine, bunServer);
 * // Later, on shutdown:
 * handle.dispose();
 * ```
 */
export interface EventBroadcastingHandle {
  dispose: () => void;
  cleanupWorkflow: (workflowId: string) => void;
}

/**
 * Extract a `workflowId` from a DOM `Event` when the concrete event carries
 * one. All workflow, activity, token, signal, attribute, and update events
 * in `core/events.ts` expose a `workflowId: string` field, but the `Event`
 * base type does not know about it — so a runtime structural check narrows
 * the value before we use it to key bookkeeping maps. Returns `undefined`
 * for events without a string `workflowId` property.
 */
export function getWorkflowIdFromEvent(event: Event): string | undefined {
  if (!('workflowId' in event)) return undefined;
  const candidate = (event as { workflowId: unknown }).workflowId;
  return typeof candidate === 'string' ? candidate : undefined;
}

export function registerWorkflowEventLifecycle(
  engine: Engine,
  context: ServerContext,
  broadcastingHandle: EventBroadcastingHandle,
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
        cancelTask(context, operationId);
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
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import { wireEventBroadcasting } from '@lostgradient/weft/server';
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

  /** Ensure the sequence counter for a workflow is seeded from storage. */
  function ensureSequenceInitialized(workflowId: string): Promise<void> {
    const existing = sequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = KEYS.eventPrefix(workflowId);
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        // Key format: ev:{workflowId}:{zero-padded sequence}
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
    await ensureSequenceInitialized(workflowId);

    const parsed = JSON.parse(message) as {
      type: string;
      timestamp: number;
      data: Record<string, unknown>;
    };

    // Claim the sequence number once — outside the retry scope so a
    // failed storage write doesn't consume an additional number.
    const sequence = claimNextSequence(sequenceCounters, workflowId);
    const storageKey = KEYS.event(workflowId, sequence);
    const encoded = encode(parsed);

    await withRetry(
      async () => engine.storage.put(storageKey, encoded),
      `persist event "${eventType}" for workflow "${workflowId}"`,
    );

    // Publish to the workflow's watch channel
    const watchChannel = workflowChannelPath(workflowId, 'watch');
    server.publish(watchChannel, message);

    // For token events, also publish to the stream channel
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
          engine.storage.put(
            KEYS.streamChunk(workflowId, 'tokens', tokenSequence),
            encode(tokenPayload),
          ),
        `persist token stream chunk for workflow "${workflowId}"`,
      );

      const streamMessage = JSON.stringify({
        ...parsed,
        sequence: tokenSequence,
        data: tokenPayload,
      });
      if (options?.publishTokenMessage) {
        options.publishTokenMessage(workflowId, tokenSequence, streamMessage);
      } else {
        const streamChannel = workflowChannelPath(workflowId, 'stream');
        server.publish(streamChannel, streamMessage);
      }
    }
  }

  const eventTypes = [
    WorkflowStartedEvent.type,
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
    ActivityStartedEvent.type,
    ActivityCompletedEvent.type,
    ActivityFailedEvent.type,
    TOKEN_EVENT_TYPE,
    SignalReceivedEvent.type,
    SignalDeliveredEvent.type,
    AttributesChangedEvent.type,
    UpdateReceivedEvent.type,
    UpdateCompletedEvent.type,
  ] as const;

  for (const eventType of eventTypes) {
    engine.addEventListener(
      eventType,
      (event) => {
        const workflowId = getWorkflowIdFromEvent(event);
        if (workflowId === undefined) return;

        const message = serializeEvent(event);
        if (message === null) return;

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
    dispose: () => controller.abort(),
    cleanupWorkflow,
  };
}
