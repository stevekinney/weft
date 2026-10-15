/**
 * Which engine committed the terminal outcome a workflow handle's `result()`
 * settled with, so `Engine.lostWorkflowClaim(handle)` can tell an outcome this
 * engine published from one another engine did under `ownership:
 * 'workflow-lease'`.
 *
 * The committer is recorded per result promise, not per workflow id, so a later
 * run reusing the id (a `start-new` replacement) never changes the answer for
 * the run a handle was awaiting. A settle this engine drove records its own id;
 * a settle read back from the store records the `terminalCommittedBy` the
 * terminal write stamped. Every record is a synchronous `WeakMap` write made
 * immediately before the waiter settles, so it adds no await to a terminal path.
 *
 * @module core/engine/result-committer
 */
import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { HANDLE_RESULT_SETTLEMENT, type WorkflowClaimHandle } from './handles.ts';

const committerByResultPromise = new WeakMap<Promise<unknown>, string>();

/** Record `committedBy` for `waiter`'s result, unless it already has one. A no-op for `undefined`. */
export function recordResultCommitter(
  waiter: WorkflowResultWaiter,
  committedBy: string | undefined,
): void {
  if (committedBy === undefined || committerByResultPromise.has(waiter.promise)) return;
  committerByResultPromise.set(waiter.promise, committedBy);
}

/** Carry the committer recorded for `from`'s result over to `to`, which settles with the same outcome. */
export function copyResultCommitter(from: WorkflowResultWaiter, to: WorkflowResultWaiter): void {
  recordResultCommitter(to, committerByResultPromise.get(from.promise));
}

/**
 * The engine that committed the outcome `handle`'s result settled with, or
 * `undefined` while that result is unsettled, was never requested, or carries no
 * recorded committer.
 */
export function readHandleResultCommitter(handle: WorkflowClaimHandle): string | undefined {
  const settlement = (
    handle as { readonly [HANDLE_RESULT_SETTLEMENT]?: () => Promise<unknown> | undefined }
  )[HANDLE_RESULT_SETTLEMENT]?.();
  return settlement === undefined ? undefined : committerByResultPromise.get(settlement);
}
