/**
 * The deployment build a failed run is reactivated on (COR-1582). Retrying a failed run binds work
 * to its worker binding's build again, and a removal's scan does not see it, because a failed run
 * is terminal. So the reactivation commit is a binding like a start: the build must not be removed,
 * its tombstone must stay absent, and its stamp moves with the run. A run whose build is removed is
 * left failed and reported as `version-removed`.
 *
 * @module core/engine/bulk-retry-build-binding
 */

import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { workerBuildBinding, type WorkerBuildIdentity } from '../../worker/deployment-records.ts';
import {
  assertInheritedWorkerBuildNotRemoved,
  throwIfWorkerBuildRemoved,
} from '../../worker/inherited-worker-build.ts';
import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';

/**
 * A reactivation commit with the run's build bound to it: after failing fast if the build is
 * removed, the tombstone condition and the stamp put join the commit's own, and `binding.build`
 * names the build for attributing a loss.
 */
export async function bindReactivation<
  T extends { operations: BatchOperation[]; conditions: ConditionalBatchCondition[] },
>(
  internals: EngineInternals,
  state: WorkflowState,
  commit: T,
): Promise<T & { binding: { build: WorkerBuildIdentity | undefined } }> {
  const build = state.workerBinding?.current;
  if (build === undefined) return { ...commit, binding: { build } };
  await assertInheritedWorkerBuildNotRemoved(internals.storage, build);
  const { condition, operation } = workerBuildBinding(build, state.id);
  return {
    ...commit,
    operations: [...commit.operations, operation],
    conditions: [...commit.conditions, condition],
    binding: { build },
  };
}

/** After a reactivation commit that did not land: say so if the build was removed under it. */
export async function throwIfReactivationLostToRemoval(
  internals: EngineInternals,
  binding: { build: WorkerBuildIdentity | undefined },
): Promise<void> {
  if (binding.build !== undefined)
    await throwIfWorkerBuildRemoved(internals.storage, binding.build);
}
