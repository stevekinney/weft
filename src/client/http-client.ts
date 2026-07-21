import {
  CLIENT_OPERATION_NAMES,
  CLIENT_REST_OPERATION_BINDINGS,
  type ClientOperationName,
  type ClientOperationTypes,
  type ClientOperations,
} from '../cli/generated/operation-client.generated.ts';
import { createCatalogWeftClient } from '../cli/operation-client-runtime.ts';
import type { StoredStreamChunk } from '../core/context.ts';
import type {
  AttributeFilterKey,
  BulkCancelResult,
  BulkDeleteResult,
  BulkRetryFailedResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  MessageName,
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
  ScheduleUpdateOptions,
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
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
import { messageName } from '../core/types.ts';
import type { WeftClientStorage } from './client-storage.ts';
import type { WorkflowEventStreamOptions } from './event-stream-options.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import {
  addTagsRequest,
  cancelAllWorkflowRequests,
  cancelScheduleRequest,
  cancelWorkflowRequest,
  completeAsyncActivityRequest,
  deleteAllWorkflowRequests,
  failAsyncActivityRequest,
  forkWorkflowRequest,
  getAttributesRequest,
  getRetentionOverviewRequest,
  getScheduleRequest,
  getStreamChunkRequests,
  getTimelineRequest,
  getUpdateResultRequest,
  getWorkflowRequest,
  listReviewRequests,
  pauseScheduleRequest,
  purgeWorkflowRequests,
  queryWorkflowRequest,
  removeTagsRequest,
  replayToRequest,
  resumeScheduleRequest,
  retryFailedAllWorkflowRequests,
  setAttributesRequest,
  signalAllWorkflowRequests,
  signalWorkflowRequest,
  submitCoordinatedUpdateRequest,
  submitReviewRequest,
  suspendWorkflowRequest,
  tagAllWorkflowRequests,
  timeoutWorkflowRequest,
  untagAllWorkflowRequests,
  updateScheduleRequest,
} from './http-client-requests.ts';
import { createHttpClientStorage } from './http-client-storage.ts';
import { HttpHandle } from './http-handle.ts';
import { httpClientOperationTransport } from './http-operations.ts';
import { request, resolveHttpClientConnection, type HttpClientOptions } from './http-request.ts';
import { HttpScheduleHandle } from './http-schedule-handle.ts';
import type {
  ClientHandle,
  ClientScheduleHandle,
  ClientStartOptions,
  ClientStartOrSignalOptions,
  StartOrSignalOutcome,
  UpdateResult,
  WeftClient,
  WeftClientActivity,
} from './interface.ts';
import { openClientEventSubscription } from './open-event-subscription.ts';
import { buildScheduleListSearchParams } from './schedule-list-search-params.ts';
import { buildWorkflowListSearchParams } from './search-params.ts';
import { buildScheduleBody, buildStartBody, buildStartOrSignalBody } from './start-body.ts';
import type { KnownWorkflowName, UnknownNameWhenRegistryEmpty } from './workflow-name-typing.ts';

/**
 * Remote Weft client backed by HTTP requests.
 *
 * **Error handling**
 *
 * - **404 on GET → `null`:** When a GET request returns 404, the client
 *   treats it as "resource not found" and resolves with `null` instead of
 *   throwing `HttpClientError`.
 * - **400/422 in `submitCoordinatedUpdate` → error envelope:** A 400 or 422
 *   response from `submitCoordinatedUpdate` is translated into a
 *   `CoordinatedUpdateResult` with an `error` field rather than throwing.
 *
 * **Connection resolution**
 *
 * With no `baseUrl`/`token`, the client resolves the server address and bearer
 * token through {@link resolveConnection}: explicit options, then `WEFT_ADDR`/
 * `WEFT_TOKEN`, then the `~/.weft/config` profile, then `http://localhost:7233`.
 * The CLI-only run lockfile is not consulted. A caller-supplied
 * `headers.Authorization` always takes precedence over a resolved token.
 *
 * @example
 * ```ts
 * import { HttpClient } from '@lostgradient/weft';
 *
 * // Explicit address and token.
 * const client = new HttpClient({
 *   baseUrl: 'http://localhost:3000',
 *   headers: { Authorization: 'Bearer my-token' },
 * });
 * const handle = await client.start('greet', { name: 'Alice' });
 * const result = await handle.result();
 * void result;
 *
 * // Or resolve WEFT_ADDR / WEFT_TOKEN from the environment.
 * const envClient = new HttpClient();
 * void envClient;
 * ```
 */
