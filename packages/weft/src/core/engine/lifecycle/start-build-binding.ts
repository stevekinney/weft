/**
 * The deployment build a start binds its run to (COR-1582). A start's create batch requires the
 * build's removal tombstone to be absent, under its own tag, and puts a fresh binding stamp for
 * the build, so a run is never committed against a removed build and a removal that read the stamp
 * earlier cannot commit past it. Every caller of `buildAndCommitStartBatch` gets both from the
 * state it commits: the build is the one in `state.workerBinding.current`, which covers a fresh
 * start, a restart, a child, a scheduled occurrence, and `prepare()`.
 *
 * @module core/engine/lifecycle/start-build-binding
 */

import { type BatchOperation, type Storage } from "../../../embedded/storage/src/index.ts";
import { workerBuildBinding } from '../../../worker/deployment-records.ts';
import { throwIfWorkerBuildRemoved } from '../../../worker/inherited-worker-build.ts';
import type { WorkflowState } from '../../types.ts';
import type { TaggedStartCondition } from './start-condition-tags.ts';

/** The tombstone condition and the stamp put for the build `state` binds to; both `undefined` for a start with no binding. */
export function workerBuildStartBinding(state: WorkflowState): {
  condition: TaggedStartCondition | undefined;
  operations: BatchOperation[] | undefined;
} {
  const binding = state.workerBinding?.current;
  if (binding === undefined) return { condition: undefined, operations: undefined };
  const { condition, operation } = workerBuildBinding(binding, state.id);
  return {
    condition: { source: 'worker-build-tombstone', condition },
    operations: [operation],
  };
}

/**
 * Answer a start commit that missed, when the build it binds to has been removed: the start fails
 * as such and binds nothing. Positive evidence only (the tombstone is present); a commit that lost
 * for any other reason falls through to the attribution that names it.
 */
export async function throwIfStartLostToRemoval(
  storage: Storage,
  state: WorkflowState,
): Promise<void> {
  const binding = state.workerBinding?.current;
  if (binding !== undefined) await throwIfWorkerBuildRemoved(storage, binding);
}
