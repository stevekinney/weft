import {
  CATALOG_OPERATION_NAMES,
  type CatalogOperationName,
  type CatalogOperationTypes,
  type WeftClient as CatalogOperations,
} from '../cli/generated/operation-client.generated.ts';
import { createCatalogWeftClient } from '../cli/operation-client-runtime.ts';
import type { StoredStreamChunk } from '../core/context.ts';
import type {
  AttributeFilterKey,
  BulkCancelResult,
  BulkDeleteResult,
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
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
  StartOptions,
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
import {
  openClientEventSubscription,
  type WorkflowEventStreamOptions,
  type WorkflowEventSubscription,
} from './event-stream.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import {
  addTagsRequest,
  cancelAllWorkflowRequests,
  deleteAllWorkflowRequests,
  forkWorkflowRequest,
  getAttributesRequest,
  getRetentionOverviewRequest,
  getStreamChunkRequests,
  getTimelineRequest,
  getUpdateResultRequest,
  listReviewRequests,
  purgeWorkflowRequests,
  queryWorkflowRequest,
  removeTagsRequest,
  replayToRequest,
  setAttributesRequest,
  signalAllWorkflowRequests,
  signalWorkflowRequest,
  submitCoordinatedUpdateRequest,
  submitReviewRequest,
  tagAllWorkflowRequests,
  untagAllWorkflowRequests,
} from './http-client-requests.ts';
import { HttpHandle } from './http-handle.ts';
import { httpClientCatalogTransport } from './http-operations.ts';
import { request, resolveHttpClientConnection, type HttpClientOptions } from './http-request.ts';
import { HttpScheduleHandle } from './http-schedule-handle.ts';
import type { ClientHandle, ClientScheduleHandle, UpdateResult, WeftClient } from './interface.ts';
import { buildScheduleListSearchParams } from './schedule-list-search-params.ts';
import { buildWorkflowListSearchParams } from './search-params.ts';
import { buildStartBody, scheduleSpecToWireFields } from './start-body.ts';
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
 * import { HttpClient } from 'weft';
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
  /** Typed low-level accessor for every catalog operation over JSON-RPC. */
  readonly operations: CatalogOperations;
  readonly #streamOptions: WorkflowEventStreamOptions;

  constructor(options: HttpClientOptions = {}) {
    const connection = resolveHttpClientConnection(options);
    this.baseUrl = connection.baseUrl;
    this.headers = connection.headers;
    this.operations = createCatalogWeftClient<CatalogOperationTypes>(
      CATALOG_OPERATION_NAMES,
      httpClientCatalogTransport(this.baseUrl, this.headers),
    );
    this.#streamOptions =
      options.webSocketFactory === undefined ? {} : { webSocketFactory: options.webSocketFactory };
  }

  call<Name extends CatalogOperationName>(
    name: Name,
    input: CatalogOperationTypes[Name]['input'],
  ): Promise<CatalogOperationTypes[Name]['output']> {
    return this.operations[name](input);
  }

  async start<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    options?: StartOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  async start<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    options?: StartOptions,
  ): Promise<ClientHandle>;
  async start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle> {
    const body = buildStartBody(type, input, options);
    const response = await request<{ id: string }>(this.baseUrl, '/workflows', this.headers, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return new HttpHandle(response.id, this);
  }

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
    const body: Record<string, unknown> = {
      type,
      input,
      ...scheduleSpecToWireFields(spec),
    };
    if (options?.id !== undefined) body['id'] = options.id;
    if (options?.overlap !== undefined) body['overlap'] = options.overlap;
    if (options?.backfill !== undefined) body['backfill'] = options.backfill;

    const response = await request<{ id: string }>(this.baseUrl, '/schedules', this.headers, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return new HttpScheduleHandle(response.id, this);
  }

  async get(id: string): Promise<WorkflowState | null> {
    return request<WorkflowState | null>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}`,
      this.headers,
    );
  }

  async getSchedule(id: string): Promise<ScheduleSummary | null> {
    return request<ScheduleSummary | null>(
      this.baseUrl,
      `/schedules/${encodeURIComponent(id)}`,
      this.headers,
    );
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
    return request<void>(this.baseUrl, `/workflows/${encodeURIComponent(id)}`, this.headers, {
      method: 'DELETE',
    });
  }

  async pauseSchedule(id: string): Promise<void> {
    return request<void>(this.baseUrl, `/schedules/${encodeURIComponent(id)}/pause`, this.headers, {
      method: 'POST',
    });
  }

  async resumeSchedule(id: string): Promise<void> {
    return request<void>(
      this.baseUrl,
      `/schedules/${encodeURIComponent(id)}/resume`,
      this.headers,
      { method: 'POST' },
    );
  }

  async cancelSchedule(id: string): Promise<void> {
    return request<void>(this.baseUrl, `/schedules/${encodeURIComponent(id)}`, this.headers, {
      method: 'DELETE',
    });
  }

  async updateSchedule(id: string, newSpec: string | ScheduleSpec): Promise<void> {
    return request<void>(this.baseUrl, `/schedules/${encodeURIComponent(id)}`, this.headers, {
      method: 'PATCH',
      body: JSON.stringify(scheduleSpecToWireFields(newSpec)),
    });
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
    return request<void>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/timeout`,
      this.headers,
      { method: 'POST' },
    );
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
   */
  openEventSubscription(
    id: string,
    onEvent: (event: WorkflowEvent) => void,
  ): WorkflowEventSubscription {
    return openClientEventSubscription(this, this.#streamOptions, id, onEvent);
  }

  tail(id: string): WorkflowEventTail {
    // The subscription always catches up from persisted history on connect, so
    // resumption from an arbitrary point is automatic — no cursor is needed.
    return this.openEventSubscription(id, () => {});
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
