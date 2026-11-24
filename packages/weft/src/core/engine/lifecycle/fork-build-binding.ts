/**
 * The fork's commit, bound to the deployment build it inherits (COR-1582) and, under
 * `ownership: 'workflow-lease'`, to the fork id's own claim (COR-2635).
 *
 * A fork copies its source's worker binding, and a finished source is not work a removal's scan
 * counts, so the commit requires the build's removal tombstone to be absent and puts a fresh
 * binding stamp for the build, in the same batch as the run. A commit that loses to the tombstone
 * is told so: the tombstone is re-read before the loss is blamed on the revision catalog.
 *
 * A fork creates a workflow id nothing has ever claimed. Under `workflow-lease` its create batch
 * therefore folds the claim's `acquire` into the same atomic batch, as `start()` does (ADR 0002's
 * claim-acquiring entry points; `workflow-claim-fold.ts`): the acquire's own conditions (holder
 * absent, epoch as just read) are this first write's fence, and the claim is recorded only once
 * the batch has committed. Fencing it through `commitFencedEngineWrite` instead looks up an epoch
 * the registry cannot have and fails closed before any write, which is how every fork under
 * `workflow-lease` used to end in `EngineDeposedError`. Under `none` and `lease` (and a
 * `workflow-lease` engine with no registry) there is no fold, and the commit is fenced as before.
 *
 * @module core/engine/lifecycle/fork-build-binding
 */

import type { BatchOperation, ConditionalBatchCondition } from "../../../embedded/storage/src/index.ts";
import { workerBuildBinding } from '../../../worker/deployment-records.ts';
import { throwIfWorkerBuildRemoved } from '../../../worker/inherited-worker-build.ts';
import type { WorkflowState } from '../../types.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';
import { isInlineWorkflowExecutionLive } from '../local-execution.ts';
import {
  commitWithWorkflowClaimFold,
  prepareWorkflowClaimFold,
  throwWorkflowClaimUnavailable,
} from '../workflow-claim-fold.ts';
import { releaseFreshlyAcquiredResumeClaim } from './standalone-claim-acquire.ts';

export async function commitForkWrite(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  catalogConditions: ConditionalBatchCondition[],
  forkState: WorkflowState,
  onLostRace: () => Error,
): Promise<void> {
  const binding = forkState.workerBinding?.current;
  if (binding === undefined) {
    return commitForkBatch(internals, workflowId, operations, catalogConditions, onLostRace);
  }
  const { condition, operation } = workerBuildBinding(binding, forkState.id);
  let lostRace = false;
  try {
    await commitForkBatch(
      internals,
      workflowId,
      [...operations, operation],
      [...catalogConditions, condition],
      () => {
        lostRace = true;
        return onLostRace();
      },
    );
  } catch (error) {
    // Anything but a lost race (a deposed engine, a lost claim, a storage failure) is not about
    // the build.
    if (lostRace) await throwIfWorkerBuildRemoved(internals.storage, binding);
    throw error;
  }
}

/**
 * Commit the fork's create batch with the fork id's claim folded in when `workflow-lease` applies,
 * else fenced as every other engine write is. A lost fold reports the claim
 * (`WorkflowClaimUnavailableError`) when the fold's own conditions lost, and `onLostRace()` when
 * one of the caller's did; the fork's id is fresh, so a lost claim means some other writer took it
 * between the fold's read and this commit, and nothing of the fork is written.
 */
async function commitForkBatch(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  onLostRace: () => Error,
): Promise<void> {
  const claimFold = await prepareWorkflowClaimFold(internals, workflowId);
  if (claimFold === undefined) {
    return commitFencedEngineWrite(internals, workflowId, operations, conditions, onLostRace);
  }
  const result = await commitWithWorkflowClaimFold(
    internals,
    claimFold,
    operations,
    conditions,
    'fork claim acquisition',
  );
  if (result.status === 'committed') return;
  if (result.claimConflict) await throwWorkflowClaimUnavailable(internals, workflowId);
  throw onLostRace();
}

/**
 * The fork committed but did not launch: give back the claim its create batch folded, unless the
 * run is already executing here. Nothing drives the run otherwise, and this engine's renewal would
 * keep the claim alive and the run out of every reclaim scan; released, the run is `running` with
 * no holder, which the next reclaim pass acquires and drives, on this engine or another. Released
 * by the exact epoch held, best-effort, as every claim release on a failure path is. A no-op when
 * nothing was claimed (the commit never landed, or the engine is not under `workflow-lease`).
 */
export async function releaseUnlaunchedForkClaim(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  const claimEpoch = internals.workflowClaimRegistry?.currentEpoch(workflowId) ?? null;
  if (claimEpoch === null || isInlineWorkflowExecutionLive(internals, workflowId)) return;
  await releaseFreshlyAcquiredResumeClaim(internals, workflowId, claimEpoch);
}
