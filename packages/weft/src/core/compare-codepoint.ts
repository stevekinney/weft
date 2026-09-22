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

/**
 * Compare two strings by Unicode codepoint, returning the usual `-1`/`0`/`1`
 * contract for `Array.prototype.sort`.
 *
 * Reach for this instead of `localeCompare` anywhere the resulting order has
 * to be reproducible: snapshot contents, generated code, digests, and any
 * other value a later run is expected to match byte for byte. `localeCompare`
 * consults the host's collation data, so it can order the same two strings
 * differently on two machines — and because codepoint order sorts every
 * uppercase letter ahead of every lowercase one, the two disagree even in the
 * default locale.
 *
 * @example
 * ```ts
 * import { compareCodepoint } from '@lostgradient/weft';
 *
 * const workflowNames = ['send-invoice', 'Archive', 'reconcile'];
 * const deterministic = [...workflowNames].sort(compareCodepoint);
 * console.log(deterministic); // ['Archive', 'reconcile', 'send-invoice']
 * ```
 */
export function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
