/**
 * `WorkflowRevisionReferenceCounts` — the bounded accounting interface a
 * `(name, revision)` removal decision is gated on (WFT-12).
 *
 * Seven fields, all always present so a consumer never has to special-case
 * an "unknown" reference kind. Two are wired to real in-process signals this
 * batch; the remaining five stay structurally present but always `0` until
 * run-level revision pinning lands (WFT-17) gives them something real to
 * count — see each field's own doc for its specific WFT-17 dependency. This
 * mirrors `workflow-catalog.ts`'s own precedent of describing a forward
 * dependency in prose rather than leaving a `TODO`/`FIXME` marker.
 *
 * Keyed by structured `(name, revision)` throughout — nested
 * `Map<string, Map<string, number>>`, never a delimiter-joined string — so a
 * workflow `name` or `revision` equal to `'__proto__'`/`'toString'` or
 * containing a colon is always handled correctly, matching
 * `WorkflowCatalog`'s own `#entries` convention.
 *
 * @module core/catalog/reference-counts
 */

/**
 * Every reference kind a `(name, revision)` removal decision considers.
 * Removal is refused whenever {@link totalWorkflowRevisionReferences} is
 * nonzero for the target revision.
 *
 * @example
 * ```ts
 * import type { WorkflowRevisionReferenceCounts } from '@lostgradient/weft';
 *
 * function summarize(counts: WorkflowRevisionReferenceCounts): string {
 *   return `${counts.registeredDefinitions} registered, ${counts.inFlightStarts} in flight`;
 * }
 * void summarize;
 * ```
 */
export type WorkflowRevisionReferenceCounts = Readonly<{
  /**
   * `1` when this process's own `engine.register()`-drain path most
   * recently activated exactly this revision for this name, `0` otherwise.
   * Wired now, from `EngineInternals.registeredCatalogRevisions`.
   */
  registeredDefinitions: number;
  /**
   * Count of this process's own in-flight `startWorkflow` calls reserved
   * against this revision (from `EngineInternals.inFlightStartsByRevision`).
   * Wired now; scoped to the single `lifecycle/start.ts` choke point used by
   * `engine.start()`/`engine.startOrSignal()`'s create path — `ctx.startChild()`
   * and bulk `startBatch()` do not funnel through it yet.
   */
  inFlightStarts: number;
  /**
   * Non-terminal runs whose `WorkflowState` pins exactly this revision.
   * Always `0` until run-level revision pinning (WFT-17) gives a run's
   * persisted state a `revision` field to count against.
   */
  nonTerminalRuns: number;
  /**
   * Schedules pinned to exactly this revision. Always `0` until WFT-17
   * introduces schedule-level revision pinning.
   */
  pinnedSchedules: number;
  /**
   * Queued dispatches (delayed starts, retries) targeting exactly this
   * revision. Always `0` until WFT-17 threads revision identity through the
   * dispatch ledger.
   */
  pendingDispatches: number;
  /**
   * Active execution realms (remote worker sessions) currently running
   * exactly this revision. Always `0` until WFT-17 gives a realm's
   * advertised contract a revision this accounting can compare against.
   */
  activeExecutionRealms: number;
  /**
   * Retained recovery records (crash-recovery checkpoints, dead letters)
   * referencing exactly this revision. Always `0` until WFT-17 threads
   * revision identity through those retained records.
   */
  retainedRecoveryRecords: number;
}>;

/** Sum every field of `counts` — nonzero means removal must be refused. */
export function totalWorkflowRevisionReferences(counts: WorkflowRevisionReferenceCounts): number {
  return (
    counts.registeredDefinitions +
    counts.inFlightStarts +
    counts.nonTerminalRuns +
    counts.pinnedSchedules +
    counts.pendingDispatches +
    counts.activeExecutionRealms +
    counts.retainedRecoveryRecords
  );
}

/**
 * Increment the `(name, revision)` count in a nested
 * `Map<string, Map<string, number>>`, creating the inner map and the entry
 * as needed.
 */
export function incrementNestedRevisionCount(
  counts: Map<string, Map<string, number>>,
  name: string,
  revision: string,
): void {
  let byRevision = counts.get(name);
  if (byRevision === undefined) {
    byRevision = new Map();
    counts.set(name, byRevision);
  }
  byRevision.set(revision, (byRevision.get(revision) ?? 0) + 1);
}

/**
 * Decrement the `(name, revision)` count in a nested
 * `Map<string, Map<string, number>>`. Removes the revision's own entry once
 * it reaches `0` (rather than leaving a stale `0` behind) and removes the
 * name's inner map once it is empty. A decrement against an absent
 * `(name, revision)` is a no-op — never goes negative.
 */
export function decrementNestedRevisionCount(
  counts: Map<string, Map<string, number>>,
  name: string,
  revision: string,
): void {
  const byRevision = counts.get(name);
  if (byRevision === undefined) return;
  const current = byRevision.get(revision);
  if (current === undefined) return;
  if (current <= 1) {
    byRevision.delete(revision);
    if (byRevision.size === 0) {
      counts.delete(name);
    }
  } else {
    byRevision.set(revision, current - 1);
  }
}

/** Read the `(name, revision)` count from a nested map, `0` when absent. */
export function readNestedRevisionCount(
  counts: Map<string, Map<string, number>>,
  name: string,
  revision: string,
): number {
  return counts.get(name)?.get(revision) ?? 0;
}
