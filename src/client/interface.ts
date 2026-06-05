/**
 * Shared client interface for Weft. Both {@link LocalClient} and
 * {@link HttpClient} implement this contract so switching between
 * library mode and server mode is a constructor change, not an API change.
 *
 * @module client/interface
 */

import type {
  CatalogOperationName,
  CatalogOperationTypes,
  WeftClient as CatalogOperations,
} from '../cli/generated/operation-client.generated.ts';
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
  ScheduleSpec,
  ScheduleSummary,
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
  StartOptions,
  StartOrSignalSignal,
  SubmitReviewOptions,
  TypedListFilter,
  UpdateDefinition,
  WorkflowEvent,
  WorkflowInput,
  WorkflowOutput,
  WorkflowRegistry,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from '../core/types.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import type { KnownWorkflowName, UnknownNameWhenRegistryEmpty } from './workflow-name-typing.ts';

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
 * import { workflow, Engine, MemoryStorage, LocalClient, type WorkflowCompletedEvent } from '@lostgradient/weft';
 * import type { ClientHandle } from '@lostgradient/weft/client';
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
 *
 * The `TResult` parameter carries the workflow's output type. It defaults to
 * `unknown`, so untyped (string-name) call sites are unaffected. When a
 * project augments {@link WorkflowRegistry} (typically via `weft codegen`),
 * the typed `start` overload returns `ClientHandle<WorkflowOutput<...>>` and
 * `result()` is narrowed to that workflow's output.
 *
 * The narrowing is a compile-time projection of the registered output schema,
 * exactly as `engine.start` returns a typed `WorkflowHandle<TOutput>` over a
 * runtime handle whose `result()` is structurally `Promise<unknown>`. The
 * concrete handles (`LocalHandle`, `HttpHandle`) stay non-generic; the static
 * type reflects the schema the project opted into via codegen, not an extra
 * runtime guarantee.
 */
export interface ClientHandle<TResult = unknown>
  extends TypedEventTarget<WeftEventMap>, Disposable {
  /** The workflow's unique identifier. */
  readonly id: string;

  /** Resolves when the workflow completes (or rejects on failure). */
  result(): Promise<TResult>;

  /** Cancel this workflow. */
  cancel(): Promise<void>;

  /**
   * Suspend this workflow without terminating it: it moves to the non-terminal
   * `suspended` status, keeps its checkpoint, and is later resumable via
   * {@link ClientHandle.resume}. Unlike {@link ClientHandle.cancel}, it does not
   * run cancel handlers and does not settle `result()`. Inline execution mode
   * only (worker-mode servers fault with `Unprocessable`).
   */
  suspend(): Promise<void>;

  /**
   * Resume this workflow from its persisted checkpoint after a
   * {@link ClientHandle.suspend} (or after a process restart left it running).
   * `result()` resolves when the resumed run completes.
   */
  resume(): Promise<void>;

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

  /**
   * Open a live, push-based tail of this workflow's events. Async-iterate the
   * returned {@link WorkflowEventTail} to consume events as they happen. In
   * server mode this rides the WebSocket watch channel (no polling); in library
   * mode it bridges the engine's event stream directly.
   */
  tail(): WorkflowEventTail;

  /**
   * Resolves once this handle's live event subscription is connected, opening
   * it if necessary. Await this after attaching `addEventListener` listeners
   * and before triggering work whose events you intend to observe, so nothing
   * is missed in the window before the underlying transport connects. In
   * library mode it resolves immediately — engine events are already live.
   */
  whenConnected(): Promise<void>;
}

/**
 * A reference to a recurring schedule that provides convenience methods.
 *
 * Mirrors the core {@link ScheduleHandle} surface without leaking the engine
 * implementation type into the transport-neutral client contract.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient } from '@lostgradient/weft';
 * import type { ClientScheduleHandle } from '@lostgradient/weft/client';
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

  /** Update the schedule's recurrence specification (cron string or interval spec). */
  update(newSpec: string | ScheduleSpec): Promise<void>;

  /** Read the latest persisted summary for this schedule. */
  describe(): Promise<ScheduleSummary | null>;
}

// Update result + async-activity completion surface.

/** Result of a coordinated update request. */
export type UpdateResult = {
  updateId: string;
  result?: unknown;
  error?: string;
} | null;

/**
 * Out-of-band ("async") activity completion surface, shared by every client.
 *
 * An activity that called `ActivityContext.completeAsync()` parks its workflow
 * until an external system resolves it by the durable task token announced on
 * the engine's `activity:async-pending` event. Library mode calls the engine
 * directly; server mode POSTs to `/v1/activities/{complete,fail}`. After a
 * restart, wait for recovery to settle first — a completion racing `recoverAll()`
 * consumes the single-use token before re-adoption and strands the workflow. The
 * token is a deterministic identifier, not a secret (see `completeAsync`).
 *
 * @example
 * ```ts
 * import { Engine, LocalClient, type WeftClientActivity } from '@lostgradient/weft';
 *
 * const activity: WeftClientActivity = new LocalClient(new Engine()).activity;
 * // `token` comes from the engine's `activity:async-pending` event:
 * // await activity.complete(token, { approved: true });
 * void activity;
 * ```
 */
