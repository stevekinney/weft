/**
 * Shared test-only helper for polling an engine until a workflow reaches a
 * target status. Used by bulk-operation REST behavior tests and the
 * JSON-RPC WebSocket integration test, which otherwise each carried an
 * identical copy of this loop.
 *
 * This module is test-only (`.test-support.ts` is excluded from the production
 * build) and must never be imported by production server code.
 */

import type { Engine } from '../core/engine.ts';

import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

/** Terminal and intermediate workflow statuses the tests wait on. */
export type WaitableWorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

/**
 * Poll `engine.get(workflowId)` until the workflow reports `status`, or throw
 * once `timeoutMilliseconds` elapses. Polls every 5ms via `sleepForTesting`.
 */
export async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WaitableWorkflowStatus,
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}
