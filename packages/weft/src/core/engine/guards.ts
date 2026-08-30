import { sleep } from '../../runtime/portable.ts';
import { KEYS } from '../../storage/interface.ts';
import type { WorkflowStatus } from '../types.ts';
import { WorkflowTerminalError, type UpdateResponse } from '../updates.ts';
import type { EngineInternals } from './internals.ts';
import { decodeWorkflowState } from './validation.ts';

/**
 * Coordinated update terminal-race retry configuration.
 *
 * After the workflow reaches a terminal state, an in-flight coordinated
 * update may still be consumed concurrently. We poll for a response
 * before deleting the request, so the consumer wins races where the
 * response arrives just-after the workflow's terminal write but
 * just-before our delete.
 *
 * 5 attempts × 5ms = 25ms total polling window. This covers ~3× the
 * P99 storage put latency observed for the slowest in-tree backend
 * (LMDB ~8ms P99 under load); shorter and we drop legitimately-late
 * responses, longer and the terminal-error path takes too long for
 * typical clients.
 *
 * If you raise these values, also re-evaluate the timeout budget for
 * `engine.update()` callers — they wait for this poll to complete
 * before seeing the terminal error.
 */
const COORDINATED_UPDATE_CONSUMPTION_RETRY_ATTEMPTS = 5;
const COORDINATED_UPDATE_CONSUMPTION_RETRY_DELAY_MS = 5;

export const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export type GuardCallbacks = {
  deleteRequestIfUnconsumed: (
    workflowId: string,
    updateId: string,
  ) => Promise<UpdateResponse | null>;
  getUpdateResponse: (updateId: string) => Promise<UpdateResponse | null>;
};

/** Throw {@link WorkflowTerminalError} if the workflow is in a terminal state. */
export async function guardTerminalWorkflow(
  internals: EngineInternals,
  workflowId: string,
  _callbacks: GuardCallbacks,
): Promise<void> {
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!stateBytes) return; // unknown workflow — let downstream handle it
  const state = decodeWorkflowState(stateBytes);
  if (TERMINAL_STATUSES.has(state.status)) {
    throw new WorkflowTerminalError(workflowId, state.status);
  }
}

async function coordinatedUpdateWasConsumed(
  internals: EngineInternals,
  workflowId: string,
  updateId: string,
  callbacks: GuardCallbacks,
): Promise<boolean> {
  for (let attempt = 0; attempt < COORDINATED_UPDATE_CONSUMPTION_RETRY_ATTEMPTS; attempt++) {
    const response = await callbacks.getUpdateResponse(updateId);
    if (response !== null) return true;

    const request = await internals.storage.get(KEYS.update(workflowId, updateId));
    if (request === null) return true;

    if (attempt < COORDINATED_UPDATE_CONSUMPTION_RETRY_ATTEMPTS - 1) {
      await sleep(COORDINATED_UPDATE_CONSUMPTION_RETRY_DELAY_MS);
    }
  }

  return false;
}

/**
 * Re-check terminal state after persisting a coordinated update request.
 * This closes the race where the workflow completes between the preflight
 * guard and request creation, which would otherwise leave the caller
 * waiting for a response that can never arrive.
 */
export async function guardTerminalWorkflowAfterCoordinatedRequest(
  internals: EngineInternals,
  workflowId: string,
  updateId: string,
  callbacks: GuardCallbacks,
): Promise<void> {
  try {
    await guardTerminalWorkflow(internals, workflowId, callbacks);
  } catch (error) {
    if (error instanceof WorkflowTerminalError) {
      if (await coordinatedUpdateWasConsumed(internals, workflowId, updateId, callbacks)) {
        return;
      }

      const lateResponse = await callbacks.deleteRequestIfUnconsumed(workflowId, updateId);
      if (lateResponse !== null) {
        return;
      }
    }

    throw error;
  }
}
