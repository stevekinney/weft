import type { ContextOperationRequest } from '../context.ts';
import {
  ActivityPerAttemptTimeoutError,
  parsePerAttemptTimeoutMs,
} from '../context/activity-schedule-to-close.ts';
import type { EngineInternals } from './internals.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

/**
 * Resolve the per-attempt `timeout` setup for an activity attempt (#494).
 *
 * The cap is INLINE-only: worker-mode per-attempt bounds are governed by
 * `visibilityTimeout`, and racing the engine's await against a deadline while a
 * remote worker keeps running would orphan its result and risk double-execution on
 * the next visibility-timeout re-dispatch. When a cap is configured, a fresh
 * per-attempt `AbortController` drives cooperative cancellation; its signal is
 * composited with the workflow-wide signal so the activity's `ctx.signal` aborts on
 * EITHER workflow cancellation OR a per-attempt timeout — without the timeout
 * reaching back to cancel the whole workflow (which would also poison the next
 * retry's signal).
 */
export function resolvePerAttemptTimeout(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
): {
  perAttemptTimeoutMs: number | undefined;
  attemptAbortController: AbortController | undefined;
  activitySignal: AbortSignal;
} {
  const workflowAbortController = internals.inlineStrategy?.getAbortController(workflowId);
  const perAttemptTimeoutMs = internals.activityWorkerDispatcher
    ? undefined
    : parsePerAttemptTimeoutMs(operation.options?.['timeout']);
  const attemptAbortController =
    perAttemptTimeoutMs === undefined ? undefined : new AbortController();
  const activitySignal = composeActivitySignal(
    workflowAbortController?.signal,
    attemptAbortController?.signal,
  );
  return { perAttemptTimeoutMs, attemptAbortController, activitySignal };
}

/**
 * Compose the activity's `ctx.signal` from the workflow-wide cancellation signal
 * and the optional per-attempt timeout signal. The activity aborts on EITHER
 * source. Falls back to a lone signal (or a never-aborting one) so the activity
 * context always has a usable `AbortSignal`.
 */
function composeActivitySignal(
  workflowSignal: AbortSignal | undefined,
  attemptSignal: AbortSignal | undefined,
): AbortSignal {
  const signals = [workflowSignal, attemptSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0]!;
  return AbortSignal.any(signals);
}

/**
 * Bound a single inline activity attempt by its per-attempt `timeout` (#494).
 *
 * When `timeoutMs` is set and the attempt does not settle first, the returned
 * promise rejects with {@link ActivityPerAttemptTimeoutError} and the per-attempt
 * `AbortController` is aborted with that same error — so the activity's composite
 * `ctx.signal` flips, letting a cooperating activity stop promptly. Weft cannot
 * forcibly preempt the activity function: a non-cooperating activity keeps running
 * in the background until it returns; only the workflow stops awaiting it. The
 * abandoned invocation's eventual settlement is swallowed so it never surfaces as
 * an unhandled rejection after the race has moved on. The timed-out rejection
 * flows through the normal retry path, so a retry policy gets a fresh attempt with
 * a fresh cap (and a fresh per-attempt controller).
 *
 * Returns the invocation unchanged (no timer armed) when no cap is configured.
 */
export async function withPerAttemptTimeout(
  invocation: unknown,
  timeoutMs: number | undefined,
  activityName: string,
  attempt: number,
  attemptAbortController: AbortController | undefined,
): Promise<unknown> {
  if (timeoutMs === undefined) return invocation;
  const activityPromise = Promise.resolve(invocation);
  // Once the deadline wins the race, nothing awaits the activity promise again;
  // swallow its eventual settlement so an abort-triggered rejection does not become
  // an unhandled rejection.
  activityPromise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ActivityPerAttemptTimeoutError(activityName, attempt, timeoutMs);
      // Abort the PER-ATTEMPT controller only — never the workflow-wide one — so a
      // cooperating activity sees its signal flip without the workflow being
      // cancelled and without poisoning the next retry's signal.
      attemptAbortController?.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([activityPromise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
