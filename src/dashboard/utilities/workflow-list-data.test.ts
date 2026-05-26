import { describe, expect, it, mock } from 'bun:test';

import type { AggregateResult, ApiClient } from '../api-client.ts';
import {
  buildWorkflowListFilter,
  loadWorkflowAggregate,
  loadWorkflowListData,
} from './workflow-list-data.ts';

describe('loadWorkflowListData', () => {
  it('returns workflows even when the retention overview request fails', async () => {
    const apiClient = {
      listWorkflows: mock(async () => ({
        items: [
          {
            id: 'workflow-1',
            type: 'echo',
            status: 'completed' as const,
            version: '1.0.0',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
      })),
      listSchedules: mock(async () => ({
        items: [],
        total: 0,
        offset: 0,
        limit: 20,
      })),
      getRetentionOverview: mock(async () => {
        throw new Error('retention unavailable');
      }),
    } satisfies Pick<ApiClient, 'listWorkflows' | 'listSchedules' | 'getRetentionOverview'>;

    const result = await loadWorkflowListData(
      apiClient,
      {
        status: 'all',
        type: '',
        tags: [],
        offset: 0,
      },
      20,
    );

    expect(result.workflows).toHaveLength(1);
    expect(result.schedules).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.retentionOverview).toBeNull();
  });

  it('passes filters through to the workflow list request and keeps retention data when available', async () => {
    const apiClient = {
      listWorkflows: mock(async (filter) => ({
        items: [],
        total: 0,
        offset: filter?.offset ?? 0,
        limit: filter?.limit ?? 0,
      })),
      listSchedules: mock(async () => ({
        items: [
          {
            id: 'nightly-maintenance',
            workflowType: 'echo',
            cronExpression: '0 * * * *',
            status: 'active' as const,
            overlap: 'queue' as const,
            backfill: true,
            createdAt: 1,
            updatedAt: 2,
            lastFireAt: 3,
            nextFireAt: 4,
            queuedRuns: 0,
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
      })),
      getRetentionOverview: mock(async () => ({
        defaultRetention: { completed: 300_000 },
        sweepIntervalMs: 300_000,
        sweepBatchSize: 1000,
        nextSweepAt: 123_456,
        workflowTypes: [],
      })),
    } satisfies Pick<ApiClient, 'listWorkflows' | 'listSchedules' | 'getRetentionOverview'>;

    const result = await loadWorkflowListData(
      apiClient,
      {
        status: 'completed',
        type: 'echo',
        tags: ['nightly', 'v2'],
        offset: 40,
      },
      20,
    );

    expect(apiClient.listWorkflows).toHaveBeenCalledWith({
      status: 'completed',
      type: 'echo',
      tags: ['nightly', 'v2'],
      limit: 20,
      offset: 40,
    });
    expect(apiClient.listSchedules).toHaveBeenCalledWith({ limit: 20 });
    expect(result.schedules).toEqual([
      expect.objectContaining({
        id: 'nightly-maintenance',
        lastFireAt: 3,
        nextFireAt: 4,
      }),
    ]);
    expect(result.retentionOverview?.nextSweepAt).toBe(123_456);
  });

  it('returns workflows when the schedule request fails', async () => {
    const apiClient = {
      listWorkflows: mock(async () => ({
        items: [
          {
            id: 'workflow-2',
            type: 'echo',
            status: 'running' as const,
            version: '1.0.0',
            createdAt: 10,
            updatedAt: 20,
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
      })),
      listSchedules: mock(async () => {
        throw new Error('schedule unavailable');
      }),
      getRetentionOverview: mock(async () => ({
        defaultRetention: null,
        sweepIntervalMs: 300_000,
        sweepBatchSize: 1000,
        nextSweepAt: null,
        workflowTypes: [],
      })),
    } satisfies Pick<ApiClient, 'listWorkflows' | 'listSchedules' | 'getRetentionOverview'>;

    const result = await loadWorkflowListData(
      apiClient,
      {
        status: 'all',
        type: '',
        tags: [],
        offset: 0,
      },
      20,
    );

    expect(result.workflows).toHaveLength(1);
    expect(result.schedules).toEqual([]);
  });
});

describe('buildWorkflowListFilter', () => {
  it('omits empty / unset fields and always includes pagination', () => {
    expect(buildWorkflowListFilter({ status: 'all', type: '', tags: [], offset: 0 }, 20)).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it('round-trips idPrefix, failureCategory, and time ranges when set', () => {
    const filter = buildWorkflowListFilter(
      {
        status: 'failed',
        type: 'order',
        tags: ['nightly'],
        offset: 0,
        idPrefix: 'order-',
        failureCategory: ['resource', 'application'],
        createdAt: { gte: 1000 },
        updatedAt: { lt: 5000 },
      },
      50,
    );
    expect(filter).toEqual({
      limit: 50,
      offset: 0,
      status: 'failed',
      type: 'order',
      tags: ['nightly'],
      idPrefix: 'order-',
      failureCategory: ['resource', 'application'],
      createdAt: { gte: 1000 },
      updatedAt: { lt: 5000 },
    });
  });

  it('drops empty time-range objects entirely', () => {
    const filter = buildWorkflowListFilter(
      { status: 'all', type: '', tags: [], offset: 0, createdAt: {}, updatedAt: { gte: 1 } },
      20,
    );
    expect(filter.createdAt).toBeUndefined();
    expect(filter.updatedAt).toEqual({ gte: 1 });
  });
});

describe('loadWorkflowAggregate', () => {
  it('omits limit and offset from the request filter, supplies groupBy', async () => {
    const aggregateWorkflows = mock(
      async (_filter?: unknown, _groupBy?: unknown, _limit?: number): Promise<AggregateResult> => ({
        total: 5,
        groups: [{ key: 'running', count: 5 }],
        truncated: false,
      }),
    );
    const apiClient = { aggregateWorkflows } satisfies Pick<ApiClient, 'aggregateWorkflows'>;

    const result = await loadWorkflowAggregate(
      apiClient,
      {
        status: 'failed',
        type: 'order',
        tags: ['nightly'],
        offset: 40,
        createdAt: { gte: 100 },
      },
      'status',
      50,
    );

    expect(result.total).toBe(5);
    expect(aggregateWorkflows).toHaveBeenCalledTimes(1);
    expect(aggregateWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        type: 'order',
        tags: ['nightly'],
        createdAt: { gte: 100 },
      }),
      'status',
      50,
    );
    const requestedFilter = aggregateWorkflows.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(requestedFilter).toBeDefined();
    expect(requestedFilter).not.toHaveProperty('limit');
    expect(requestedFilter).not.toHaveProperty('offset');
  });

  it('passes through attribute groupBy structurally', async () => {
    const aggregateWorkflows = mock(
      async (_filter?: unknown, _groupBy?: unknown): Promise<AggregateResult> => ({
        total: 0,
        groups: [],
        truncated: false,
      }),
    );
    const apiClient = { aggregateWorkflows } satisfies Pick<ApiClient, 'aggregateWorkflows'>;

    await loadWorkflowAggregate(
      apiClient,
      { status: 'all', type: '', tags: [], offset: 0 },
      { attribute: 'customerTier' },
    );

    expect(aggregateWorkflows).toHaveBeenCalledWith(
      expect.anything(),
      { attribute: 'customerTier' },
      undefined,
    );
  });
});
