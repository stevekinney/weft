/**
 * The pending → running commit of a delayed-start fire, split out of `operations-time.ts`'s
 * `startDelayedWorkflow` for that file's size ceiling. It runs as the fire's serialized
 * workflow-state write and returns the running state it committed, or `null` when the run is no
 * longer pending or the folded claim was lost. The claim fold and the launching marker are both
 * here, in the turn the fold commits (COR-1625).
 *
 * @module core/engine/delayed-start-commit
 */
import { type BatchOperation } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { buildTimerBatchOperations } from '../scheduler.ts';
import type { TimerEntry, WorkflowState } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { recordLaunchPending, type PendingLaunch } from './local-execution.ts';
import type { TimeOperationCallbacks } from './time-operation-callbacks.ts';
import { commitWithWorkflowClaimFold, prepareWorkflowClaimFold } from './workflow-claim-fold.ts';
import {
  refreshWorkflowVisibilityMaintenance,
  visibilityIndexOperations,
} from './workflow-visibility-maintenance.ts';

/** The running state a delayed start committed, and the launching marker recorded with it (none on the fenced branch, which holds no claim). */
export type CommittedDelayedStart = { state: WorkflowState; launch: PendingLaunch | undefined };

export async function commitDelayedStartRunning(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'loadWorkflowState'>,
  launch: {
    now: number;
    executionDeadline: number | undefined;
    resolvedRevision: string | undefined;
  },
): Promise<CommittedDelayedStart | null> {
  const { now, executionDeadline, resolvedRevision } = launch;

  const latestState = await callbacks.loadWorkflowState(entry.workflowId);
  if (!latestState || latestState.status !== 'pending') {
    return null;
  }

  // `latestState.revision ?? resolvedRevision` — NEVER the other order.
  // `resolveExecutableRegistrationForRevision()` always returns
  // `revision: undefined` for an eager registration (eager has no
  // ambiguity to resolve against), even when `latestState.revision` is a
  // real, independently-meaningful pin (stamped at ordinary start time
  // for every registration kind). Blindly preferring `resolvedRevision`
  // would silently WIPE that pin on every eager-type delayed-start fire.
  // `resolvedRevision` only fills the gap for the one case it actually
  // applies to: a legacy, pre-revision-pinning pending record on a
  // `registerSource()`-registered type with exactly one registered
  // candidate, where `latestState.revision` is itself `undefined` even
  // though the resolver unambiguously resolved that sole candidate.
  // Mirrors `createForkedWorkflowState()`'s identical fix (WFT-19 review
  // round 6) for the same resolver contract, one launch path over.
  const effectiveRevision = latestState.revision ?? resolvedRevision;
  const nextRunningState: WorkflowState = {
    ...latestState,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    // Conditional spread, not a plain property: `revision` is optional
    // and `exactOptionalPropertyTypes` forbids assigning an explicit
    // `undefined` to it.
    ...(effectiveRevision !== undefined && { revision: effectiveRevision }),
    ...(executionDeadline !== undefined && { executionDeadline }),
  };

  const visibilityMaintenance = refreshWorkflowVisibilityMaintenance(internals);
  if (visibilityMaintenance !== undefined) await visibilityMaintenance;
  const operations: BatchOperation[] = [
    {
      type: 'put',
      key: KEYS.workflow(entry.workflowId),
      value: encode(nextRunningState),
    },
    ...visibilityIndexOperations(internals, latestState, nextRunningState),
  ];
  if (executionDeadline !== undefined) {
    operations.push(
      ...buildTimerBatchOperations({
        id: `deadline:${entry.workflowId}`,
        workflowId: entry.workflowId,
        fireAt: executionDeadline,
        kind: 'execution-deadline',
      }),
    );
  }

  // ADR 0002 row `startDelayedWorkflow` (delayed-start timer fire):
  // claim-acquiring — this is where a delayed-start workflow gets its FIRST
  // owner, since its create batch is intentionally external (no claim held
  // yet; see `lifecycle/start-commit.ts`). Fold `acquire()` into this SAME
  // pending→running batch when `workflow-lease` applies; a lost claim race
  // here is background-scanner territory (this fire is dispatched by the
  // scheduler tick, not an explicit single-workflow caller), so it is
  // reported by returning `null` — never thrown — letting the caller skip
  // this workflow and the scheduler continue its sweep undisturbed.
  const claimFold = await prepareWorkflowClaimFold(internals, entry.workflowId);
  if (claimFold) {
    let marker: PendingLaunch | undefined;
    const result = await commitWithWorkflowClaimFold(
      internals,
      claimFold,
      operations,
      [],
      'delayed-start workflow claim acquisition',
      // Held and launching in the turn the fold is recorded: a reclaim that lists this fire's own
      // claim never sees it held without the marker (COR-1625).
      () => {
        marker = recordLaunchPending(internals, entry.workflowId);
      },
    );
    if (result.status !== 'committed') return null;
    return { state: nextRunningState, launch: marker };
  }

  // Fence the delayed-start pending→running transition on the lease epoch: a
  // deposed timer must not flip a workflow the successor already owns. (Epoch-only
  // is sufficient under lease ownership's single-writer invariant; the existing
  // in-process serialization above handles same-engine ordering.) Also the
  // `ownership: 'none'` path, and the `'workflow-lease'` path while no
  // `WorkflowClaimRegistry` is constructed yet (a parallel construction stage).
  await commitFencedEngineWrite(
    internals,
    entry.workflowId,
    operations,
    [],
    () =>
      new Error(`Delayed-start transition for workflow "${entry.workflowId}" lost its CAS race.`),
  );
  return { state: nextRunningState, launch: undefined };
}
