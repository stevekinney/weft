import { assertScopedBulkWorkflowFilter } from '../core/bulk-workflow-filter.ts';
import type { StoredStreamChunk } from '../core/context.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkRetryFailedResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  PurgeResult,
  RetentionOverview,
  ReviewListEntry,
  ReviewListFilter,
  ScheduleSpec,
  ScheduleSummary,
  ScheduleUpdateOptions,
  SearchAttributeValue,
  SignalDeliveryOptions,
  SubmitReviewOptions,
  WorkflowReplay,
  WorkflowState,
  WorkflowTimelineEntry,
} from '../core/types.ts';
import { HttpClientError, request } from './http-request.ts';
import type { UpdateResult } from './interface.ts';
import { buildReviewListSearchParams } from './search-params.ts';
import { scheduleSpecToWireFields } from './start-body.ts';

export type HttpClientRequestContext = {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
};

export async function listReviewRequests(
  context: HttpClientRequestContext,
  filter?: ReviewListFilter,
): Promise<ReviewListEntry[]> {
  const search = buildReviewListSearchParams(filter).toString();
  const path = search.length > 0 ? `/reviews?${search}` : '/reviews';
  const response = await request<{ items: ReviewListEntry[] }>(
    context.baseUrl,
    path,
    context.headers,
  );
  return response.items;
}

export async function submitReviewRequest(
  context: HttpClientRequestContext,
  reviewId: string,
  options: SubmitReviewOptions,
): Promise<void> {
  await request<unknown>(
    context.baseUrl,
    `/reviews/${encodeURIComponent(reviewId)}/decision`,
    context.headers,
    {
      method: 'POST',
      body: JSON.stringify(options),
    },
  );
}

export async function getStreamChunkRequests(
  context: HttpClientRequestContext,
  workflowId: string,
  key: string,
  options?: { after?: number },
): Promise<StoredStreamChunk[]> {
  const search = new URLSearchParams();
  if (options?.after !== undefined) {
    search.set('after', String(options.after));
  }

  const query = search.size > 0 ? `?${search.toString()}` : '';
  const response = await request<{ chunks: StoredStreamChunk[] }>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(workflowId)}/streams/${encodeURIComponent(key)}${query}`,
    context.headers,
  );
  return response.chunks;
}

export async function forkWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
  options?: ForkOptions,
): Promise<string> {
  const body: Record<string, unknown> = {};
  if (options?.fromStep !== undefined) {
    body['fromStep'] = options.fromStep;
  }

  const response = await request<{ id: string }>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/fork`,
    context.headers,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  return response.id;
}

export function getRetentionOverviewRequest(
  context: HttpClientRequestContext,
): Promise<RetentionOverview> {
  return request<RetentionOverview>(context.baseUrl, '/retention', context.headers);
}

export function purgeWorkflowRequests(
  context: HttpClientRequestContext,
  filter?: ListFilter,
): Promise<PurgeResult> {
  return request<PurgeResult>(context.baseUrl, '/workflows/purge', context.headers, {
    method: 'POST',
    body: JSON.stringify({ filter }),
  });
}

export function cancelAllWorkflowRequests(
  context: HttpClientRequestContext,
  filter: ListFilter,
): Promise<BulkCancelResult> {
  assertScopedBulkWorkflowFilter(filter);
  return request<BulkCancelResult>(context.baseUrl, '/workflows/bulk/cancel', context.headers, {
    method: 'POST',
    body: JSON.stringify({ filter }),
  });
}

export function retryFailedAllWorkflowRequests(
  context: HttpClientRequestContext,
  filter: ListFilter,
): Promise<BulkRetryFailedResult> {
  assertScopedBulkWorkflowFilter(filter);
  return request<BulkRetryFailedResult>(
    context.baseUrl,
    '/workflows/bulk/retry-failed',
    context.headers,
    {
      method: 'POST',
      body: JSON.stringify({ filter }),
    },
  );
}

export function signalAllWorkflowRequests(
  context: HttpClientRequestContext,
  filter: ListFilter,
  name: string,
  payload?: unknown,
): Promise<BulkSignalResult> {
  assertScopedBulkWorkflowFilter(filter);
  if (name.length === 0) {
    throw new Error('Field "name" must be a non-empty string');
  }
  return request<BulkSignalResult>(context.baseUrl, '/workflows/bulk/signal', context.headers, {
    method: 'POST',
    body: JSON.stringify({ filter, name, payload }),
  });
}

