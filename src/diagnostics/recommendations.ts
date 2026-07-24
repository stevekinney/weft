/**
 * Recommendation engine for Weft diagnostics.
 *
 * Analyzes database health, workflow statistics, and queue statistics
 * to produce actionable recommendations ordered by severity.
 *
 * @module diagnostics/recommendations
 */

import { formatBytes } from './format.ts';
import type {
  DatabaseHealth,
  QueueStatistics,
  Recommendation,
  WorkflowStatistics,
} from './types.ts';
import { THRESHOLDS } from './types.ts';

type ResolvedThresholds = { readonly [K in keyof typeof THRESHOLDS]: number };

type RuleContext = {
  readonly database: DatabaseHealth;
  readonly workflows: WorkflowStatistics;
  readonly queues: QueueStatistics[];
  readonly thresholds: ResolvedThresholds;
};

type Rule = (context: RuleContext) => Recommendation[];

function integrityFailureRule({ database }: RuleContext): Recommendation[] {
  if (database.integrityOk) return [];
  return [
    {
      severity: 'critical',
      section: 'database',
      message: `Database integrity check failed: ${database.integrityError}`,
    },
  ];
}

function databaseSizeRule({ database, thresholds }: RuleContext): Recommendation[] {
  if (database.sizeLimitBytes <= 0) return [];
  const fraction = database.sizeBytes / database.sizeLimitBytes;
  const message = `Database is at ${(fraction * 100).toFixed(1)}% capacity (${formatBytes(database.sizeBytes)} / ${formatBytes(database.sizeLimitBytes)}).`;
  if (fraction > thresholds.databaseSizeCriticalFraction) {
    return [{ severity: 'critical', section: 'database', message }];
  }
  if (fraction > thresholds.databaseSizeWarningFraction) {
    return [{ severity: 'warning', section: 'database', message }];
  }
  return [];
}

function walSizeRule({ database, thresholds }: RuleContext): Recommendation[] {
  if (database.walSizeBytes === null || database.walSizeBytes <= thresholds.walSizeWarningBytes) {
    return [];
  }
  return [
    {
      severity: 'warning',
      section: 'database',
      message: `WAL file is ${formatBytes(database.walSizeBytes)}, which may indicate stalled checkpointing.`,
    },
  ];
}

function fragmentationRule({ database, thresholds }: RuleContext): Recommendation[] {
  if (database.fragmentationPercent <= thresholds.fragmentationVacuumPercent) return [];
  return [
    {
      severity: 'warning',
      section: 'database',
      message: `Database fragmentation is ${database.fragmentationPercent.toFixed(1)}%. Running VACUUM is recommended.`,
    },
  ];
}

function longRunningWorkflowRule({ workflows, thresholds }: RuleContext): Recommendation[] {
  const longest = workflows.longestRunning;
  if (!longest || longest.elapsedMilliseconds <= thresholds.longRunningWorkflowMilliseconds) {
    return [];
  }
  return [
    {
      severity: 'warning',
      section: 'workflows',
      message: `Workflow "${longest.id}" has been running for ${formatDuration(longest.elapsedMilliseconds)}. Consider setting an executionTimeout to prevent runaway workflows.`,
    },
  ];
}

function largeCheckpointRule({ workflows, thresholds }: RuleContext): Recommendation[] {
  const largest = workflows.largestCheckpoint;
  if (!largest || largest.sizeBytes <= thresholds.largeCheckpointBytes) return [];
  return [
    {
      severity: 'warning',
      section: 'workflows',
      message: `Workflow "${largest.workflowId}" has a ${formatBytes(largest.sizeBytes)} checkpoint. Consider reducing state size to improve serialization performance.`,
    },
  ];
}

function idleQueueRule({ queues }: RuleContext): Recommendation[] {
  const out: Recommendation[] = [];
  for (const queue of queues) {
    if (queue.pendingCount > 0 && queue.inflightCount === 0) {
      out.push({
        severity: 'warning',
        section: 'activities',
        message: `Queue "${queue.name}" has ${queue.pendingCount} pending operation(s) but nothing in-flight. Workers may be stopped or disconnected.`,
      });
    }
  }
  return out;
}

// Rule order defines the order recommendations appear in the report. Do not
// reorder without updating tests that assert sequencing.
const RECOMMENDATION_RULES: readonly Rule[] = [
  integrityFailureRule,
  databaseSizeRule,
  walSizeRule,
  fragmentationRule,
  longRunningWorkflowRule,
  largeCheckpointRule,
  idleQueueRule,
];

/**
 * Generate recommendations based on diagnostic data.
 *
 * Rules are checked in a fixed order so that the most critical issues
 * appear first in the returned array.
 *
 * @example
 * ```ts
 * import { MemoryStorage, collectDiagnostics, generateRecommendations } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * const report = await collectDiagnostics(storage, ':memory:');
 * const recs = generateRecommendations({
 *   database: report.database,
 *   workflows: report.workflows,
 *   queues: report.queues,
 * });
 * console.log(recs.length); // 0 for a healthy instance
 * ```
 */
export function generateRecommendations(
  report: {
    database: DatabaseHealth;
    workflows: WorkflowStatistics;
    queues: QueueStatistics[];
  },
  thresholds?: Partial<{ [K in keyof typeof THRESHOLDS]: number }>,
): Recommendation[] {
  const context: RuleContext = {
    database: report.database,
    workflows: report.workflows,
    queues: report.queues,
    thresholds: { ...THRESHOLDS, ...thresholds },
  };
  return RECOMMENDATION_RULES.flatMap((rule) => rule(context));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
