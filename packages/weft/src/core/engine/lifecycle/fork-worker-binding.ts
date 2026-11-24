/**
 * The worker build a fork inherits from its source: binding it to the fork, and the read-only check
 * that the build is still installed, which `previewFork` makes too.
 *
 * @module core/engine/lifecycle/fork-worker-binding
 */
import { inheritWorkflowWorkerBinding } from '../../../worker/binding-helpers.ts';
import {
  assertInheritedWorkerBuildNotRemoved,
  throwIfWorkerBuildRemoved,
} from '../../../worker/inherited-worker-build.ts';
import type { WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';

export function applyForkWorkerBindingInheritance(
  state: WorkflowState,
  sourceState: WorkflowState,
  options: Readonly<{
    persistedRevision: string | undefined;
    forkedAt: number;
    checkpointId: string;
  }>,
): void {
  if (sourceState.workerBinding === undefined || sourceState.workerVersioningPolicy === undefined) {
    return;
  }
  const currentBinding = sourceState.workerBinding.current;
  if (
    options.persistedRevision !== undefined &&
    options.persistedRevision !== currentBinding.workflowRevision
  ) {
    return;
  }
  state.workerVersioningPolicy = sourceState.workerVersioningPolicy;
  state.workerBinding = {
    current: inheritWorkflowWorkerBinding(currentBinding, {
      workflowId: state.id,
      boundAt: options.forkedAt,
      checkpointId: options.checkpointId,
    }),
    history: sourceState.workerBinding.history,
  };
}

/**
 * {@link applyForkWorkerBindingInheritance}, after checking the build the fork would inherit. A
 * terminal source's binding is not counted by a build's removal, so a build removed since the
 * source ran is refused here rather than bound to a new run.
 */
export async function inheritForkWorkerBinding(
  internals: EngineInternals,
  state: WorkflowState,
  sourceState: WorkflowState,
  options: Parameters<typeof applyForkWorkerBindingInheritance>[2],
): Promise<void> {
  await assertForkInheritedBuildNotRemoved(internals, sourceState, options.persistedRevision);
  applyForkWorkerBindingInheritance(state, sourceState, options);
}

/**
 * The read-only half of {@link inheritForkWorkerBinding}: throws the
 * `WorkerDeploymentVersionRemovedError` a fork inheriting `sourceState`'s build would, and writes
 * nothing, so `previewFork` refuses exactly what `fork()` refuses.
 */
export async function assertForkInheritedBuildNotRemoved(
  internals: EngineInternals,
  sourceState: WorkflowState,
  persistedRevision: string | undefined,
): Promise<void> {
  const inherited = sourceState.workerBinding?.current;
  if (
    inherited !== undefined &&
    sourceState.workerVersioningPolicy !== undefined &&
    (persistedRevision === undefined || persistedRevision === inherited.workflowRevision)
  ) {
    await assertInheritedWorkerBuildNotRemoved(internals.storage, inherited);
    // A removal puts its tombstone before it marks the version, and the fork's commit refuses on
    // the tombstone alone, so the preview reads it too rather than promise a fork that commit
    // would refuse.
    await throwIfWorkerBuildRemoved(internals.storage, inherited);
  }
}