export interface WeftClientActivity {
  /** Complete a deferred activity by token, resuming its workflow with `result` (optional; omitted/`undefined` resumes with `undefined`). */
  complete(token: string, result?: unknown): Promise<void>;
  /** Fail a deferred activity by token; the error is thrown into its workflow. */
  completeExceptionally(token: string, error: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// WeftClient interface
// ---------------------------------------------------------------------------

/**
 * Operations shared by both in-process and HTTP clients.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient, type WeftClient } from '@lostgradient/weft';
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
  /**
   * Start a new workflow and return a handle to it.
   *
   * When the {@link WorkflowRegistry} is augmented (e.g. via `weft codegen`),
   * the workflow name narrows `input` to that workflow's input type and the
   * returned handle's `result()` to its output type. Without augmentation the
   * permissive string-name overload applies, so the client stays usable with
   * plain string names and no hard dependency on codegen.
   *
   * Pass `options.idempotencyKey` for at-most-once starts: a repeated key returns
   * a handle to the existing run rather than starting a second. Conflicts (a
   * duplicate `id`, or a key whose run was purged) are transport-dependent:
   * `LocalClient` throws the typed error (`WorkflowAlreadyExistsError` /
   * `IdempotencyKeyPurgedError`), while `HttpClient` throws `HttpClientError`
   * with `status === 409` and `faultCode === 'Conflict'`.
   */
  start<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    options?: StartOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  start<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    options?: StartOptions,
  ): Promise<ClientHandle>;

  /**
   * Atomically start a workflow or signal it if it already exists
   * (signal-with-start). An absent target is created and delivered the signal in
   * one batch; a non-terminal target (running, pending, or suspended) is
   * signalled; a terminal target is rejected as a conflict.
   *
   * The rejection shape is transport-dependent: `LocalClient` throws the typed
   * `StartOrSignalConflictError` (and `IdempotencyKeyPurgedError` for a spent
   * key), while `HttpClient` throws `HttpClientError` with `status === 409` and
   * `faultCode === 'Conflict'`. Branch on `faultCode`/`status` for code that runs
   * over either transport.
   *
   * Pass `options.idempotencyKey` to dedup independent callers such as retried
   * webhooks: concurrent same-key callers converge on one workflow and one
   * delivered signal, with the signal id derived from the key. Convergence needs a
   * shared workflow identity — `options.idempotencyKey` (id-free) or
   * `options.id` + `signal.signalId`. A bare `signal.signalId` with neither is an
   * atomic start-with-one-signal that does NOT converge concurrent callers (each
   * gets its own run). Supply exactly one of `signal.signalId` or
   * `options.idempotencyKey`; `options.id` and `options.idempotencyKey` are
   * mutually exclusive.
   */
  startOrSignal<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    signal: StartOrSignalSignal,
    options?: StartOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  startOrSignal<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: StartOptions,
  ): Promise<ClientHandle>;

  /**
   * Register a recurring schedule (cron string or interval spec) and return a
   * handle to it.
   *
   * Like {@link WeftClient.start}, the workflow name narrows `input` to the
   * registered workflow's input type when the {@link WorkflowRegistry} is
   * augmented; otherwise the string-name overload applies.
   */
  schedule<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle>;
  schedule<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    spec: string | ScheduleSpec,
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

  /**
   * Suspend a running workflow without terminating it. It moves to the
   * non-terminal `suspended` status, keeps its checkpoint, and is later
   * resumable via {@link WeftClient.resume}. Inline execution mode only.
   */
  suspend(id: string): Promise<void>;

  /** Pause a recurring schedule. */
  pauseSchedule(id: string): Promise<void>;

  /** Resume a recurring schedule. */
  resumeSchedule(id: string): Promise<void>;

  /** Cancel a recurring schedule. */
  cancelSchedule(id: string): Promise<void>;

  /** Update a recurring schedule's recurrence specification (cron string or interval spec). */
  updateSchedule(id: string, newSpec: string | ScheduleSpec): Promise<void>;

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

  /** Out-of-band ("async") activity completion by task token. See {@link WeftClientActivity}. */
  readonly activity: WeftClientActivity;

  /**
   * Re-drive a workflow from its persisted checkpoint. Accepts a workflow that
   * was explicitly suspended (`suspend(id)`) or one left `'running'` by a prior
   * process; throws for a status that cannot be resumed (terminal or pending).
   */
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
   * Open a live, push-based tail of a workflow's events. Async-iterate the
   * returned {@link WorkflowEventTail} to consume events as they happen. In
   * server mode this rides the per-workflow `/v1/workflows/:id/watch` WebSocket
   * channel (replacing the old 2-second poll); in library mode it bridges the
   * engine's event stream directly. Both transports deliver the same
   * {@link WorkflowEvent} records and terminate cleanly on completion or close.
   */
  tail(id: string): WorkflowEventTail;

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

  /**
   * Typed low-level accessor for the full operation catalog.
   *
   * Every catalog operation is reachable as `client.operations['weft.<op>']`,
   * including server operations the ergonomic surface does not curate (workers,
   * task queues, task diagnostics, system metrics/registry, checkpoints). New
   * catalog operations appear here automatically when the snapshot regenerates,
   * so the client never drifts behind the server.
   *
   * @example
   * ```ts
   * import { workflow, Engine, MemoryStorage, LocalClient } from '@lostgradient/weft';
   *
   * await using engine = new Engine({ storage: new MemoryStorage() });
   * engine.register(workflow({ name: 'noop' }).execute(async function* () {}));
   * const client = new LocalClient(engine);
   * const metrics = await client.operations['weft.system.metrics']({});
   * void metrics;
   * ```
   */
  readonly operations: CatalogOperations;

  /**
   * Invoke a single catalog operation by name, with its input and output typed
   * from the generated catalog. Equivalent to `client.operations[name](input)`
   * but ergonomic when the operation name is known dynamically.
   */
  call<Name extends CatalogOperationName>(
    name: Name,
    input: CatalogOperationTypes[Name]['input'],
  ): Promise<CatalogOperationTypes[Name]['output']>;
}
