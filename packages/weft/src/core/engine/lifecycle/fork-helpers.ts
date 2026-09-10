import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { buildIndexOperations } from '../../search-attributes.ts';
import type { Checkpoint, ForkLineage, SearchAttributeValue, WorkflowState } from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import type { EngineInternals } from '../internals.ts';
import { encodeWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowVisibilityIndexOperations } from '../workflow-indexes.ts';
import { EMPTY_STORAGE_VALUE, FORK_LINEAGE_ATTRIBUTE, type LifecycleCallbacks } from './shared.ts';

export function createForkLineage(
  _internals: EngineInternals,
  sourceWorkflowId: string,
  checkpoint: Checkpoint,
  _callbacks: LifecycleCallbacks,
): ForkLineage {
  return {
    workflowId: sourceWorkflowId,
    step: checkpoint.step,
  };
}

export function buildForkSearchAttributes(
  _internals: EngineInternals,
  checkpoint: Checkpoint,
  lineage: ForkLineage,
  _callbacks: LifecycleCallbacks,
): Record<string, SearchAttributeValue> {
  return {
    ...checkpoint.searchAttributes,
    [FORK_LINEAGE_ATTRIBUTE]: lineage.workflowId,
  };
}

export function createForkedWorkflowState(
  _internals: EngineInternals,
  workflowId: string,
  sourceState: WorkflowState,
  versionTuple: WorkflowVersionTuple,
  lineage: ForkLineage,
  forkedAt: number,
  _callbacks: LifecycleCallbacks,
  /**
   * `fork()`'s own resolver-returned revision — used to fill in the fork's
   * persisted `revision` ONLY when `sourceState.revision` is itself
   * `undefined` (WFT-19 review round 6, Codex, P1). Never overrides an
   * already-defined `sourceState.revision`: `resolveExecutableRegistrationForRevision()`
   * ALWAYS returns `revision: undefined` for an eager registration (eager
   * has no ambiguity to resolve against — see `canResolveRevisionLocally`'s
   * doc), even though the eager source run's own `sourceState.revision` is
   * a real, independently-meaningful value (`resolveCachedStartRevision()`'s
   * `registeredCatalogRevisions` fallback stamps it at ordinary start time,
   * for every registration kind). Blindly preferring `resolvedRevision`
   * here would have dropped that real value for every eager-type fork —
   * caught by `tests/replay-fixtures/fork-from-checkpoint.json`'s golden
   * byte comparison. For a legacy (pre-revision-pinning) source run on a
   * dynamic-source type with exactly one registered candidate,
   * `sourceState.revision` genuinely IS `undefined` even though the
   * resolver resolved — and the fork launches against — that sole
   * candidate's code; `sourceState.revision ?? resolvedRevision` falls
   * through to the resolver's answer only in that case. Stamping the fork's
   * persisted `revision` with the raw `undefined` legacy pin (as this
   * function did before this fix existed) left the fork durably unpinned:
   * it would run correctly until the next restart, but a fresh-process
   * `recoverAll()` after a second candidate is later registered would
   * classify the fork `legacy-ambiguous` and refuse to resume it, even
   * though the fork's own resolver already knew exactly which revision it
   * belonged to at creation time. Mirrors the identical fix already applied
   * to the process-local identity cache in `checkpoint-launch.ts`'s
   * `launchWorkflowFromCheckpoint()` (WFT-19 review round 5) — that fix
   * closed the in-memory gap; this one closes the matching durable-state
   * gap the same bug left behind, for the one case it actually applies to.
   */
  resolvedRevision: string | undefined,
): WorkflowState {
  const forkRevision = sourceState.revision ?? resolvedRevision;
  return {
    id: workflowId,
    type: sourceState.type,
    status: 'running',
    input: sourceState.input,
    workflowExecutionToken: crypto.randomUUID(),
    versionTuple,
    ...(forkRevision !== undefined && { revision: forkRevision }),
    executionStateOwnerId: workflowId,
    createdAt: forkedAt,
    startedAt: forkedAt,
    updatedAt: forkedAt,
    forkedFrom: lineage,
  };
}

export function buildForkBatchOperations(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  serializedCheckpoint: Uint8Array,
  workflowStartHeaders: Map<string, string> | undefined,
  _callbacks: LifecycleCallbacks,
): BatchOperation[] {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
    {
      type: 'put',
      key: KEYS.checkpoint(workflowId),
      value: serializedCheckpoint,
    },
    ...buildWorkflowVisibilityIndexOperations(workflowId, null, state).batchOps,
  ];

  if (Object.keys(checkpoint.searchAttributes).length > 0) {
    operations.push(
      {
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(checkpoint.searchAttributes),
      },
      ...buildIndexOperations(workflowId, {}, checkpoint.searchAttributes),
    );
  }

  if (workflowStartHeaders && workflowStartHeaders.size > 0) {
    operations.push(
      {
        type: 'put',
        key: KEYS.workflowHeaders(workflowId),
        value: encodeWorkflowStartHeaders(workflowStartHeaders),
      },
      {
        type: 'put',
        key: KEYS.terminalCleanupNeeded(workflowId),
        value: EMPTY_STORAGE_VALUE,
      },
    );
  }

  return operations;
}
