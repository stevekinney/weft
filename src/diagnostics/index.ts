/**
 * Diagnostics public surface — doctor checks, memory profiling, formatting,
 * recommendations, and version checks. Re-exported from the package root
 * (`weft`) so the diagnostics API is importable without reaching into the
 * `diagnostics/` directory directly.
 *
 * @module diagnostics
 */

export { collectDiagnostics } from './doctor.ts';
export {
  formatBytes,
  formatDiagnosticReport,
  formatDuration,
  formatVersionCheckReport,
} from './format.ts';
export { MemoryProfiler, analyzeStability, linearRegression } from './memory-profiler.ts';
export type {
  MemoryProfile,
  MemorySample,
  StabilityOptions,
  StabilityResult,
} from './memory-profiler.ts';
export { generateRecommendations } from './recommendations.ts';
export type {
  DatabaseHealth,
  DiagnosticReport,
  HealthStatus,
  LargestCheckpoint,
  LongestRunningWorkflow,
  QueueStatistics,
  Recommendation,
  RecommendationSeverity,
  VersionCheckReport,
  WorkflowStatistics,
  WorkflowStatusCounts,
  WorkflowTypeReport,
} from './types.ts';
export { runVersionCheck } from './version-check.ts';
