import type { Storage } from '../storage/interface.ts';
import { createFleetEventFeedOperations } from './fleet-event-feed-operations.ts';
import type {
  Cursor,
  FleetEventAppendOptions,
  FleetEventEnvelope,
  FleetEventFeedOptions,
  FleetEventInput,
  FleetWorkflowEventInput,
  ReplayLiveSubscribeOptions,
} from './workflow-event-feed.ts';

export type {
  FleetEventAppendOptions,
  FleetEventEnvelope,
  FleetEventFeedOptions,
  FleetEventGapEnvelope,
  FleetEventInput,
  FleetWorkflowEventInput,
} from './workflow-event-feed.ts';

/**
 * Append cross-workflow events, replay history, then subscribe for live delivery. This is the shape
 * of `HandlerOptions.fleetEventFeed` — build a real one with
 * `createFleetEventFeed()` to drive `/v1/events/sse` through `handleRequest()`
 * without `serve()`.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 * import { createFleetEventFeed, type FleetEventFeed } from '@lostgradient/weft';
 *
 * const engine = new Engine({ storage: new MemoryStorage() });
 * const fleetEventFeed: FleetEventFeed = createFleetEventFeed(engine.storage);
 * void fleetEventFeed;
 * ```
 */
export type FleetEventFeed = {
  append(event: FleetEventInput, options?: FleetEventAppendOptions): Promise<FleetEventEnvelope>;
  appendWorkflowEventIfPresent(event: FleetWorkflowEventInput): Promise<FleetEventEnvelope | null>;
  /**
   * Replay retained fleet events. Pass `workflowId` to serve only that
   * workflow's retained events from the `fleet-event-by-workflow:` secondary
   * index instead of scanning the entire retained fleet log — see
   * `replayForWorkflow` for the indexed algorithm. Omitting `workflowId`
   * replays the full fleet feed exactly as before. Both forms share the same
   * cursor, `limit`, and retention-gap (`fleet:gap`) semantics.
   */
  replay(options?: {
    workflowId?: string;
    fromCursor?: Cursor;
    limit?: number;
  }): AsyncIterable<FleetEventEnvelope>;
  subscribe(
    options?: ReplayLiveSubscribeOptions<FleetEventEnvelope>,
  ): AsyncIterable<FleetEventEnvelope>;
  snapshotTailSequence(): Promise<number>;
  snapshotRetentionFloor(): Promise<number>;
  retain(options: { beforeSequence: number; limit?: number }): Promise<number>;
  dispose(): void;
};

/**
 * Build a `FleetEventFeed` backed by the given `Storage` — typically
 * `engine.storage` and share it across every fleet transport.
 * @example
 * ```ts
 * import { MemoryStorage } from '@lostgradient/weft';
 * import { createFleetEventFeed } from '@lostgradient/weft';
 * const feed = createFleetEventFeed(new MemoryStorage());
 * ```
 */
export function createFleetEventFeed(
  storage: Storage,
  feedOptions?: FleetEventFeedOptions,
): FleetEventFeed {
  if (!storage.capabilities().conditionalBatch) {
    throw new Error('Fleet event feeds require storage with conditional batch support.');
  }
  const livePollIntervalMs = feedOptions?.livePollIntervalMs ?? 100;
  if (!Number.isSafeInteger(livePollIntervalMs) || livePollIntervalMs < 1) {
    throw new RangeError('Fleet event live poll interval must be positive.');
  }
  return createFleetEventFeedOperations(storage, livePollIntervalMs);
}
