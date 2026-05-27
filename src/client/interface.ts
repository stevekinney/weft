/**
 * Shared client interface for Weft. Both {@link LocalClient} and
 * {@link HttpClient} implement this contract so switching between
 * library mode and server mode is a constructor change, not an API change.
 *
 * @module client/interface
 */

import type { StoredStreamChunk } from '../core/context.ts';
import type { TypedEventTarget, WeftEventMap } from '../core/events.ts';
import type {
  AttributeFilterKey,
  BulkCancelResult,
  BulkDeleteResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  PaginatedResult,
  PurgeResult,
  QueryDefinition,
  RetentionOverview,
  ReviewListEntry,
  ReviewListFilter,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSummary,
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
  StartOptions,
  SubmitReviewOptions,
  TypedListFilter,
  UpdateDefinition,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from '../core/types.ts';

// ---------------------------------------------------------------------------
// Client handle — lightweight reference to a running workflow
// ---------------------------------------------------------------------------

/**
 * A reference to a workflow that provides convenience methods.
 *
 * Extends {@link TypedEventTarget} so callers can observe workflow lifecycle
 * events with the same `addEventListener` / `removeEventListener` API in both
 * library mode (events flow through `EventTarget` directly) and server mode
 * (events are bridged over WebSocket).
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient, type WorkflowCompletedEvent } from 'weft';
 * import type { ClientHandle } from 'weft/client';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 *
 * const client = new LocalClient(engine);
 * const handle: ClientHandle = await client.start('ping', null);
 * handle.addEventListener('workflow:completed', (e) => {
 *   console.log('completed', (e as WorkflowCompletedEvent).result);
 * });
 * const result = await handle.result();
 * console.log(result); // 'pong'
 * ```
 */
export interface ClientHandle extends TypedEventTarget<WeftEventMap>, Disposable {
  /** The workflow's unique identifier. */
  readonly id: string;

  /** Resolves when the workflow completes (or rejects on failure). */
  result(): Promise<unknown>;

  /** Cancel this workflow. */
  cancel(): Promise<void>;

  /** Send a named signal with an optional payload. */
  signal(name: SignalDefinition): Promise<void>;
  signal<TInput>(
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  signal(name: string, payload?: unknown, options?: SignalDeliveryOptions): Promise<void>;

  /** Submit a synchronous update and return the handler's result. */
  update<TOutput>(
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  update<TInput, TOutput>(
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;

  /** Query a named read-only accessor on the running workflow. */
  query<TOutput>(name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  query<TInput, TOutput>(name: QueryDefinition<TInput, TOutput>, input: TInput): Promise<TOutput>;
  query(name: string, input?: unknown): Promise<unknown>;

  /** Get search attributes for this workflow. */
  getAttributes(): Promise<Record<string, SearchAttributeValue> | null>;

  /** Set search attributes on this workflow (merge semantics). */
  setAttributes(attributes: Record<string, SearchAttributeValue>): Promise<void>;

  /** Add free-form tags to this workflow. */
  addTags(...tags: string[]): Promise<void>;

  /** Remove free-form tags from this workflow. */
  removeTags(...tags: string[]): Promise<void>;
}

/**
 * A reference to a recurring schedule that provides convenience methods.
 *
 * Mirrors the core {@link ScheduleHandle} surface without leaking the engine
 * implementation type into the transport-neutral client contract.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient } from 'weft';
 * import type { ClientScheduleHandle } from 'weft/client';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(workflow({ name: 'report' }).execute(async function* () { return 'sent'; }));
 *
 * const client = new LocalClient(engine);
 * const handle: ClientScheduleHandle = await client.schedule('report', {}, '0 9 * * 1');
 * await handle.pause();
 * console.log(handle.id);
 * ```
 */
export interface ClientScheduleHandle extends Disposable {
  /** The schedule's unique identifier. */
  readonly id: string;

  /** Pause this schedule. */
  pause(): Promise<void>;

  /** Resume this schedule. */
  resume(): Promise<void>;

  /** Cancel this schedule. */
  cancel(): Promise<void>;

  /** Update the schedule's cron expression. */
  update(newCronExpression: string): Promise<void>;

  /** Read the latest persisted summary for this schedule. */
  describe(): Promise<ScheduleSummary | null>;
}

// ---------------------------------------------------------------------------
// Update result (subset of internal UpdateResponse)
// ---------------------------------------------------------------------------

/** Result of a coordinated update request. */
export type UpdateResult = {
  updateId: string;
  result?: unknown;
  error?: string;
} | null;

// ---------------------------------------------------------------------------
// WeftClient interface
// ---------------------------------------------------------------------------

/**
 * Operations shared by both in-process and HTTP clients.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient, type WeftClient } from 'weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(workflow({ name: 'my-workflow' }).execute(async function* () { return 42; }));
 * const client: WeftClient = new LocalClient(engine);
 * const handle = await client.start('my-workflow', { input: 42 });
 * const result = await handle.result();
 * console.log(result); // 42
 * ```
 */
export interface WeftClient {
  /** Start a new workflow and return a handle to it. */
  start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle>;

  /** Register a recurring schedule and return a handle to it. */
  schedule(
    type: string,
    input: unknown,
    cronExpression: string,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle>;

  /** Get the full persisted state of a workflow, or `null` if not found. */
  get(id: string): Promise<WorkflowState | null>;

  /** Get the current summary of a recurring schedule, or `null` if not found. */
  getSchedule(id: string): Promise<ScheduleSummary | null>;

  /** List workflows with optional filtering and pagination. */
  list<const TAttributeKeys extends readonly AttributeFilterKey[] = readonly AttributeFilterKey[]>(
    filter?: TypedListFilter<TAttributeKeys>,
  ): Promise<PaginatedResult<WorkflowSummary>>;

  /** List recurring schedules with optional filtering and pagination. */
  listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>>;

  /** Cancel a running workflow. */
  cancel(id: string): Promise<void>;

  /** Pause a recurring schedule. */
  pauseSchedule(id: string): Promise<void>;

  /** Resume a recurring schedule. */
  resumeSchedule(id: string): Promise<void>;

  /** Cancel a recurring schedule. */
  cancelSchedule(id: string): Promise<void>;

  /** Update a recurring schedule's cron expression. */
  updateSchedule(id: string, newCronExpression: string): Promise<void>;

  /** Send a named signal to a workflow. */
  signal(id: string, name: SignalDefinition): Promise<void>;
  signal<TInput>(
    id: string,
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  signal(
    id: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;

  /** Query a named read-only accessor on a running workflow. */
  query<TOutput>(id: string, name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  query<TInput, TOutput>(
    id: string,
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  query(id: string, name: string, input?: unknown): Promise<unknown>;

  /** Submit a synchronous update to a running workflow. */
  update<TOutput>(
    id: string,
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  update<TInput, TOutput>(
    id: string,
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;

  /** Resume a failed or timed-out workflow. */
  resume(id: string): Promise<ClientHandle>;

  /** Recover all interrupted workflows. */
  recoverAll(): Promise<ClientHandle[]>;

  /** Force-timeout a workflow. */
  timeout(id: string): Promise<void>;

  /** Get search attributes for a workflow. */
  getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null>;

  /** Set search attributes on a workflow. */
  setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void>;

  /** Add free-form tags to a workflow. */
  addTags(id: string, ...tags: string[]): Promise<void>;

  /** Remove free-form tags from a workflow. */
  removeTags(id: string, ...tags: string[]): Promise<void>;

  /** Get the event history for a workflow. */
  getEvents(id: string): Promise<WorkflowEvent[]>;

  /**
   * Get the structured execution timeline for a workflow.
   * Returns `[]` when the workflow is missing or has no retained timeline entries.
   */
  getTimeline(id: string): Promise<WorkflowTimelineEntry[]>;

  /** Reconstruct workflow state at a historical checkpoint step. */
  replayTo(id: string, step: number): Promise<WorkflowReplay | null>;

  /** List human review requests, optionally filtering by status or workflow metadata. */
  listReviews(filter?: ReviewListFilter): Promise<ReviewListEntry[]>;

  /** Submit a decision for a pending review. */
  submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void>;

  /** Read stream chunks back from storage for a completed stream operation. */
  getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): Promise<StoredStreamChunk[]>;

  /** Fork a workflow from its latest or a historical checkpoint. */
  fork(id: string, options?: ForkOptions): Promise<ClientHandle>;
  /** Get the configured workflow retention policies and next sweep time. */
  getRetentionOverview(): Promise<RetentionOverview>;

  /** Purge matching terminal workflows. */
  purge(filter?: ListFilter): Promise<PurgeResult>;

  /** Cancel all running or pending workflows that match a filter. */
  cancelAll(filter: ListFilter): Promise<BulkCancelResult>;

  /** Signal all running or pending workflows that match a filter. */
  signalAll(filter: ListFilter, name: string, payload?: unknown): Promise<BulkSignalResult>;

  /** Delete all matching terminal workflows. */
  deleteAll(filter: ListFilter): Promise<BulkDeleteResult>;

  /** Add tags to all workflows that match a filter. */
  tagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult>;

  /** Remove tags from all workflows that match a filter. */
  untagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult>;

  /** Submit a coordinated update and wait for the result. */
  submitCoordinatedUpdate(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult>;

  /** Retrieve the result of a previously submitted coordinated update. */
  getUpdateResult(updateId: string): Promise<UpdateResult>;
}
