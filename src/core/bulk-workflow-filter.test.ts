import { describe, expect, it } from 'bun:test';

import {
  BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
  assertScopedBulkWorkflowFilter,
  hasScopedBulkWorkflowFilter,
} from './bulk-workflow-filter.ts';

describe('hasScopedBulkWorkflowFilter — legacy scopes', () => {
  it('accepts a status filter', () => {
    expect(hasScopedBulkWorkflowFilter({ status: 'completed' })).toBe(true);
    expect(hasScopedBulkWorkflowFilter({ status: ['completed', 'failed'] })).toBe(true);
  });

  it('accepts a non-empty type filter', () => {
    expect(hasScopedBulkWorkflowFilter({ type: 'order' })).toBe(true);
  });

  it('rejects a whitespace-only type filter', () => {
    expect(hasScopedBulkWorkflowFilter({ type: '   ' })).toBe(false);
  });

  it('accepts at least one tag', () => {
    expect(hasScopedBulkWorkflowFilter({ tags: ['nightly'] })).toBe(true);
  });

  it('rejects an empty tags array', () => {
    expect(hasScopedBulkWorkflowFilter({ tags: [] })).toBe(false);
  });

  it('accepts an attribute predicate with a non-empty key', () => {
    expect(
      hasScopedBulkWorkflowFilter({ attributes: [{ key: 'customerId', value: 'acme' }] }),
    ).toBe(true);
  });
});

describe('hasScopedBulkWorkflowFilter — tenantId', () => {
  it('accepts a single non-empty tenant id', () => {
    expect(hasScopedBulkWorkflowFilter({ tenantId: 'acme' })).toBe(true);
  });

  it('accepts an array containing a non-empty tenant id', () => {
    expect(hasScopedBulkWorkflowFilter({ tenantId: ['acme', 'globex'] })).toBe(true);
  });

  it('rejects a whitespace-only tenant id', () => {
    expect(hasScopedBulkWorkflowFilter({ tenantId: '   ' })).toBe(false);
  });

  it('rejects an array of only whitespace tenant ids', () => {
    expect(hasScopedBulkWorkflowFilter({ tenantId: ['  ', ''] })).toBe(false);
  });
});

describe('hasScopedBulkWorkflowFilter — idPrefix', () => {
  it('accepts an idPrefix at the minimum length', () => {
    expect(hasScopedBulkWorkflowFilter({ idPrefix: 'abc' })).toBe(true);
  });

  it('rejects an idPrefix shorter than 3 chars', () => {
    expect(hasScopedBulkWorkflowFilter({ idPrefix: 'ab' })).toBe(false);
  });

  it('accepts a longer idPrefix', () => {
    expect(hasScopedBulkWorkflowFilter({ idPrefix: 'order-' })).toBe(true);
  });
});

describe('hasScopedBulkWorkflowFilter — failureCategory', () => {
  it('rejects failureCategory alone (footgun)', () => {
    expect(hasScopedBulkWorkflowFilter({ failureCategory: 'resource' })).toBe(false);
    expect(hasScopedBulkWorkflowFilter({ failureCategory: ['resource', 'application'] })).toBe(
      false,
    );
  });

  it('accepts failureCategory combined with a status filter', () => {
    expect(hasScopedBulkWorkflowFilter({ failureCategory: 'resource', status: 'failed' })).toBe(
      true,
    );
  });
});

describe('hasScopedBulkWorkflowFilter — time ranges alone', () => {
  it('rejects createdAt range without any other scope', () => {
    expect(hasScopedBulkWorkflowFilter({ createdAt: { gte: 1 } })).toBe(false);
  });

  it('rejects updatedAt range without any other scope', () => {
    expect(hasScopedBulkWorkflowFilter({ updatedAt: { lte: 2 } })).toBe(false);
  });

  it('rejects executionDeadline range without any other scope', () => {
    expect(hasScopedBulkWorkflowFilter({ executionDeadline: { gt: 0 } })).toBe(false);
  });

  it('accepts a time range combined with status', () => {
    expect(hasScopedBulkWorkflowFilter({ createdAt: { gte: 1 }, status: 'completed' })).toBe(true);
  });

  it('accepts a time range combined with tenantId', () => {
    expect(hasScopedBulkWorkflowFilter({ updatedAt: { lt: 100 }, tenantId: 'acme' })).toBe(true);
  });
});

describe('hasScopedBulkWorkflowFilter — empty filter', () => {
  it('rejects an empty filter', () => {
    expect(hasScopedBulkWorkflowFilter({})).toBe(false);
  });
});

describe('assertScopedBulkWorkflowFilter', () => {
  it('returns the filter when scoped', () => {
    const filter = { status: 'completed' as const };
    expect(assertScopedBulkWorkflowFilter(filter)).toBe(filter);
  });

  it('throws BULK_WORKFLOW_FILTER_ERROR_MESSAGE when unscoped', () => {
    expect(() => assertScopedBulkWorkflowFilter({})).toThrow(BULK_WORKFLOW_FILTER_ERROR_MESSAGE);
  });

  it('throws on a time-range-only filter', () => {
    expect(() => assertScopedBulkWorkflowFilter({ createdAt: { gte: 1 } })).toThrow(
      BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
    );
  });

  it('throws on a failureCategory-only filter', () => {
    expect(() => assertScopedBulkWorkflowFilter({ failureCategory: 'resource' })).toThrow(
      BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
    );
  });

  it('throws on an idPrefix shorter than the minimum', () => {
    expect(() => assertScopedBulkWorkflowFilter({ idPrefix: 'ab' })).toThrow(
      BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
    );
  });
});
