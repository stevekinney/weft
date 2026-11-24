import type { ContextOperationRequest } from '../context.ts';
import type { BranchDriver } from '../context/branch-driver.ts';
import { runAdvancingBranches, type AdvancingResult } from './advancing-branches.ts';
import type { MidOperationCommitReport } from './checkpoint-io.ts';
import { stageCoordinatorCompletion } from './file-workflow-completion-events.ts';
import type { EngineInternals } from './internals.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import { valuesFromSlots } from './parallel-dispatch.ts';
import { canPersistPartialEntry, writePartialEntry } from './partial-entry.ts';
import { takeSettledSteps } from './settled-step-sink.ts';
import { isCurrentOperation, workflowExecutionTokenForWorkflow } from './strategy-helpers.ts';
import { parallelTimelineDetails, recordTimelineBranches } from './timeline-coordinator-detail.ts';

type ParallelOperation = Extract<ContextOperationRequest, { type: 'parallel' }>;

export type AdvancingParallelCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  executeSubOperation: (
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  persistCheckpoint?: (
    workflowId: string,
    operation: ContextOperationRequest,
    report?: MidOperationCommitReport,
  ) => Promise<void>;
};

/** Record on the operation's timeline entry the last operation each branch asked for. */
function recordBranchTimeline(
  internals: EngineInternals,
  workflowId: string,
  result: AdvancingResult,
): void {
  const requests = result.lastRequests.flatMap((request, index) =>
    request === undefined ? [] : [{ request, slot: result.slots[index]! }],
  );
  recordTimelineBranches(
    internals,
    workflowId,
    parallelTimelineDetails(
      requests.map(({ request }) => request),
      requests.map(({ slot }) => slot),
    ),
  );
}

/**
 * An advancing parallel step (a document `parallel`): each branch moves on as soon as its own
 * operation settles, and every settled step commits while a sibling is still running. Whatever a
 * step reports, a commit that comes later or the commit that settles this operation makes durable.
 */
export async function processAdvancingParallelOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ParallelOperation,
  drivers: readonly BranchDriver[],
  callbacks: AdvancingParallelCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const workflowExecutionToken = workflowExecutionTokenForWorkflow(internals, workflowId);
    const persistCheckpoint = callbacks.persistCheckpoint;
    const durable =
      persistCheckpoint !== undefined && canPersistPartialEntry(internals, workflowId);
    const result = await runAdvancingBranches({
      internals,
      workflowId,
      operation,
      drivers,
      execute: (request, signal) => callbacks.executeSubOperation(workflowId, request, signal),
      isCurrent: () =>
        isCurrentOperation(internals, workflowId, operation.operationId, workflowExecutionToken),
      ...(durable
        ? {
            commit: async (committing, entry, report) => {
              writePartialEntry(internals, workflowId, operation.step, entry);
              await persistCheckpoint(workflowId, committing, report);
            },
          }
        : {}),
    });
    // What the steps settled since the last commit completed is reported by the commit that settles
    // this operation, which finds it staged on the operation's pending timeline entry. Taken
    // before anything below can throw, so a failed step leaves nothing behind for the next one.
    const settled = takeSettledSteps(internals, workflowId);
    if (result.fatal !== undefined) throw result.fatal.error;
    if (result.commitFailure !== undefined) throw result.commitFailure.error;
    writePartialEntry(internals, workflowId, operation.step, result.entry);
    recordBranchTimeline(internals, workflowId, result);
    const pendingEntry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
    if (pendingEntry !== undefined) stageCoordinatorCompletion(pendingEntry, settled);
    if (result.hasFirstError) throw result.firstError;
    return valuesFromSlots(result.slots);
  });
}
