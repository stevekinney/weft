import { serializeCheckpoint } from '../../checkpoint.ts';
import type { Checkpoint } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { type LifecycleCallbacks } from './shared.ts';

export function runWorkflowStartInterceptor(
  _internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  parentHeaders: Map<string, string> | undefined,
  callbacks: LifecycleCallbacks,
): Map<string, string> | undefined {
  const composedInterceptor = callbacks.getComposedWorkflowInterceptor();
  if (!composedInterceptor) {
    return undefined;
  }

  const headers = new Map<string, string>();
  if (parentHeaders) {
    for (const [key, value] of parentHeaders) {
      headers.set(key, value);
    }
  }

  let capturedHeaders: Map<string, string> | undefined;
  composedInterceptor.workflowStart(
    {
      workflowId,
      workflowType,
      input,
      headers,
    },
    (interception) => {
      capturedHeaders = new Map(interception.headers);
    },
  );

  return capturedHeaders;
}

export function startWorkflowExecution(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  checkpoint: Checkpoint,
  nestingDepth: number,
  executionDeadline: number | undefined,
  executionStateOwnerId: string,
  _callbacks?: LifecycleCallbacks,
): void {
  // Skip the map entry for the common non-nested case — readers fall back
  // to 0. Saves per-workflow V8 Map overhead (~80 bytes) on the hot path.
  if (nestingDepth !== 0) {
    internals.workflowNestingDepths.set(workflowId, nestingDepth);
  }
  // Cache the workflow type for synchronous activity-registry lookup on the
  // dispatch hot path. Cleared on terminal cleanup (see termination/cleanup.ts).
  internals.workflowTypeByWorkflowId.set(workflowId, workflowType);
  internals.strategy.startWorkflow({
    workflowId,
    workflowType,
    input,
    checkpoint: serializeCheckpoint(checkpoint),
    nestingDepth,
    executionStateOwnerId,
    startedAt: checkpoint.createdAt,
    sleepReferenceTime: checkpoint.createdAt,
    ...(executionDeadline !== undefined && { deadline: executionDeadline }),
    ...(internals.workflowHeaders.has(workflowId) && {
      headers: [...internals.workflowHeaders.get(workflowId)!],
    }),
  });
}
