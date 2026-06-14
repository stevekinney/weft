import { describe, expect, it } from 'bun:test';

import {
  extractListFilterFromQuery,
  extractTimeRangeFromQuery,
} from './list-filter-query-extractor.ts';

function urlWith(params: Record<string, string | string[]>): URL {
  const url = new URL('https://example.test/v1/workflows');
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, entry);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

describe('extractListFilterFromQuery', () => {
  it('extracts every supported list filter dimension', () => {
    const url = urlWith({
      status: ['failed', 'timed-out'],
      type: 'order',
      tag: ['nightly', 'v2'],
      id_prefix: 'order-',
      failure_category: ['resource', 'application'],
      created_at_gte: '1000',
      created_at_lt: '5000',
      updated_at_gt: '2000',
      execution_deadline_lte: '10000',
    });

    expect(extractListFilterFromQuery(url)).toEqual({
      status: ['failed', 'timed-out'],
      type: 'order',
      tags: ['nightly', 'v2'],
      idPrefix: 'order-',
      failureCategory: ['resource', 'application'],
      createdAt: { gte: 1000, lt: 5000 },
      updatedAt: { gt: 2000 },
      executionDeadline: { lte: 10000 },
    });
  });

  it('collapses single-value status/failureCategory to a scalar', () => {
    const url = urlWith({
      status: 'failed',
      failure_category: 'resource',
    });
    expect(extractListFilterFromQuery(url)).toEqual({
      status: 'failed',
      failureCategory: 'resource',
    });
  });

  it('returns an empty filter when no parameters are set', () => {
    expect(extractListFilterFromQuery(urlWith({}))).toEqual({});
  });

  it('extracts attribute filters', () => {
    const url = urlWith({
      'attr.customerTier': 'gold',
    });
    const result = extractListFilterFromQuery(url);
    expect(result.attributes).toEqual([{ key: 'customerTier', value: 'gold' }]);
  });

  it('extracts repeated exact attribute query parameters as any-of filters', () => {
    const url = urlWith({
      'attr.region': ['us-east', 'eu-west'],
    });
    const result = extractListFilterFromQuery(url);
    expect(result.attributes).toEqual([{ key: 'region', value: ['us-east', 'eu-west'] }]);
  });

  it('preserves repeated exact attribute value types in any-of filters', () => {
    const url = urlWith({
      'attr.score': ['1', '2'],
      'attr.active': ['true', 'false'],
    });
    const result = extractListFilterFromQuery(url);
    const attributes = result.attributes as unknown;
    expect(attributes).toEqual([
      { key: 'score', value: [1, 2] },
      { key: 'active', value: [true, false] },
    ]);
  });
});

describe('extractTimeRangeFromQuery', () => {
  it('returns undefined when no bounds are set', () => {
    expect(extractTimeRangeFromQuery(urlWith({}).searchParams, 'created_at')).toBeUndefined();
  });

  it('ignores non-finite numeric values', () => {
    const params = urlWith({ created_at_gte: 'not-a-number', created_at_lt: '5000' }).searchParams;
    expect(extractTimeRangeFromQuery(params, 'created_at')).toEqual({ lt: 5000 });
  });

  it('extracts all four bounds independently', () => {
    const params = urlWith({
      created_at_gte: '1',
      created_at_gt: '2',
      created_at_lte: '3',
      created_at_lt: '4',
    }).searchParams;
    expect(extractTimeRangeFromQuery(params, 'created_at')).toEqual({
      gte: 1,
      gt: 2,
      lte: 3,
      lt: 4,
    });
  });
});
