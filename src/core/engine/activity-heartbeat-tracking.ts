import { DevelopmentWarningEvent } from '../events.ts';
import type { ActivityContext } from '../types.ts';
import type { EngineInternals } from './internals.ts';

export type ActivityHeartbeatKey = number | string;

/**
 * Per-activity heartbeat tracking for {@link ActivityContext.lastHeartbeatDetails}.
 *
 * The store is keyed `workflowId -> activity key` (not `workflowId` alone) so a
 * retry of an activity reads the heartbeat its prior attempt recorded — and so a
 * later step's first attempt never inherits an earlier step's heartbeat, and
 * concurrent `ctx.all` activities never clobber one another. Plain `ctx.run`
 * uses the deterministic numeric workflow step; memo-scoped helper activities
 * use a string sub-operation key derived from their owning memo call.
 */

function activityHeartbeatKeyLabel(key: ActivityHeartbeatKey): string {
  return typeof key === 'number' ? `step ${String(key)}` : `activity state key ${key}`;
}

function activityHeartbeatFieldPath(key: ActivityHeartbeatKey): string {
  return typeof key === 'number'
    ? `step.${String(key)}.lastHeartbeatDetails`
    : `activityStateKey.${key}.lastHeartbeatDetails`;
}

/** Record the heartbeat the current attempt of an activity sent. */
export function recordLastHeartbeatForStep(
  internals: EngineInternals,
  workflowId: string,
  step: ActivityHeartbeatKey,
  details: unknown,
): void {
  let byStep = internals.lastHeartbeatDetailsByStep.get(workflowId);
  if (byStep === undefined) {
    byStep = new Map<ActivityHeartbeatKey, unknown>();
    internals.lastHeartbeatDetailsByStep.set(workflowId, byStep);
  }
  byStep.set(step, details);
}

/** Read the heartbeat a prior attempt of this activity recorded, or `undefined`. */
export function readLastHeartbeatForStep(
  internals: EngineInternals,
  workflowId: string,
  step: ActivityHeartbeatKey,
): unknown {
  return internals.lastHeartbeatDetailsByStep.get(workflowId)?.get(step);
}

/**
 * Drop the heartbeat tracked for a single step once that step has completed
 * successfully — after inline verify, and (on the idempotency path) after the
 * reconciliation write, so a verify-rejection retry still reads its prior
 * attempt's heartbeat. The plain path has no reconciliation write; both paths
 * call this only at their successful return. Removes the inner-map entry and
 * drops the outer workflow entry when its last step clears, so a long-lived
 * workflow doesn't accumulate stale per-step heartbeats. Clearing late is
 * harmless (bounded by terminal cleanup); clearing early would strip the
 * resumable-batch heartbeat a retry depends on, so this is only ever called from
 * the non-speculative success path.
 */
export function clearLastHeartbeatForStep(
  internals: EngineInternals,
  workflowId: string,
  step: ActivityHeartbeatKey,
): void {
  const byStep = internals.lastHeartbeatDetailsByStep.get(workflowId);
  if (byStep === undefined) {
    return;
  }
  byStep.delete(step);
  if (byStep.size === 0) {
    internals.lastHeartbeatDetailsByStep.delete(workflowId);
  }
}

/**
 * #493: in development mode, emit a COARSE warning when an inline activity RETRY
 * (`attempt > 1`) starts with no `lastHeartbeatDetails` — the closest runtime
 * proxy for the resumable-batch footgun. We cannot distinguish "the prior attempt
 * never heartbeated" (benign) from "the heartbeat was discarded by a process
 * restart" (the dangerous case): the distinguishing fact is the wiped in-memory
 * state, gone by definition. So the message names BOTH possibilities and never
 * claims a restart happened. The gates (development, inline, attempt, missing
 * heartbeat) are read straight off the code below; two facts are NOT derivable
 * from it:
 *
 * - It fires on the speculative path too. A speculative `attempt > 1` that later
 *   rolls back still ran twice and still lost any resume payload, so the footgun
 *   is real regardless — letting it warn is the deliberate, honest choice.
 * - It pairs with {@link clearLastHeartbeatForStep} without interference: the
 *   clear fires only on SUCCESS (a step that never retries) and this reads
 *   `undefined` only on a RETRY, and a cleared step is a completed step that by
 *   definition will not be retried.
 *
 * The inline gate keys on `!activityWorkerDispatcher` because dispatch is
 * engine-wide today; the heartbeat cache is only ever written on the inline path,
 * so whenever a dispatcher exists the cache is structurally empty and the gate is
 * required to suppress a false warning on every worker retry. A future per-activity
 * routing model would need this gate to key on the resolved per-dispatch mode
 * instead.
 */
export function warnIfRetryMissingHeartbeat(
  internals: EngineInternals,
  workflowId: string,
  step: ActivityHeartbeatKey,
  attempt: number,
): void {
  if (!internals.options.development) return;
  if (internals.activityWorkerDispatcher) return;
  if (attempt <= 1) return;
  if (readLastHeartbeatForStep(internals, workflowId, step) !== undefined) return;

  internals.engine.dispatchEvent(
    new DevelopmentWarningEvent(
      workflowId,
      `Activity retry (attempt ${attempt}) at ${activityHeartbeatKeyLabel(step)} has no lastHeartbeatDetails. ` +
        'Either the previous attempt never recorded heartbeat details (it never ' +
        'called heartbeat(), or called it with no details), or the engine process ' +
        'restarted and discarded the in-memory heartbeat (it is not durable). The ' +
        'resumable-batch pattern only resumes across in-process retries; design the ' +
        'activity to restart cleanly when lastHeartbeatDetails is undefined.',
      [activityHeartbeatFieldPath(step)],
    ),
  );
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
  step: ActivityHeartbeatKey,
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