export class HttpClient implements WeftClient {
  /** @internal Exposed for handle access. */
  readonly baseUrl: string;
  /** @internal Exposed for handle access. */
  readonly headers: Record<string, string>;
  /** Typed low-level accessor over JSON-RPC and generated ordinary REST bindings. */
  readonly operations: ClientOperations;
  /** Raw storage administration over the byte-oriented REST bindings. */
  readonly storage: WeftClientStorage;
  /**
   * Out-of-band ("async") activity completion over HTTP. POSTs to
   * `/v1/activities/{complete,fail}`; mirrors {@link LocalClient}'s `activity`.
   */
  readonly activity: WeftClientActivity;
  readonly #streamOptions: WorkflowEventStreamOptions;

  constructor(options: HttpClientOptions = {}) {
    const connection = resolveHttpClientConnection(options);
    this.baseUrl = connection.baseUrl;
    this.headers = connection.headers;
    this.operations = createCatalogWeftClient<ClientOperationTypes>(
      CLIENT_OPERATION_NAMES,
      httpClientOperationTransport(this.baseUrl, this.headers, CLIENT_REST_OPERATION_BINDINGS),
    );
    this.storage = createHttpClientStorage(this.baseUrl, this.headers);
    this.activity = {
      complete: (token, result) => completeAsyncActivityRequest(this, token, result),
      completeExceptionally: (token, error) => failAsyncActivityRequest(this, token, error),
    };
    this.#streamOptions = {
      ...(options.eventTransport === undefined ? {} : { eventTransport: options.eventTransport }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
    };
  }

  // Duplicate intentionally retained: the call/start overload stacks mirror
  // `LocalClient`, but TypeScript requires each `WeftClient` implementer to
  // declare these overloads locally to emit them into its `.d.ts` and keep
  // call-site inference (bodies differ: HTTP request + `HttpHandle` here vs a
  // `LocalHandle` over `#engine`); rejected: a shared base class, which drops
  // the per-class overload declarations from the emitted declarations.
  // jscpd:ignore-start
  call<Name extends ClientOperationName>(
    name: Name,
    input: ClientOperationTypes[Name]['input'],
  ): Promise<ClientOperationTypes[Name]['output']> {
    return this.operations[name](input);
  }

