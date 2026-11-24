/**
 * `engine.previewFork` (COR-2536): what forking a run would do, answered from the same reads and
 * checks `fork()` makes before it writes, and then nothing. A fork that would be refused (an unknown
 * run or step, a revision that is not installed, a version-incompatible revision) is refused here with
 * the same error, so the preview never promises a fork that `fork()` would not make.
 *
 * @module core/engine/lifecycle/fork-preview
 */
import type { ForkOptions, ForkPreview } from '../../types.ts';
import { resolveExecutableRegistrationOrRenamedNotFound } from '../dynamic-source-execution.ts';
import { getEffectiveTimeline } from '../fork-effective-timeline.ts';
import { splitStepsAtForkPoint } from '../fork-timeline-alignment.ts';
import type { EngineInternals } from '../internals.ts';
import { normalizeForkStep } from '../state-utilities.ts';
import { loadWorkflowState } from '../storage-io.ts';
import {
  loadForkSourceCheckpoint,
  resolveForkPersistedRevision,
  resolveForkTargetRevision,
} from './fork-helpers.ts';
import { assertForkSourceCheckpointMatchesState } from './fork-source-replacement-guards.ts';
import { assertForkInheritedBuildNotRemoved } from './fork-worker-binding.ts';
import { derivePreparedExecutionState } from './persist.ts';
import type { LifecycleCallbacks } from './shared.ts';

export async function previewFork(
  internals: EngineInternals,
  sourceWorkflowId: string,
  callerOptions: ForkOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<ForkPreview> {
  // The caller owns the options object and this function awaits: read it once, before the first await.
  const options: ForkOptions | undefined =
    callerOptions === undefined ? undefined : { ...callerOptions };
  const sourceState = await loadWorkflowState(internals, sourceWorkflowId);
  if (!sourceState) {
    throw new Error(`Workflow "${sourceWorkflowId}" not found`);
  }

  const targetRevision = resolveForkTargetRevision(internals, sourceState, options);
  const { entry: registration, revision: resolvedRevision } =
    await resolveExecutableRegistrationOrRenamedNotFound(
      (type) => callbacks.resolveExecutableRegistrationForRevision(type, targetRevision),
      sourceState.type,
      () =>
        new Error(
          `No workflow registered with name "${sourceState.type}" (needed to fork "${sourceWorkflowId}")`,
        ),
    );
  const forkRevision = resolveForkPersistedRevision(options, sourceState, resolvedRevision);
  // Throws the removed-build refusal a fork inheriting the source's worker build would.
  await assertForkInheritedBuildNotRemoved(internals, sourceState, forkRevision);

  const fromStep =
    options?.fromStep !== undefined ? normalizeForkStep(options.fromStep) : undefined;
  const sourceCheckpoint = await loadForkSourceCheckpoint(internals, sourceWorkflowId, fromStep);
  assertForkSourceCheckpointMatchesState(sourceWorkflowId, sourceState, sourceCheckpoint);
  // Throws the version mismatch a fork onto an incompatible revision would.
  derivePreparedExecutionState(
    internals,
    sourceWorkflowId,
    sourceState,
    sourceCheckpoint,
    registration,
    callbacks,
  );

  const { keptSteps, rerunSteps } = splitStepsAtForkPoint(
    await getEffectiveTimeline(internals, sourceWorkflowId),
    sourceCheckpoint.step,
  );
  return {
    dryRun: true,
    workflowId: sourceWorkflowId,
    forkPoint: sourceCheckpoint.step,
    keptSteps,
    rerunSteps,
    // Only an explicit `revision` that differs from the source's pin moves the fork to other code.
    // A source recorded before revisions were pinned has no pin to differ from: the fork takes the
    // revision it resolves and runs the code the source would.
    revisionWouldChange:
      sourceState.revision !== undefined &&
      forkRevision !== undefined &&
      forkRevision !== sourceState.revision,
    ...(sourceState.revision === undefined ? {} : { sourceRevision: sourceState.revision }),
    ...(forkRevision === undefined ? {} : { forkRevision }),
  };
}
