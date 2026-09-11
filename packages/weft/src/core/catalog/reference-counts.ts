/**
 * `WorkflowRevisionReferenceCounts` — the bounded accounting interface a
 * `(name, revision)` removal decision is gated on (WFT-12).
 *
 * Seven fields, all always present so a consumer never has to special-case
 * an "unknown" reference kind. Five are wired to real in-process/durable
 * signals: `registeredDefinitions` and `inFlightStarts` from WFT-12,
 * `nonTerminalRuns` from WFT-17 (a bounded storage scan of persisted
 * `WorkflowState.revision` pins — see {@link countNonTerminalRunsForRevision}),
 * `pinnedSchedules` from WFT-20 (a bounded storage scan of persisted
 * `revisionPolicy: 'pinned'` schedules — see
 * {@link import('../engine/pinned-schedule-revision-count.ts').countPinnedSchedulesForRevision}),
 * and `retainedRecoveryRecords` from WFT-21 (a terminal-but-unpurged
 * `WorkflowState` plus a `TeardownDeadLetterRecord`, both pinned to the
 * revision — see {@link import('../engine/nonterminal-revision-count.ts').countWorkflowStateRevisionsByStatus}'s
 * `terminalRuns` and {@link import('../engine/retained-recovery-record-count.ts').countTeardownDeadLettersForRevision}).
 * The remaining two (`pendingDispatches`, `activeExecutionRealms`) stay
 * structurally present but always `0` — each awaits revision identity in a
 * different, later-owned subsystem (the dispatch ledger and execution
 * realms — not yet scheduled) — see each field's own doc for its specific
 * dependency. This mirrors `workflow-catalog.ts`'s own precedent of
 * describing a forward dependency in prose rather than leaving a
 * `TODO`/`FIXME` marker.
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
   * Wired now; the reservation lives inside `lifecycle/start.ts`'s single
   * `startWorkflow` choke point itself, so every caller that funnels through
   * it is already counted — `engine.start()`/`engine.startOrSignal()`'s
   * create path, and `ctx.startChild()` too, since
   * `createChildWorkflowOperationCallbacks` (`callback-creators-bundles.ts`)
   * calls the very same `startWorkflow`. There is no separate bulk
   * `startBatch()` entry point to funnel — `buildStartBatchOperations` is
   * internal plumbing already inside this same `startWorkflow` call,
   * building one start's own storage-write batch, not a distinct
   * multi-start API.
   */
  inFlightStarts: number;
  /**
   * Non-terminal (`running`/`pending`/`suspended`) runs whose `WorkflowState`
   * pins exactly this revision. Wired now (WFT-17), via a bounded
   * `storage.scan('wf:')` — see
   * {@link import('../engine/nonterminal-revision-count.ts').countNonTerminalRunsForRevision}.
   * A legacy run with no persisted `revision` never counts against any
   * specific revision here.
   */
  nonTerminalRuns: number;
  /**
   * Non-cancelled schedules with `revisionPolicy: 'pinned'` and
   * `pinnedRevision` equal to exactly this revision. Wired now (WFT-20), via
   * a bounded `storage.scan('schedule:')` — see
   * {@link import('../engine/pinned-schedule-revision-count.ts').countPinnedSchedulesForRevision}.
   * An `'active-at-fire'` schedule never counts here, regardless of its
   * `workflowType` — it resolves whatever revision is active at each future
   * fire, so it holds no standing reference to any one revision.
   */
  pinnedSchedules: number;
  /**
   * Queued dispatches (delayed starts, retries) targeting exactly this
   * revision. Always `0` until a later batch threads revision identity
   * through the dispatch ledger.
   */
  pendingDispatches: number;
  /**
   * Active execution realms (remote worker sessions) currently running
   * exactly this revision. Always `0` until a later batch gives a realm's
   * advertised contract a revision this accounting can compare against.
   */
  activeExecutionRealms: number;
  /**
   * Durable recovery evidence pinned to exactly this revision, that only a
   * later, explicit action can release (WFT-21). Two components, summed:
   *
   * - A terminal (`completed`/`failed`/`cancelled`/`timed-out`)
   *   `WorkflowState` that has not yet been purged — a completed run is
   *   forkable and a failed run is retryable, both against the exact
   *   revision they ran, so both are genuine durable references. Released
   *   by an ordinary workflow purge or retention sweep, which already
   *   deletes the terminal `WorkflowState` through a fenced write — no new
   *   release path was needed.
   * - A `TeardownDeadLetterRecord` (a permanently failed finalizer) pinned
   *   to this revision. Deliberately excluded from the purge delete-set as
   *   leak evidence, so — unlike the first component — this one is NEVER
   *   auto-released: a revision that ever dead-lettered stays permanently
   *   non-removable until a future acknowledge/clear API exists (not built
   *   this batch).
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
