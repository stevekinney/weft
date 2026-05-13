import type { Engine } from '../../core/engine.ts';
import type { WorkflowStatus } from '../../core/types.ts';
import { sleepForTesting } from '../../testing/fake-timers.ts';

type WaitForWorkflowStatusOptions = {
  intervalMilliseconds?: number;
  timeoutMilliseconds?: number;
};

const DEFAULT_STATUS_POLL_INTERVAL_MILLISECONDS = 5;
const DEFAULT_STATUS_TIMEOUT_MILLISECONDS = 500;

/** Build a localhost request with an optional JSON body for operation tests. */
export function jsonRequest(method: string, path: string, body?: unknown): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, options);
}

/** Build a localhost request containing intentionally malformed JSON. */
export function invalidJsonRequest(method: string, path: string, rawBody: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

/** Wait until the engine reports the requested workflow lifecycle status. */
export async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowStatus,
  {
    intervalMilliseconds = DEFAULT_STATUS_POLL_INTERVAL_MILLISECONDS,
    timeoutMilliseconds = DEFAULT_STATUS_TIMEOUT_MILLISECONDS,
  }: WaitForWorkflowStatusOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(intervalMilliseconds);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}
