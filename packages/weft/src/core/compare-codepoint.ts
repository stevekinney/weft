/**
 * Order two strings by codepoint rather than `localeCompare` (project rule:
 * deterministic comparisons in runtime logic). A standalone leaf module so
 * every codepoint sort across the registry-snapshot family of modules —
 * `registry-snapshot.ts`'s `sortedWorkflows`/`sortedActivities` and
 * `registry-workflow-manifest.ts`'s scoped-activity sort — shares one
 * implementation of the unreachable-in-isolation tie branch, rather than
 * each defining its own uncovered copy, without creating an import cycle
 * between those two modules.
 *
 * @module core/compare-codepoint
 */
export function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
