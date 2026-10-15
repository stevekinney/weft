/**
 * Apply a serialized workflow-state update, conditioned on the record and run it decided from.
 * See {@link updateWorkflowState}.
 *
 * @module core/engine/workflow-state-update
 */
import { sleep } from '../../runtime/portable.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { retryDelay } from '../atomic-state.ts';
import { encode } from '../codec.ts';
import type { WorkflowState, WorkflowStatus } from '../types.ts';
import { buildTerminalWorkflowIndexOperations } from './attributes-tags.ts';
import type { EngineInternals } from './internals.ts';
import {
  commitExternalTerminalWorkflowStateOperations,
  commitSelfWorkflowStateOperations,
  runSerializedWorkflowStateWrite,
} from './storage-io.ts';
import {
  bytesEqual,
  captureOrReadTerminalFence,
  FENCED_RETRY_BUDGET,
  sameRunCondition,
  type TerminalFence,
} from './termination/terminal-fence.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';
import {
  refreshWorkflowVisibilityMaintenance,
  visibilityIndexOperations,
} from './workflow-visibility-maintenance.ts';

/**
 * `updateWorkflowState`'s two callers commit very different transitions per
 * ADR 0002: `failWorkflow` is a SELF-transition (this engine finishing its
 * own workflow) while `terminateWorkflow` (cancel/timeout) is an EXTERNAL
 * terminal transition (any engine may commit it, and it rotates the claim
 * epoch under `ownership: 'workflow-lease'`). `category` is a REQUIRED
 * positional parameter rather than an optional options field so a caller
 * cannot silently default into the wrong fencing shape.
 */
export type WorkflowStateTransitionCategory = 'self' | 'external-terminal';

export type WorkflowStateUpdateOptions = {
  allowedStatuses?: readonly WorkflowStatus[];
  buildAdditionalOperations?: (previousState: WorkflowState, updatedAt: number) => BatchOperation[];
  /** Checked with the decoded state after the last read before the commit; `true` skips the write. */
  skipCommitIf?: (state: WorkflowState) => boolean;
};

export type WorkflowStateUpdateResult = {
  previousState: WorkflowState;
  updatedAt: number;
  /** Durable identity of this commit; see {@link TerminalFence}. */
  fence: TerminalFence;
};

/**
 * Whether this update must not be written: the record now belongs to another run than the one the
 * first attempt decided on, the status guard refuses it, or the caller's `skipCommitIf` does.
 */
function updateIsRefused(
  state: WorkflowState,
  options: WorkflowStateUpdateOptions,
  decided: { workflowExecutionToken: string | undefined } | undefined,
): boolean {
  if (decided !== undefined && state.workflowExecutionToken !== decided.workflowExecutionToken) {
    return true;
  }
  if (options.allowedStatuses && !options.allowedStatuses.includes(state.status)) return true;
  return options.skipCommitIf?.(state) === true;
}

/**
 * What to do after a conditional commit was refused.
 *
 * - `'refused'`: the record now says the update must not be written (the run completed, turned
 *   terminal or was replaced), so the update is a no-op. This is checked first, even on the last
 *   attempt, so a run that finished meanwhile is never reported as a failure or overwritten.
 * - `'retry'`: only the record's bytes changed (a tag edit, say); back off with jitter, as
 *   `AtomicState` does, and decide again.
 * - Otherwise the failure is real, or the retry budget is spent, and the original error is thrown
 *   so the caller sees it. Both conditions stay on every attempt: relaxing them on the last one
 *   would let a completion that lands in between be overwritten.
 */
async function settleLostDecision(
  internals: EngineInternals,
  workflowId: string,
  loadedBytes: Uint8Array,
  attempt: number,
  error: unknown,
  options: WorkflowStateUpdateOptions,
  decided: StateUpdateDecision,
): Promise<'retry' | 'refused'> {
  const current = await internals.storage.get(KEYS.workflow(workflowId));
  if (current === null) return 'refused';
  if (bytesEqual(current, loadedBytes)) throw error;
  if (updateIsRefused(decodeWorkflowState(current), options, decided)) return 'refused';
  if (attempt + 1 >= FENCED_RETRY_BUDGET) throw error;
  await sleep(retryDelay(attempt));
  return 'retry';
}

/** What the first attempt of a state update decided, kept for any re-decision after a lost commit. */
type StateUpdateDecision = {
  /** The run the caller meant: a reload that finds another generation is a replacement. */
  workflowExecutionToken: string | undefined;
  /** Captured once, before the first commit, so a retry never reads a replacement's identity. */
  fence: TerminalFence;
};

/**
 * Apply a serialized workflow-state update and return the previous state metadata.
 *
 * The commit is conditioned on the exact `KEYS.workflow(id)` bytes the decision was made from and
 * on the run's generation. If either changed, the update reloads and decides again: a run that
 * has meanwhile completed, been replaced or turned terminal makes it a no-op, which is what stops
 * a remote cancel from overwriting a finished run or touching its replacement.
 */