export function deleteAllWorkflowRequests(
  context: HttpClientRequestContext,
  filter: ListFilter,
): Promise<BulkDeleteResult> {
  assertScopedBulkWorkflowFilter(filter);
  return request<BulkDeleteResult>(context.baseUrl, '/workflows/bulk', context.headers, {
    method: 'DELETE',
    body: JSON.stringify({ filter }),
  });
}

export function tagAllWorkflowRequests(
  context: HttpClientRequestContext,
  filter: ListFilter,
  tags: string[],
): Promise<BulkTagResult> {
  assertScopedBulkWorkflowFilter(filter);
  return request<BulkTagResult>(context.baseUrl, '/workflows/bulk/tags', context.headers, {
    method: 'PATCH',
    body: JSON.stringify({ filter, tags, operation: 'add' }),
  });
}

export function untagAllWorkflowRequests(
  context: HttpClientRequestContext,
  filter: ListFilter,
  tags: string[],
): Promise<BulkTagResult> {
  assertScopedBulkWorkflowFilter(filter);
  return request<BulkTagResult>(context.baseUrl, '/workflows/bulk/tags', context.headers, {
    method: 'PATCH',
    body: JSON.stringify({ filter, tags, operation: 'remove' }),
  });
}

export async function submitCoordinatedUpdateRequest(
  context: HttpClientRequestContext,
  id: string,
  name: string,
  payload?: unknown,
  options?: { timeout?: number; idempotencyKey?: string },
): Promise<CoordinatedUpdateResult> {
  const body: Record<string, unknown> = { payload };
  if (options?.timeout !== undefined) body['timeout'] = options.timeout;
  if (options?.idempotencyKey !== undefined) body['idempotencyKey'] = options.idempotencyKey;

  try {
    return await request<CoordinatedUpdateResult>(
      context.baseUrl,
      `/workflows/${encodeURIComponent(id)}/update/${encodeURIComponent(name)}`,
      context.headers,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    if (error instanceof HttpClientError && (error.status === 400 || error.status === 422)) {
      return { updateId: '', error: error.message };
    }
    throw error;
  }
}

export function getAttributesRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<Record<string, SearchAttributeValue> | null> {
  return request<Record<string, SearchAttributeValue> | null>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/attributes`,
    context.headers,
  );
}

export async function setAttributesRequest(
  context: HttpClientRequestContext,
  id: string,
  attributes: Record<string, SearchAttributeValue>,
): Promise<void> {
  await request<unknown>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/attributes`,
    context.headers,
    { method: 'PATCH', body: JSON.stringify({ attributes }) },
  );
}

export async function addTagsRequest(
  context: HttpClientRequestContext,
  id: string,
  tags: string[],
): Promise<void> {
  await request<unknown>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/tags`,
    context.headers,
    { method: 'POST', body: JSON.stringify({ tags }) },
  );
}

export async function removeTagsRequest(
  context: HttpClientRequestContext,
  id: string,
  tags: string[],
): Promise<void> {
  await request<unknown>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/tags`,
    context.headers,
    { method: 'DELETE', body: JSON.stringify({ tags }) },
  );
}

export async function getTimelineRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<WorkflowTimelineEntry[]> {
  const response = await request<WorkflowTimelineEntry[] | null>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/timeline`,
    context.headers,
  );
  return response ?? [];
}

export function replayToRequest(
  context: HttpClientRequestContext,
  id: string,
  step: number,
): Promise<WorkflowReplay | null> {
  return request<WorkflowReplay | null>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/replay/${step}`,
    context.headers,
  );
}

export async function getUpdateResultRequest(
  context: HttpClientRequestContext,
  updateId: string,
): Promise<UpdateResult> {
  const response = await request<{ status: string; result?: unknown; error?: string } | null>(
    context.baseUrl,
    `/updates/${encodeURIComponent(updateId)}`,
    context.headers,
  );

  if (response === null || response.status === 'pending') return null;

  const out: NonNullable<UpdateResult> = { updateId };
  if (response.result !== undefined) out.result = response.result;
  if (response.error !== undefined) out.error = response.error;
  return out;
}

