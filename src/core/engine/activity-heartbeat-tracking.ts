import type { ActivityContext } from '../types.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Per-step heartbeat tracking for {@link ActivityContext.lastHeartbeatDetails}.
 *
 * The store is keyed `workflowId -> step` (not `workflowId` alone) so a retry of
 * an activity step reads the heartbeat ITS prior attempt recorded — and so a
 * later step's first attempt never inherits an earlier step's heartbeat, and
 * concurrent `ctx.all` activities never clobber one another. The step is stable
 * across retry attempts (assigned once at `stepIndex++`). Held only in engine
 * memory and cleared by workflowId (the outer key) on terminal cleanup and purge.
 */

/** Record the heartbeat the current attempt of a step sent. */
export function recordLastHeartbeatForStep(
  internals: EngineInternals,
  workflowId: string,
  step: number,
  details: unknown,
): void {
  let byStep = internals.lastHeartbeatDetailsByStep.get(workflowId);
  if (byStep === undefined) {
    byStep = new Map<number, unknown>();
    internals.lastHeartbeatDetailsByStep.set(workflowId, byStep);
  }
  byStep.set(step, details);
}

/** Read the heartbeat a prior attempt of this step recorded, or `undefined`. */
export function readLastHeartbeatForStep(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): unknown {
  return internals.lastHeartbeatDetailsByStep.get(workflowId)?.get(step);
}

/**
 * Build the {@link ActivityContext} handed to an inline activity function. The
 * signal comes from the per-workflow AbortController (so workflow cancellation
 * aborts it); `lastHeartbeatDetails` and `heartbeat` are wired to the per-step
 * tracking above; `completeAsync` is supplied by the caller (it owns the
 * async-completion token machinery).
 */
export function buildActivityContext(
  internals: EngineInternals,
  workflowId: string,
  step: number,
  signal: AbortSignal,
  completeAsync: () => never,
): ActivityContext {
  return {
    signal,
    // The heartbeat the prior attempt of THIS step recorded (resumable-batch
    // pattern); keyed per-step so concurrent `ctx.all` activities don't collide.
    lastHeartbeatDetails: readLastHeartbeatForStep(internals, workflowId, step),
    heartbeat: (details?: unknown) => {
      internals.heartbeatDetails.set(workflowId, details);
      recordLastHeartbeatForStep(internals, workflowId, step, details);
    },
    completeAsync,
  };
}
