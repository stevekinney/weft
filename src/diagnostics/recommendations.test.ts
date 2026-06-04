import { describe, expect, it } from 'bun:test';

import { generateRecommendations } from './recommendations.ts';
import type { DatabaseHealth, QueueStatistics, WorkflowStatistics } from './types.ts';
import { THRESHOLDS } from './types.ts';

function makeHealthyDatabase(overrides: Partial<DatabaseHealth> = {}): DatabaseHealth {
  return {
    sizeBytes: 1024,
    sizeLimitBytes: THRESHOLDS.defaultDatabaseSizeLimitBytes,
    walSizeBytes: null,
    integrityOk: true,
    integrityError: null,
    fragmentationPercent: 0,
    journalMode: 'wal',
    pageCount: 100,
    pageSize: 4096,
    freelistCount: 0,
    ...overrides,
  };
}

function makeHealthyWorkflows(overrides: Partial<WorkflowStatistics> = {}): WorkflowStatistics {
  return {
    total: 10,
    statusCounts: {
      pending: 0,
      running: 2,
      completed: 5,
      failed: 1,
      cancelled: 1,
      timedOut: 1,
      suspended: 0,
    },
    longestRunning: null,
    largestCheckpoint: null,
    ...overrides,
  };
}

describe('generateRecommendations', () => {
  it('returns no recommendations for a healthy report', () => {
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase(),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    expect(recommendations).toEqual([]);
  });

  it('generates a critical recommendation when integrity check fails', () => {
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        integrityOk: false,
        integrityError: 'row 42 missing from index',
      }),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('critical');
    expect(recommendations[0]!.section).toBe('database');
    expect(recommendations[0]!.message).toContain('row 42 missing from index');
  });

  it('generates a critical recommendation when database exceeds 95% of size limit', () => {
    const sizeLimitBytes = 10 * 1024 * 1024 * 1024;
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        sizeBytes: sizeLimitBytes * 0.96,
        sizeLimitBytes,
      }),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('critical');
    expect(recommendations[0]!.section).toBe('database');
    expect(recommendations[0]!.message).toContain('capacity');
  });

  it('generates a warning recommendation when database exceeds 80% of size limit', () => {
    const sizeLimitBytes = 10 * 1024 * 1024 * 1024;
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        sizeBytes: sizeLimitBytes * 0.85,
        sizeLimitBytes,
      }),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('warning');
    expect(recommendations[0]!.section).toBe('database');
    expect(recommendations[0]!.message).toContain('capacity');
  });

  it('generates a warning when WAL size exceeds threshold', () => {
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        walSizeBytes: 150 * 1024 * 1024,
      }),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('warning');
    expect(recommendations[0]!.section).toBe('database');
    expect(recommendations[0]!.message).toContain('WAL');
  });

  it('generates a warning when fragmentation exceeds threshold', () => {
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        fragmentationPercent: 25,
      }),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('warning');
    expect(recommendations[0]!.section).toBe('database');
    expect(recommendations[0]!.message).toContain('VACUUM');
  });

  it('generates a warning for long-running workflows (days)', () => {
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase(),
      workflows: makeHealthyWorkflows({
        longestRunning: {
          id: 'wf-stuck',
          type: 'processOrder',
          startedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          elapsedMilliseconds: 8 * 24 * 60 * 60 * 1000,
          currentStep: 5,
        },
      }),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('warning');
    expect(recommendations[0]!.section).toBe('workflows');
    expect(recommendations[0]!.message).toContain('wf-stuck');
    expect(recommendations[0]!.message).toContain('executionTimeout');
  });

  it('generates a warning for long-running workflows (hours)', () => {
    // Use a custom threshold low enough to trigger on 3 hours
    const threeHoursMilliseconds = 3 * 60 * 60 * 1000;
    const recommendations = generateRecommendations(
      {
        database: makeHealthyDatabase(),
        workflows: makeHealthyWorkflows({
          longestRunning: {
            id: 'wf-hours',
            type: 'longProcess',
            startedAt: Date.now() - threeHoursMilliseconds,
            elapsedMilliseconds: threeHoursMilliseconds,
            currentStep: 2,
          },
        }),
        queues: [],
      },
      { longRunningWorkflowMilliseconds: 1000 },
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.message).toContain('wf-hours');
    expect(recommendations[0]!.message).toContain('3h');
  });

  it('generates a warning for long-running workflows (minutes)', () => {
    const fiveMinutesMilliseconds = 5 * 60 * 1000;
    const recommendations = generateRecommendations(
      {
        database: makeHealthyDatabase(),
        workflows: makeHealthyWorkflows({
          longestRunning: {
            id: 'wf-minutes',
            type: 'quickProcess',
            startedAt: Date.now() - fiveMinutesMilliseconds,
            elapsedMilliseconds: fiveMinutesMilliseconds,
            currentStep: 1,
          },
        }),
        queues: [],
      },
      { longRunningWorkflowMilliseconds: 1000 },
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.message).toContain('wf-minutes');
    expect(recommendations[0]!.message).toContain('5m');
  });

  it('generates a warning for long-running workflows (seconds)', () => {
    const thirtySecondsMilliseconds = 30 * 1000;
    const recommendations = generateRecommendations(
      {
        database: makeHealthyDatabase(),
        workflows: makeHealthyWorkflows({
          longestRunning: {
            id: 'wf-seconds',
            type: 'fastProcess',
            startedAt: Date.now() - thirtySecondsMilliseconds,
            elapsedMilliseconds: thirtySecondsMilliseconds,
            currentStep: 0,
          },
        }),
        queues: [],
      },
      { longRunningWorkflowMilliseconds: 1000 },
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.message).toContain('wf-seconds');
    expect(recommendations[0]!.message).toContain('30s');
  });

  it('generates a warning for large checkpoints', () => {
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase(),
      workflows: makeHealthyWorkflows({
        largestCheckpoint: {
          workflowId: 'wf-large',
          sizeBytes: 1024 * 1024,
        },
      }),
      queues: [],
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('warning');
    expect(recommendations[0]!.section).toBe('workflows');
    expect(recommendations[0]!.message).toContain('wf-large');
    expect(recommendations[0]!.message).toContain('state size');
  });

  it('generates a warning for queues with pending work but nothing in-flight', () => {
    const queues: QueueStatistics[] = [{ name: 'default', pendingCount: 5, inflightCount: 0 }];

    const recommendations = generateRecommendations({
      database: makeHealthyDatabase(),
      workflows: makeHealthyWorkflows(),
      queues,
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('warning');
    expect(recommendations[0]!.section).toBe('activities');
    expect(recommendations[0]!.message).toContain('default');
  });

  it('does not warn for queues with inflight operations', () => {
    const queues: QueueStatistics[] = [{ name: 'default', pendingCount: 5, inflightCount: 2 }];

    const recommendations = generateRecommendations({
      database: makeHealthyDatabase(),
      workflows: makeHealthyWorkflows(),
      queues,
    });

    expect(recommendations).toEqual([]);
  });

  it('generates multiple recommendations in order when multiple issues exist', () => {
    const sizeLimitBytes = 10 * 1024 * 1024 * 1024;
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        integrityOk: false,
        integrityError: 'corruption detected',
        sizeBytes: sizeLimitBytes * 0.96,
        sizeLimitBytes,
        walSizeBytes: 150 * 1024 * 1024,
        fragmentationPercent: 25,
      }),
      workflows: makeHealthyWorkflows({
        longestRunning: {
          id: 'wf-stuck',
          type: 'processOrder',
          startedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          elapsedMilliseconds: 8 * 24 * 60 * 60 * 1000,
          currentStep: 5,
        },
        largestCheckpoint: {
          workflowId: 'wf-large',
          sizeBytes: 1024 * 1024,
        },
      }),
      queues: [{ name: 'default', pendingCount: 3, inflightCount: 0 }],
    });

    expect(recommendations.length).toBeGreaterThanOrEqual(6);
    // First should be integrity (critical), then database size (critical)
    expect(recommendations[0]!.severity).toBe('critical');
    expect(recommendations[0]!.message).toContain('corruption detected');
    expect(recommendations[1]!.severity).toBe('critical');
    expect(recommendations[1]!.section).toBe('database');
  });

  it('allows custom thresholds to override defaults', () => {
    // With default thresholds, 25% fragmentation triggers a warning
    // With a higher threshold, it should not
    const recommendations = generateRecommendations(
      {
        database: makeHealthyDatabase({ fragmentationPercent: 25 }),
        workflows: makeHealthyWorkflows(),
        queues: [],
      },
      { fragmentationVacuumPercent: 30 },
    );

    expect(recommendations).toEqual([]);
  });

  it('does not generate both warning and critical for database size', () => {
    const sizeLimitBytes = 10 * 1024 * 1024 * 1024;
    const recommendations = generateRecommendations({
      database: makeHealthyDatabase({
        sizeBytes: sizeLimitBytes * 0.96,
        sizeLimitBytes,
      }),
      workflows: makeHealthyWorkflows(),
      queues: [],
    });

    // Should only have the critical one, not the warning
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]!.severity).toBe('critical');
  });

  it('does not warn about queues with zero pending', () => {
    const queues: QueueStatistics[] = [{ name: 'idle-queue', pendingCount: 0, inflightCount: 0 }];

    const recommendations = generateRecommendations({
      database: makeHealthyDatabase(),
      workflows: makeHealthyWorkflows(),
      queues,
    });

    expect(recommendations).toEqual([]);
  });
});