  async start<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    options?: ClientStartOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  async start<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    options?: ClientStartOptions,
  ): Promise<ClientHandle>;
  async start(type: string, input: unknown, options?: ClientStartOptions): Promise<ClientHandle> {
    const body = buildStartBody(type, input, options);
    const response = await request<{ id: string }>(this.baseUrl, '/workflows', this.headers, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return new HttpHandle(response.id, this);
  }

  async startOrSignal<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    signal: StartOrSignalSignal,
    options?: ClientStartOrSignalOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  async startOrSignal<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: ClientStartOrSignalOptions,
  ): Promise<ClientHandle>;
  async startOrSignal(
    type: string,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: ClientStartOrSignalOptions,
  ): Promise<ClientHandle> {
    const body = buildStartOrSignalBody(type, input, signal, options);
    const response = await request<{ id: string; outcome: StartOrSignalOutcome }>(
      this.baseUrl,
      '/workflows/start-or-signal',
      this.headers,
      { method: 'POST', body: JSON.stringify(body) },
    );

    // Each HTTP call gets its own response body, so converged concurrent callers
    // each receive their own per-call outcome — no shared-handle clobbering (#466).
    return new HttpHandle(response.id, this, response.outcome);
  }
  // jscpd:ignore-end

  async schedule<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle>;
  async schedule<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle>;
  async schedule(
    type: string,
    input: unknown,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle> {
    const body = buildScheduleBody(type, input, spec, options);

    const response = await request<{ id: string }>(this.baseUrl, '/schedules', this.headers, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return new HttpScheduleHandle(response.id, this);
  }

  async get(id: string): Promise<WorkflowState | null> {
    return getWorkflowRequest(this, id);
  }

  async getHandle(id: string): Promise<ClientHandle | null>;
  async getHandle<TName extends KnownWorkflowName>(
    id: string,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>> | null>;
  async getHandle(id: string): Promise<ClientHandle | null> {
    // Probe persisted existence over REST; a missing run yields `null` rather
    // than a handle that would fault on first use. An existing run gets the
    // same `HttpHandle` ergonomics `start`/`resume` return.
    const state = await getWorkflowRequest(this, id);
    if (state === null) return null;
    return new HttpHandle(id, this);
  }

  async getSchedule(id: string): Promise<ScheduleSummary | null> {
    return getScheduleRequest(this, id);
  }

  async list<
    const TAttributeKeys extends readonly AttributeFilterKey[] = readonly AttributeFilterKey[],
  >(filter?: TypedListFilter<TAttributeKeys>): Promise<PaginatedResult<WorkflowSummary>> {
    const params = buildWorkflowListSearchParams(filter);
    const query = params.toString();
    const path = query ? `/workflows?${query}` : '/workflows';

    return request<PaginatedResult<WorkflowSummary>>(this.baseUrl, path, this.headers);
  }

  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    const params = buildScheduleListSearchParams(filter);
    const query = params.toString();
    const path = query ? `/schedules?${query}` : '/schedules';

    return request<PaginatedResult<ScheduleSummary>>(this.baseUrl, path, this.headers);
  }

  async cancel(id: string): Promise<void> {
    return cancelWorkflowRequest(this, id);
  }

  async suspend(id: string): Promise<void> {
    return suspendWorkflowRequest(this, id);
  }

  async pauseSchedule(id: string): Promise<void> {
    return pauseScheduleRequest(this, id);
  }

  async resumeSchedule(id: string): Promise<void> {
    return resumeScheduleRequest(this, id);
  }

  async cancelSchedule(id: string): Promise<void> {
    return cancelScheduleRequest(this, id);
  }

  async updateSchedule(
    id: string,
    newSpec: string | ScheduleSpec,
    options?: ScheduleUpdateOptions,
  ): Promise<void> {
    return updateScheduleRequest(this, id, newSpec, options);
  }

  async signal(id: string, name: SignalDefinition): Promise<void>;
  async signal<TInput>(
    id: string,
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(
    id: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(
    id: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void> {
    await signalWorkflowRequest(this, id, messageName(nameOrDefinition), payload, options);
  }

  async query<TOutput>(id: string, name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    id: string,
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(id: string, name: string, input?: unknown): Promise<unknown>;
  async query(id: string, nameOrDefinition: MessageName, input?: unknown): Promise<unknown> {
    return queryWorkflowRequest(this, id, messageName(nameOrDefinition), input);
  }

  async update(
    id: string,
    name: UpdateDefinition,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<unknown>;
  async update<TInput, TOutput>(
    id: string,
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  async update(
    id: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    const name = messageName(nameOrDefinition);
    const body: Record<string, unknown> = { payload };
    if (options?.timeout !== undefined) body['timeout'] = options.timeout;

    const response = await request<{ result: unknown }>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/update/${encodeURIComponent(name)}`,
      this.headers,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    return response?.result;
  }

  async resume(id: string): Promise<ClientHandle> {
    const response = await request<{ id: string }>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/resume`,
      this.headers,
      { method: 'POST' },
    );
    return new HttpHandle(response.id, this);
  }

  async recoverAll(): Promise<ClientHandle[]> {
    const response = await request<{ recovered: string[] }>(
      this.baseUrl,
      '/recover',
      this.headers,
      { method: 'POST' },
    );
    return response.recovered.map((id) => new HttpHandle(id, this));
  }

  async timeout(id: string): Promise<void> {
    return timeoutWorkflowRequest(this, id);
  }

  async getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null> {
    return getAttributesRequest(this, id);
  }

  async setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return setAttributesRequest(this, id, attributes);
  }

  async addTags(id: string, ...tags: string[]): Promise<void> {
    return addTagsRequest(this, id, tags);
  }

  async removeTags(id: string, ...tags: string[]): Promise<void> {
    return removeTagsRequest(this, id, tags);
  }

  async getEvents(id: string): Promise<WorkflowEvent[]> {
    const response = await request<{ events: WorkflowEvent[] } | null>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/events`,
      this.headers,
    );
    if (response === null) return [];
    return response.events;
  }

  /**
   * @internal Open a live event subscription over the `/watch` WebSocket
   * channel. Shared by {@link HttpHandle} (push-based `addEventListener`) and
   * {@link tail}. The subscription catches up from `getEvents` on every
   * (re)connect, so it covers events emitted before it connected.
   *
   * `bufferForIteration` defaults off for the callback-only `addEventListener`
   * path; {@link tail} sets it so the connect catch-up is buffered for the
   * async iterator instead of dropped.
   */
  openEventSubscription(
    id: string,
    onEvent: (event: WorkflowEvent) => void,
    bufferForIteration = false,
  ): WorkflowEventTail {
    return openClientEventSubscription(this, this.#streamOptions, id, onEvent, bufferForIteration);
  }

  tail(id: string): WorkflowEventTail {
    // The subscription always catches up from persisted history on connect, so
    // resumption from an arbitrary point is automatic — no cursor is needed.
    // Buffer for iteration so the catch-up history (emitted before the consumer
    // starts `for await`) is delivered, not dropped.
    return this.openEventSubscription(id, () => {}, true);
  }

  async getTimeline(id: string): Promise<WorkflowTimelineEntry[]> {
    return getTimelineRequest(this, id);
  }

  async replayTo(id: string, step: number): Promise<WorkflowReplay | null> {
    return replayToRequest(this, id, step);
  }

  async listReviews(filter?: ReviewListFilter): Promise<ReviewListEntry[]> {
    return listReviewRequests(this, filter);
  }

  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    return submitReviewRequest(this, reviewId, options);
  }

  async getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): Promise<StoredStreamChunk[]> {
    return getStreamChunkRequests(this, workflowId, key, options);
  }

  async fork(id: string, options?: ForkOptions): Promise<ClientHandle> {
    const workflowId = await forkWorkflowRequest(this, id, options);
    return new HttpHandle(workflowId, this);
  }

  async getRetentionOverview(): Promise<RetentionOverview> {
    return getRetentionOverviewRequest(this);
  }

  async purge(filter?: ListFilter): Promise<PurgeResult> {
    return purgeWorkflowRequests(this, filter);
  }

  async cancelAll(filter: ListFilter): Promise<BulkCancelResult> {
    return cancelAllWorkflowRequests(this, filter);
  }

  async retryFailedAll(filter: ListFilter): Promise<BulkRetryFailedResult> {
    return retryFailedAllWorkflowRequests(this, filter);
  }

  async signalAll(filter: ListFilter, name: string, payload?: unknown): Promise<BulkSignalResult> {
    return signalAllWorkflowRequests(this, filter, name, payload);
  }

  async deleteAll(filter: ListFilter): Promise<BulkDeleteResult> {
    return deleteAllWorkflowRequests(this, filter);
  }

  async tagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return tagAllWorkflowRequests(this, filter, tags);
  }

  async untagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return untagAllWorkflowRequests(this, filter, tags);
  }

  async submitCoordinatedUpdate(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    return submitCoordinatedUpdateRequest(this, id, name, payload, options);
  }

  async getUpdateResult(updateId: string): Promise<UpdateResult> {
    return getUpdateResultRequest(this, updateId);
  }
}
