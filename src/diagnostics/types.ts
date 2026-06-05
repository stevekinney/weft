/**
 * Shared types and threshold constants for Weft diagnostic commands.
 *
 * Used by `weft doctor` (database health, workflow stats, queue depths,
 * recommendations) and `weft version:check` (version compatibility analysis).
 *
 * @module diagnostics/types
 */

import type { VersionCompatibility } from '../core/versioning.ts';

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

/**
 * Tri-level health indicator used throughout the diagnostic system.
 *
 * `'healthy'` means all metrics are within normal bounds; `'warning'`
 * indicates a threshold breach that warrants attention; `'critical'` signals a
 * condition that may affect availability and should be addressed immediately.
 */
export type HealthStatus = 'healthy' | 'warning' | 'critical';

// ---------------------------------------------------------------------------
// Database diagnostics
// ---------------------------------------------------------------------------

/**
 * Low-level SQLite database health metrics collected by `weft doctor`.
 *
 * Includes file size, WAL size, integrity check result, fragmentation
 * percentage, and PRAGMA-level metadata.  Consumers typically read this off a
 * {@link DiagnosticReport} rather than constructing it directly.
 */
export interface DatabaseHealth {
  sizeBytes: number;
  sizeLimitBytes: number;
  walSizeBytes: number | null;
  integrityOk: boolean;
  integrityError: string | null;
  fragmentationPercent: number;
  journalMode: string;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
}

// ---------------------------------------------------------------------------
// Workflow diagnostics
// ---------------------------------------------------------------------------

/**
 * Count of workflows in each lifecycle state at the time of the diagnostic
 * snapshot.
 *
 * Populated inside {@link WorkflowStatistics} and returned as part of a
 * {@link DiagnosticReport}.
 */
export interface WorkflowStatusCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  suspended: number;
}

/**
 * Identity and elapsed wall-clock time of the longest-running workflow in
 * storage.
 *
 * Useful for spotting stuck or runaway workflows.  Included in
 * {@link WorkflowStatistics} when at least one active workflow exists.
 */
export interface LongestRunningWorkflow {
  id: string;
  type: string;
  startedAt: number;
  elapsedMilliseconds: number;
  currentStep: number;
}

/**
 * Workflow ID and byte size of the largest serialised checkpoint in storage.
 *
 * Large checkpoints can indicate excessive state accumulation or unbounded
 * context windows in agent workflows.  Included in {@link WorkflowStatistics}
 * when at least one workflow has a checkpoint.
 */
export interface LargestCheckpoint {
  workflowId: string;
  sizeBytes: number;
}

/**
 * Aggregate workflow statistics collected by `weft doctor`.
 *
 * Combines total workflow count, per-status counts, the longest-running
 * workflow, and the largest checkpoint into a single snapshot.  Populated
 * inside a {@link DiagnosticReport}.
 */
export interface WorkflowStatistics {
  total: number;
  statusCounts: WorkflowStatusCounts;
  longestRunning: LongestRunningWorkflow | null;
  largestCheckpoint: LargestCheckpoint | null;
}

// ---------------------------------------------------------------------------
// Queue diagnostics
// ---------------------------------------------------------------------------

/**
 * Pending and in-flight task counts for a single named activity queue.
 *
 * High `pendingCount` values relative to worker capacity indicate backpressure;
 * high `inflightCount` may suggest workers are slow or stuck.  Included in the
 * `queues` array of a {@link DiagnosticReport}.
 */
export interface QueueStatistics {
  name: string;
  pendingCount: number;
  inflightCount: number;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/**
 * Importance level of a diagnostic {@link Recommendation}.
 *
 * `'info'` is advisory; `'warning'` means the condition should be addressed
 * soon; `'critical'` means it needs immediate attention.
 */
export type RecommendationSeverity = 'info' | 'warning' | 'critical';

/**
 * A single actionable recommendation produced by `weft doctor`.
 *
 * Each recommendation has a human-readable `message`, a `severity` level, and
 * a `section` tag (`'database'`, `'workflows'`, or `'activities'`) so consumers
 * can group or filter the output.
 */
export interface Recommendation {
  severity: RecommendationSeverity;
  message: string;
  section: 'database' | 'workflows' | 'activities';
}

// ---------------------------------------------------------------------------
// Top-level diagnostic report (weft doctor)
// ---------------------------------------------------------------------------

/**
 * Full report produced by `weft doctor`, covering database health, workflow
 * statistics, per-queue depths, and prioritised recommendations.
 *
 * Consumers typically render or log this report rather than constructing it
 * directly — it is returned by the `doctor` command implementation.
 */
export interface DiagnosticReport {
  timestamp: number;
  databasePath: string;
  database: DatabaseHealth;
  workflows: WorkflowStatistics;
  queues: QueueStatistics[];
  recommendations: Recommendation[];
}

// ---------------------------------------------------------------------------
// Version check report (weft version:check)
// ---------------------------------------------------------------------------

/**
 * Per-workflow-type version compatibility analysis for active (running or
 * pending) workflows.
 *
 * Contains the most prevalent stored version, the currently registered version,
 * a running-workflow count, a {@link VersionCompatibility} verdict, and whether
 * a migration exists.  Included in a {@link VersionCheckReport}.
 */
export interface WorkflowTypeReport {
  type: string;
  storedVersion: string;
  registeredVersion: string;
  runningCount: number;
  compatibility: VersionCompatibility;
  hasMigration: boolean;
}

/**
 * Deployment-safety report produced by `weft version:check`.
 *
 * Summarises per-type version compatibility across all active workflows and
 * gives an `overallVerdict` of `'safe'`, `'unsafe'`, or `'needs-migration'`.
 * Returned by {@link runVersionCheck} — consumers do not construct it directly.
 */
export interface VersionCheckReport {
  workflowTypes: WorkflowTypeReport[];
  overallVerdict: 'safe' | 'unsafe' | 'needs-migration';
}

// ---------------------------------------------------------------------------
// Thresholds (tunable constants)
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /** Fragmentation percent above which VACUUM is recommended. */
  fragmentationVacuumPercent: 20,

  /** WAL size in bytes above which a warning is emitted. */
  walSizeWarningBytes: 100 * 1024 * 1024,

  /** Database size as fraction of limit that triggers a warning. */
  databaseSizeWarningFraction: 0.8,

  /** Database size as fraction of limit that triggers critical. */
  databaseSizeCriticalFraction: 0.95,

  /** Workflow running duration (ms) above which a warning is emitted. */
  longRunningWorkflowMilliseconds: 7 * 24 * 60 * 60 * 1000,

  /** Checkpoint size in bytes above which a warning is emitted. */
  largeCheckpointBytes: 512 * 1024,

  /** Default assumed database size limit (10 GB). */
  defaultDatabaseSizeLimitBytes: 10 * 1024 * 1024 * 1024,
} as const;