export async function updateWorkflowState(
  internals: EngineInternals,
  workflowId: string,
  updates: Partial<WorkflowState>,
  category: WorkflowStateTransitionCategory,
  options: WorkflowStateUpdateOptions = {},
): Promise<WorkflowStateUpdateResult | null> {
  return await runSerializedWorkflowStateWrite(internals, workflowId, () =>
    attemptWorkflowStateUpdate(internals, workflowId, updates, category, options, undefined, 0),
  );
}

async function attemptWorkflowStateUpdate(
  internals: EngineInternals,
  workflowId: string,
  updates: Partial<WorkflowState>,
  category: WorkflowStateTransitionCategory,
  options: WorkflowStateUpdateOptions,
  decided: StateUpdateDecision | undefined,
  attempt: number,
): Promise<WorkflowStateUpdateResult | null> {
  const bytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!bytes) {
    return null;
  }

  const state = decodeWorkflowState(bytes);
  if (updateIsRefused(state, options, decided)) {
    return null;
  }

  const updatedAt = internals.options.getNow();
  const updated = {
    ...state,
    ...updates,
    updatedAt,
  };
  const additionalOperations = additionalOperationsFor(options, state, updatedAt);

  // `updateWorkflowState` applies an engine-generator-owned workflow STATUS
  // transition, always fenced — a deposed engine cannot write terminal
  // state over a successor's run. WHICH fence depends on `category`: a
  // SELF-transition (failWorkflow) fences on this engine's own claim; an
  // EXTERNAL terminal transition (terminateWorkflow: cancel/timeout)
  // rotates the claim epoch instead (ADR 0002). Operator tag/attribute
  // mutations do NOT use this helper; they batch directly.
  const pendingFence = fenceBeforeCommit(internals, workflowId, state, decided);
  // Only a run this engine does not hold, or one whose adoption read is in flight, costs an await.
  const fence = pendingFence instanceof Promise ? await pendingFence : pendingFence;
  const commit = commitFor(category);
  const visibilityMaintenance = refreshWorkflowVisibilityMaintenance(internals);
  if (visibilityMaintenance !== undefined) await visibilityMaintenance;
  try {
    await commit(
      internals,
      state,
      [
        ...buildTerminalWorkflowIndexOperations(state, updated),
        { type: 'put', key: KEYS.workflow(workflowId), value: encode(updated) },
        ...visibilityIndexOperations(internals, state, updated),
        ...additionalOperations,
      ],
      {
        includePendingAtomicSideEffects: isTerminalWorkflowStatus(updated.status),
        extraConditions: decisionConditions(workflowId, bytes, fence),
      },
    );
  } catch (error) {
    const keep = { workflowExecutionToken: state.workflowExecutionToken, fence };
    const next = await settleLostDecision(
      internals,
      workflowId,
      bytes,
      attempt,
      error,
      options,
      keep,
    );
    if (next === 'refused') return null;
    return attemptWorkflowStateUpdate(
      internals,
      workflowId,
      updates,
      category,
      options,
      keep,
      attempt + 1,
    );
  }

  return {
    previousState: state,
    updatedAt,
    fence,
  };
}

/** The caller's extra operations for this update, if it supplies any. */
function additionalOperationsFor(
  options: WorkflowStateUpdateOptions,
  state: WorkflowState,
  updatedAt: number,
): BatchOperation[] {
  return options.buildAdditionalOperations?.(state, updatedAt) ?? [];
}

/** Which commit shape a category uses (ADR 0002); see {@link WorkflowStateTransitionCategory}. */
function commitFor(category: WorkflowStateTransitionCategory) {
  return category === 'self'
    ? commitSelfWorkflowStateOperations
    : commitExternalTerminalWorkflowStateOperations;
}

/**
 * The fence for this attempt: the first attempt's, kept across retries, or one captured now. A
 * plain function, so a held run whose identity is known adds no await and no tick.
 */
function fenceBeforeCommit(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  decided: StateUpdateDecision | undefined,
): TerminalFence | Promise<TerminalFence> {
  return (
    decided?.fence ??
    captureOrReadTerminalFence(internals, workflowId, state.workflowExecutionToken)
  );
}

/** The commit preconditions that tie a decision to the record and the run it was made from. */
function decisionConditions(
  workflowId: string,
  loadedBytes: Uint8Array,
  fence: TerminalFence,
): ConditionalBatchCondition[] {
  const conditions: ConditionalBatchCondition[] = [
    { key: KEYS.workflow(workflowId), expectedValue: loadedBytes },
  ];
  if (fence.identity !== undefined) conditions.push(sameRunCondition(workflowId, fence.identity));
  return conditions;
}