/** Send a named signal (with optional payload + delivery options) to a workflow. */
export async function signalWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
  name: string,
  payload?: unknown,
  options?: SignalDeliveryOptions,
): Promise<void> {
  await request<unknown>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/signal/${encodeURIComponent(name)}`,
    context.headers,
    {
      method: 'POST',
      body: JSON.stringify({ payload, ...options }),
    },
  );
}

/**
 * Complete a deferred ("async") activity by task token, resuming its parked
 * workflow with `result`. Mirrors `LocalClient.activity.complete` over HTTP.
 */
export async function completeAsyncActivityRequest(
  context: HttpClientRequestContext,
  token: string,
  result?: unknown,
): Promise<void> {
  // `JSON.stringify` drops a `result` of `undefined`, so the wire body omits it
  // and the server resumes the workflow with `undefined` — matching LocalClient.
  await request<unknown>(context.baseUrl, '/activities/complete', context.headers, {
    method: 'POST',
    body: JSON.stringify({ token, result }),
  });
}

/**
 * Fail a deferred ("async") activity by task token. A live `Error` cannot cross
 * the wire, so the error is reduced to `message` + `name` — exactly the fields
 * the engine itself keeps when failing an async activity — before sending.
 */
export async function failAsyncActivityRequest(
  context: HttpClientRequestContext,
  token: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const reduced: { message: string; name?: string } = { message };
  if (error instanceof Error) {
    reduced.name = error.name;
  }
  await request<unknown>(context.baseUrl, '/activities/fail', context.headers, {
    method: 'POST',
    body: JSON.stringify({ token, error: reduced }),
  });
}

/** Fetch a workflow's full persisted state, or `null` if it does not exist. */
export function getWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<WorkflowState | null> {
  return request<WorkflowState | null>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}`,
    context.headers,
  );
}

/** Fetch a schedule's current summary, or `null` if it does not exist. */
export function getScheduleRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<ScheduleSummary | null> {
  return request<ScheduleSummary | null>(
    context.baseUrl,
    `/schedules/${encodeURIComponent(id)}`,
    context.headers,
  );
}

/** Cancel a running workflow (`DELETE /v1/workflows/:id`). */
export function cancelWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<void> {
  return request<void>(context.baseUrl, `/workflows/${encodeURIComponent(id)}`, context.headers, {
    method: 'DELETE',
  });
}

/** Force-timeout a workflow (`POST /v1/workflows/:id/timeout`). */
export function timeoutWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<void> {
  return request<void>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/timeout`,
    context.headers,
    { method: 'POST' },
  );
}

/** Suspend a running workflow (`POST /v1/workflows/:id/suspend`). */
export function suspendWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<void> {
  return request<void>(
    context.baseUrl,
    `/workflows/${encodeURIComponent(id)}/suspend`,
    context.headers,
    { method: 'POST' },
  );
}

/** Pause a recurring schedule (`POST /v1/schedules/:id/pause`). */
export function pauseScheduleRequest(context: HttpClientRequestContext, id: string): Promise<void> {
  return request<void>(
    context.baseUrl,
    `/schedules/${encodeURIComponent(id)}/pause`,
    context.headers,
    { method: 'POST' },
  );
}

/** Resume a paused schedule (`POST /v1/schedules/:id/resume`). */
export function resumeScheduleRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<void> {
  return request<void>(
    context.baseUrl,
    `/schedules/${encodeURIComponent(id)}/resume`,
    context.headers,
    { method: 'POST' },
  );
}

/** Cancel a recurring schedule (`DELETE /v1/schedules/:id`). */
export function cancelScheduleRequest(
  context: HttpClientRequestContext,
  id: string,
): Promise<void> {
  return request<void>(context.baseUrl, `/schedules/${encodeURIComponent(id)}`, context.headers, {
    method: 'DELETE',
  });
}

/** Update a schedule's cadence and mutable options (`PATCH /v1/schedules/:id`). */
export function updateScheduleRequest(
  context: HttpClientRequestContext,
  id: string,
  newSpec: string | ScheduleSpec,
  options?: ScheduleUpdateOptions,
): Promise<void> {
  const body = scheduleSpecToWireFields(newSpec);
  if (options?.description !== undefined) body['description'] = options.description;
  if (options?.overlap !== undefined) body['overlap'] = options.overlap;
  if (options?.backfill !== undefined) body['backfill'] = options.backfill;
  if (options?.jitter !== undefined) body['jitter'] = options.jitter;

  return request<void>(context.baseUrl, `/schedules/${encodeURIComponent(id)}`, context.headers, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Query a named read-only accessor on a workflow. A no-input query is a GET;
 * an input payload is sent as a POST body.
 */
export async function queryWorkflowRequest(
  context: HttpClientRequestContext,
  id: string,
  name: string,
  input?: unknown,
): Promise<unknown> {
  const path = `/workflows/${encodeURIComponent(id)}/query/${encodeURIComponent(name)}`;
  const response = await request<{ result: unknown }>(
    context.baseUrl,
    path,
    context.headers,
    input !== undefined ? { method: 'POST', body: JSON.stringify({ input }) } : undefined,
  );
  return response?.result;
}
