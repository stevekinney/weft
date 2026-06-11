import { describe, expect, it } from 'bun:test';

import {
  formatBytes,
  formatDiagnosticReport,
  formatDuration,
  formatVersionCheckReport,
} from './format.ts';
import type { DiagnosticReport, VersionCheckReport } from './types.ts';

describe('formatBytes', () => {
  it('formats 0 as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats values under 1024 in bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats values in kilobytes with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats values in megabytes with one decimal', () => {
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('formats values in gigabytes with one decimal', () => {
    expect(formatBytes(2.3 * 1024 * 1024 * 1024)).toBe('2.3 GB');
  });

  it('formats exactly 1024 as kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });
});

describe('formatDuration', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats durations under a minute in seconds', () => {
    expect(formatDuration(45000)).toBe('45 seconds');
  });

  it('formats durations under an hour in minutes', () => {
    expect(formatDuration(120000)).toBe('2 minutes');
  });

  it('formats durations in hours', () => {
    expect(formatDuration(7200000)).toBe('2 hours');
  });

  it('formats durations in hours with remaining minutes', () => {
    expect(formatDuration(5400000)).toBe('1 hours 30 minutes');
  });

  it('formats durations in days', () => {
    expect(formatDuration(47 * 24 * 60 * 60 * 1000)).toBe('47 days');
  });

  it('formats durations in days with remaining hours', () => {
    expect(formatDuration(26 * 60 * 60 * 1000)).toBe('1 days 2 hours');
  });
});

describe('formatDiagnosticReport', () => {
  function makeFullReport(): DiagnosticReport {
    return {
      timestamp: Date.now(),
      databasePath: './weft.db',
      database: {
        sizeBytes: 5 * 1024 * 1024,
        sizeLimitBytes: 10 * 1024 * 1024 * 1024,
        walSizeBytes: 2 * 1024 * 1024,
        integrityOk: true,
        integrityError: null,
        fragmentationPercent: 5,
        journalMode: 'wal',
        pageCount: 1000,
        pageSize: 4096,
        freelistCount: 50,
      },
      workflows: {
        total: 154,
        statusCounts: {
          pending: 10,
          running: 50,
          completed: 80,
          failed: 5,
          cancelled: 3,
          timedOut: 2,
          suspended: 4,
        },
        longestRunning: {
          id: 'wf-long',
          type: 'order',
          startedAt: Date.now() - 3600000,
          elapsedMilliseconds: 3600000,
          currentStep: 7,
        },
        largestCheckpoint: {
          workflowId: 'wf-big',
          sizeBytes: 128 * 1024,
        },
      },
      queues: [
        { name: 'default', pendingCount: 25, inflightCount: 5 },
        { name: 'email', pendingCount: 0, inflightCount: 2 },
      ],
      recommendations: [
        { severity: 'warning', message: 'Consider running VACUUM', section: 'database' },
        { severity: 'critical', message: 'Database near capacity', section: 'database' },
      ],
    };
  }

  it('includes all sections in a full report', () => {
    const report = makeFullReport();
    const output = formatDiagnosticReport(report);

    expect(output).toContain('Database:');
    expect(output).toContain('Size:');
    expect(output).toContain('Integrity: OK');
    expect(output).toContain('Fragmentation: 5%');
    expect(output).toContain('Workflows:');
    expect(output).toContain('Total: 154');
    expect(output).toContain('50 running');
    expect(output).toContain('80 completed');
    expect(output).toContain('5 failed');
    // The suspended-count branch renders only when the count is nonzero.
    expect(output).toContain('4 suspended');
    expect(output).toContain('wf-long');
    expect(output).toContain('step 7');
    expect(output).toContain('wf-big');
    expect(output).toContain('Activities:');
    expect(output).toContain('Queue "default"');
    expect(output).toContain('25 pending');
    expect(output).toContain('Recommendations:');
    expect(output).toContain('Consider running VACUUM');
    expect(output).toContain('Database near capacity');
  });

  it('shows N/A for null WAL size', () => {
    const report = makeFullReport();
    report.database.walSizeBytes = null;
    const output = formatDiagnosticReport(report);
    expect(output).toContain('N/A');
  });

  it('shows integrity error when integrity check fails', () => {
    const report = makeFullReport();
    report.database.integrityOk = false;
    report.database.integrityError = 'Page corruption detected';
    const output = formatDiagnosticReport(report);
    expect(output).toContain('FAILED: Page corruption detected');
  });

  it('shows "no workflows" for an empty database', () => {
    const report: DiagnosticReport = {
      timestamp: Date.now(),
      databasePath: './weft.db',
      database: {
        sizeBytes: 0,
        sizeLimitBytes: 10 * 1024 * 1024 * 1024,
        walSizeBytes: null,
        integrityOk: true,
        integrityError: null,
        fragmentationPercent: 0,
        journalMode: 'wal',
        pageCount: 0,
        pageSize: 4096,
        freelistCount: 0,
      },
      workflows: {
        total: 0,
        statusCounts: {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          timedOut: 0,
          suspended: 0,
        },
        longestRunning: null,
        largestCheckpoint: null,
      },
      queues: [],
      recommendations: [],
    };
    const output = formatDiagnosticReport(report);

    expect(output).toContain('Total: 0 (no workflows)');
    expect(output).toContain('No activity queues');
    expect(output).toContain('No issues found.');
  });

  it('shows recommendation icons based on severity', () => {
    const report = makeFullReport();
    const output = formatDiagnosticReport(report);

    // warning gets "!"
    expect(output).toContain('! Consider running VACUUM');
    // critical gets "!!"
    expect(output).toContain('!! Database near capacity');
  });
});

describe('formatVersionCheckReport', () => {
  it('shows "Safe to deploy" when all types are compatible', () => {
    const report: VersionCheckReport = {
      workflowTypes: [
        {
          type: 'order',
          storedVersion: '1.0.0',
          registeredVersion: '1.0.0',
          runningCount: 5,
          compatibility: 'compatible',
        },
      ],
      overallVerdict: 'safe',
    };

    const output = formatVersionCheckReport(report);

    expect(output).toContain('order (1.0.0');
    expect(output).toContain('5 running workflows');
    expect(output).toContain('compatible');
    expect(output).toContain('Safe to deploy');
  });

  it('shows "UNSAFE" when versions are incompatible', () => {
    const report: VersionCheckReport = {
      workflowTypes: [
        {
          type: 'payment',
          storedVersion: '1.0.0',
          registeredVersion: '3.0.0',
          runningCount: 2,
          compatibility: 'incompatible',
        },
      ],
      overallVerdict: 'unsafe',
    };

    const output = formatVersionCheckReport(report);

    expect(output).toContain('UNSAFE');
    expect(output).toContain('version mismatches found');
  });

  it('shows "Safe to deploy" for empty workflow types', () => {
    const report: VersionCheckReport = {
      workflowTypes: [],
      overallVerdict: 'safe',
    };

    const output = formatVersionCheckReport(report);

    expect(output).toContain('Safe to deploy');
  });
});
