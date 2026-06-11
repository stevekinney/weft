import type { Checkpoint, WorkflowState } from '../../types.ts';
import { VersionMismatchError, checkVersionCompatibility } from '../../versioning.ts';
import {
  diffWorkflowVersionTuples,
  type WorkflowVersionDiff,
  type WorkflowVersionTuple,
} from '../../workflow-version-tuple.ts';
import type { EngineInternals } from '../internals.ts';
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
  const compatibility = checkVersionCompatibility(checkpoint.version, registration.version);
  const registeredVersionTuple = createWorkflowVersionTuple(internals, registration, callbacks);
  const versionDiff = diffWorkflowVersionTuples(
    workflowVersionTupleFromState(internals, state, callbacks),
    registeredVersionTuple,
  );
  const hasVersionTupleDrift =
    versionDiff.workflowVersion !== undefined ||
    versionDiff.agentVersion !== undefined ||
    versionDiff.toolVersions !== undefined;

  if (compatibility === 'incompatible' || hasVersionTupleDrift) {
    throwVersionMismatch(internals, workflowId, state, registration, versionDiff, callbacks);
  }

  return {
    state,
    checkpoint,
    versionTuple: registeredVersionTuple,
    shouldPersistPreparedState: false,
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

  return {
    state: preparedExecutionState.state,
    checkpoint: preparedExecutionState.checkpoint,
    serializedCheckpoint: checkpointBytes,
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
