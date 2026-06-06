import { serializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import type { Checkpoint, WorkflowState } from '../../types.ts';
import {
  VersionMismatchError,
  buildVersionUpdateOperations,
  checkVersionCompatibility,
  migrateCheckpoint,
} from '../../versioning.ts';
import {
  diffWorkflowVersionTuples,
  type WorkflowVersionDiff,
  type WorkflowVersionTuple,
} from '../../workflow-version-tuple.ts';
import type { EngineInternals } from '../internals.ts';
import { buildWorkflowVisibilityIndexTransition } from '../workflow-indexes.ts';
import { type LifecycleCallbacks, type RegistrationEntry } from './shared.ts';

/** Build a {@link WorkflowVersionTuple} from a {@link RegistrationEntry}. */
export function createWorkflowVersionTuple(
  _internals: EngineInternals,
  registration: RegistrationEntry,
  _callbacks: LifecycleCallbacks,
): WorkflowVersionTuple {
  return {
    workflowVersion: registration.version,
  };
}

export function workflowVersionTupleFromState(
  _internals: EngineInternals,
  state: WorkflowState,
  _callbacks: LifecycleCallbacks,
): WorkflowVersionTuple {
  return state.versionTuple;
}

export function workflowStateWithVersionTuple(
  internals: EngineInternals,
  state: WorkflowState,
  versionTuple: WorkflowVersionTuple,
  _callbacks: LifecycleCallbacks,
): WorkflowState {
  return {
    ...state,
    versionTuple,
    updatedAt: internals.options.getNow(),
  };
}

export function derivePreparedExecutionState(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): {
  state: WorkflowState;
  checkpoint: Checkpoint;
  versionTuple: WorkflowVersionTuple;
  shouldPersistPreparedState: boolean;
} {
  const compatibility = checkVersionCompatibility(
    checkpoint.version,
    registration.version,
    !!registration.migrate,
  );
  const registeredVersionTuple = createWorkflowVersionTuple(internals, registration, callbacks);
  const versionDiff = diffWorkflowVersionTuples(
    workflowVersionTupleFromState(internals, state, callbacks),
    registeredVersionTuple,
  );
  const hasVersionTupleDrift =
    versionDiff.workflowVersion !== undefined ||
    versionDiff.agentVersion !== undefined ||
    versionDiff.toolVersions !== undefined;

  if (compatibility === 'incompatible' || (hasVersionTupleDrift && !registration.migrate)) {
    throwVersionMismatch(internals, workflowId, state, registration, versionDiff, callbacks);
  }

  let preparedState = state;
  let preparedCheckpoint = checkpoint;
  let shouldPersistPreparedState = false;

  if ((compatibility === 'needs-migration' || hasVersionTupleDrift) && registration.migrate) {
    const migrated = migrateCheckpoint(
      checkpoint,
      checkpoint.version,
      registration.version,
      registration.migrate,
    ) as Checkpoint;
    migrated.version = registeredVersionTuple.workflowVersion;
    preparedCheckpoint = migrated;
    preparedState = workflowStateWithVersionTuple(
      internals,
      state,
      registeredVersionTuple,
      callbacks,
    );
    shouldPersistPreparedState = true;
  }

  return {
    state: preparedState,
    checkpoint: preparedCheckpoint,
    versionTuple: registeredVersionTuple,
    shouldPersistPreparedState,
  };
}

export async function prepareResumeState(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  checkpointBytes: Uint8Array,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): Promise<{
  state: WorkflowState;
  checkpoint: Checkpoint;
  serializedCheckpoint: Uint8Array;
  versionTuple: WorkflowVersionTuple;
}> {
  const preparedExecutionState = derivePreparedExecutionState(
    internals,
    workflowId,
    state,
    checkpoint,
    registration,
    callbacks,
  );

  if (preparedExecutionState.shouldPersistPreparedState) {
    const versionVisibilityOperations = buildWorkflowVisibilityIndexTransition(
      workflowId,
      state,
      preparedExecutionState.state,
    ).batchOps;
    await internals.storage.batch([
      ...buildVersionUpdateOperations(
        workflowId,
        serializeCheckpoint(preparedExecutionState.checkpoint),
        preparedExecutionState.versionTuple.workflowVersion,
        encode(preparedExecutionState.state),
      ),
      ...versionVisibilityOperations,
    ]);
  }

  return {
    state: preparedExecutionState.state,
    checkpoint: preparedExecutionState.checkpoint,
    serializedCheckpoint: preparedExecutionState.shouldPersistPreparedState
      ? serializeCheckpoint(preparedExecutionState.checkpoint)
      : checkpointBytes,
    versionTuple: preparedExecutionState.versionTuple,
  };
}

/** Throws a {@link VersionMismatchError} with a full version diff. Never returns. */
export function throwVersionMismatch(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  registration: RegistrationEntry,
  versionDiff: WorkflowVersionDiff,
  _callbacks: LifecycleCallbacks,
): never {
  throw new VersionMismatchError(
    workflowId,
    state.type,
    state.versionTuple.workflowVersion,
    registration.version,
    undefined,
    versionDiff,
  );
}
