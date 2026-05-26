import { assertScopedBulkWorkflowFilter } from '../core/bulk-workflow-filter.ts';
import type { StoredStreamChunk } from '../core/context.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  PurgeResult,
  RetentionOverview,
  ReviewListEntry,
  ReviewListFilter,
  SubmitReviewOptions,
} from '../core/types.ts';
import { HttpClientError, request } from './http-request.ts';
import type { UpdateResult } from './interface.ts';
import { buildReviewListSearchParams } from './search-params.ts';

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
