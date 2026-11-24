import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { ListFilter } from '../core/types.ts';
import { extractListFilterFromQuery } from '../server/operations/list-filter-query-extractor.ts';
import { HttpClient } from './http-client.ts';
import { buildWorkflowListSearchParams } from './search-params.ts';

/**
 * Every `ListFilter` field except the pagination pair, which the query extractor deliberately
 * leaves to its callers. Typed as a full record so adding a `ListFilter` field fails the type
 * check here until the round trip below covers it.
 */
const filterWithEveryField = {
  status: ['failed', 'running'],
  type: 'order-fulfillment',
  scheduleId: 'schedule-1',
  parentWorkflowId: 'parent-1',
  parentWorkflowExecutionToken: 'token-1',
  tags: ['alpha', 'beta'],
  attributes: [
    { key: 'region', value: 'eu' },
    { key: 'size', gte: 1, lt: 9 },
  ],
  limit: 25,
  offset: 50,
  idPrefix: 'order-',
  createdAt: { gte: 1, lt: 2 },
  updatedAt: { gt: 3, lte: 4 },
  executionDeadline: { gte: 5, lte: 6 },
  failureCategory: ['timeout', 'cancellation'],
  failedStep: 'charge-card',
  retrying: true,
} as const satisfies Required<ListFilter>;

describe('buildWorkflowListSearchParams', () => {
  test('drops no filter field on the way to the query extractor', () => {
    const params = buildWorkflowListSearchParams(filterWithEveryField);
    const { limit, offset, ...extractable } = filterWithEveryField;

    expect(extractListFilterFromQuery(new URL(`http://localhost/?${params}`))).toEqual(
      extractable as unknown as ReturnType<typeof extractListFilterFromQuery>,
    );
    expect(params.get('limit')).toBe(String(limit));
    expect(params.get('offset')).toBe(String(offset));
  });

  test('sends retrying false, not just true, so a negation reaches the server', () => {
    const params = buildWorkflowListSearchParams({ retrying: false });

    expect(params.toString()).toBe('retrying=false');
    expect(extractListFilterFromQuery(new URL(`http://localhost/?${params}`))).toEqual({
      retrying: false,
    });
  });

  test('sends a lone updatedAt window', () => {
    const params = buildWorkflowListSearchParams({ updatedAt: { gte: 1_000 } });

    expect(params.toString()).toBe('updated_at_gte=1000');
  });
});

describe('HttpClient.list', () => {
  const fetchSpy = spyOn(globalThis, 'fetch');

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('sends the updatedAt window, so a list narrowed to it is the set its count named', async () => {
    fetchSpy.mockResolvedValue(Response.json({ items: [], total: 0, offset: 0, limit: 50 }));

    await new HttpClient({ baseUrl: 'http://weft.test' }).list({
      status: 'failed',
      updatedAt: { gte: 1_000 },
    });

    const input = fetchSpy.mock.calls[0]?.[0];
    if (input === undefined) throw new Error('the client made no request');
    const requested = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    expect(requested.searchParams.get('updated_at_gte')).toBe('1000');
    expect(requested.searchParams.get('status')).toBe('failed');
  });
});
