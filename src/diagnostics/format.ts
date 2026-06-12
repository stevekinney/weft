/**
 * Output formatters for diagnostic commands.
 *
 * Provides human-readable formatting for `weft doctor` and `weft version:check`
 * reports, plus utility functions for byte sizes and durations.
 *
 * @module diagnostics/format
 */

import type { DiagnosticReport, VersionCheckReport } from './types.ts';

// ---------------------------------------------------------------------------
// ANSI color utilities (internal)
// ---------------------------------------------------------------------------

const supportsColor =
  typeof process !== 'undefined' && process.stdout?.isTTY && !process.env['NO_COLOR'];

const color = {
  green: (text: string) => (supportsColor ? `\x1b[32m${text}\x1b[0m` : text),
  red: (text: string) => (supportsColor ? `\x1b[31m${text}\x1b[0m` : text),
  bold: (text: string) => (supportsColor ? `\x1b[1m${text}\x1b[0m` : text),
};

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable string.
 *
 * - 0 returns '0 B'
 * - Values under 1024 return '{n} B'
 * - Values under 1024^2 return '{n} KB' (1 decimal place)
 * - Values under 1024^3 return '{n} MB' (1 decimal place)
 * - Otherwise returns '{n} GB' (1 decimal place)
 *
 * @example
 * ```ts
 * import { formatBytes } from '@lostgradient/weft';
 *
 * console.log(formatBytes(0));         // '0 B'
 * console.log(formatBytes(1024));      // '1.0 KB'
 * console.log(formatBytes(1048576));   // '1.0 MB'
 * ```
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * - Under 1000ms: '{n}ms'
 * - Under 60000ms: '{n} seconds' (rounded)
 * - Under 3600000ms: '{n} minutes' (rounded)
 * - Under 86400000ms: '{n} hours' optionally with minutes
 * - Otherwise: '{n} days' optionally with hours
 *
 * @example
 * ```ts
 * import { formatDuration } from '@lostgradient/weft';
 *
 * console.log(formatDuration(500));      // '500ms'
 * console.log(formatDuration(90000));    // '2 minutes'
 * console.log(formatDuration(7200000));  // '2 hours'
 * ```
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)} seconds`;
  if (milliseconds < 3600000) return `${Math.round(milliseconds / 60000)} minutes`;
  if (milliseconds < 86400000) {
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.round((milliseconds % 3600000) / 60000);
    if (minutes > 0) return `${hours} hours ${minutes} minutes`;
    return `${hours} hours`;
  }
  const days = Math.floor(milliseconds / 86400000);
  const hours = Math.round((milliseconds % 86400000) / 3600000);
  if (hours > 0) return `${days} days ${hours} hours`;
  return `${days} days`;
}

// ---------------------------------------------------------------------------
// Diagnostic report formatter (weft doctor)
// ---------------------------------------------------------------------------

function appendDatabaseSection(lines: string[], database: DiagnosticReport['database']): void {
  lines.push(color.bold('Database:'));
  lines.push(
    `  Size: ${formatBytes(database.sizeBytes)} (of ${formatBytes(database.sizeLimitBytes)})`,
  );
  lines.push(
    `  WAL size: ${database.walSizeBytes !== null ? formatBytes(database.walSizeBytes) : 'N/A'}`,
  );
  lines.push(`  Integrity: ${database.integrityOk ? 'OK' : `FAILED: ${database.integrityError}`}`);
  lines.push(`  Fragmentation: ${database.fragmentationPercent}%`);
}

function appendWorkflowsSection(lines: string[], workflows: DiagnosticReport['workflows']): void {
  lines.push('');
  lines.push(color.bold('Workflows:'));
  if (workflows.total === 0) {
    lines.push('  Total: 0 (no workflows)');
    return;
  }
  const counts = workflows.statusCounts;
  const suspendedSummary = counts.suspended > 0 ? `, ${counts.suspended} suspended` : '';
  lines.push(
    `  Total: ${workflows.total} (${counts.running} running, ${counts.completed} completed, ` +
      `${counts.failed} failed${suspendedSummary})`,
  );
  if (workflows.longestRunning) {
    const longest = workflows.longestRunning;
    lines.push(
      `  Longest running: ${longest.id} (started ${formatDuration(longest.elapsedMilliseconds)} ago, step ${longest.currentStep})`,
    );
  }
  if (workflows.largestCheckpoint) {
    const largest = workflows.largestCheckpoint;
    lines.push(`  Largest checkpoint: ${largest.workflowId} (${formatBytes(largest.sizeBytes)})`);
  }
}

function appendActivitiesSection(lines: string[], queues: DiagnosticReport['queues']): void {
  lines.push('');
  lines.push(color.bold('Activities:'));
  if (queues.length === 0) {
    lines.push('  No activity queues');
    return;
  }
  for (const queue of queues) {
    lines.push(
      `  Queue "${queue.name}": ${queue.pendingCount} pending, ${queue.inflightCount} in-flight`,
    );
  }
}

function recommendationIcon(
  severity: DiagnosticReport['recommendations'][number]['severity'],
): string {
  return severity === 'critical' ? '!!' : '!';
}

function appendRecommendationsSection(
  lines: string[],
  recommendations: DiagnosticReport['recommendations'],
): void {
  lines.push('');
  lines.push(color.bold('Recommendations:'));
  if (recommendations.length === 0) {
    lines.push('  No issues found.');
    return;
  }
  for (const recommendation of recommendations) {
    lines.push(`  ${recommendationIcon(recommendation.severity)} ${recommendation.message}`);
  }
}

/**
 * Format a DiagnosticReport into a human-readable multi-section string.
 *
 * @example
 * ```ts
 * import { MemoryStorage, collectDiagnostics, formatDiagnosticReport } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * const report = await collectDiagnostics(storage, ':memory:');
 * console.log(formatDiagnosticReport(report));
 * ```
 */
export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  appendDatabaseSection(lines, report.database);
  appendWorkflowsSection(lines, report.workflows);
  appendActivitiesSection(lines, report.queues);
  appendRecommendationsSection(lines, report.recommendations);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Version check report formatter (weft version:check)
// ---------------------------------------------------------------------------

/**
 * Format a VersionCheckReport into a human-readable string.
 *
 * @example
 * ```ts
 * import type { VersionCheckReport } from '@lostgradient/weft';
 * import { formatVersionCheckReport } from '@lostgradient/weft';
 *
 * const report: VersionCheckReport = {
 *   workflowTypes: [],
 *   overallVerdict: 'safe',
 * };
 * console.log(formatVersionCheckReport(report));
 * // Result: safe to deploy.
 * ```
 */
export function formatVersionCheckReport(report: VersionCheckReport): string {
  const lines: string[] = [];

  for (const typeReport of report.workflowTypes) {
    lines.push(
      `${typeReport.type} (${typeReport.storedVersion} → ${typeReport.registeredVersion}):`,
    );
    lines.push(`  ${typeReport.runningCount} running workflows`);
    lines.push(`  Compatibility: ${typeReport.compatibility}`);
    lines.push('');
  }

  // Overall result
  switch (report.overallVerdict) {
    case 'safe':
      lines.push(`Result: ${color.green('Safe to deploy.')}`);
      break;
    case 'unsafe':
      lines.push(`Result: ${color.red('UNSAFE: version mismatches found.')}`);
      break;
  }

  return lines.join('\n');
}
