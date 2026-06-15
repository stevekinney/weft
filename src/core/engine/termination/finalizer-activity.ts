/**
 * The `runFinalizerActivity` primitive (#446 Phase 2). A workflow's definition-level
 * `finalizer` is an ordinary activity, but it runs POST-terminal — after the engine
 * has evicted the workflow's generator and abort controller — so it cannot go through
 * the live-workflow `executeActivity` path: that path reads
 * `inlineStrategy.getAbortController(workflowId)` (gone after cancel) and the
 * per-workflow type/heartbeat bookkeeping (swept by terminal cleanup). This primitive
 * therefore owns its OWN `AbortController`, resolves the implementation from the
 * engine-lifetime registration entry, and never touches the operation-result feedback
 * channel.
 *
 * Outer retry/backoff is the teardown timer reschedule in `runWorkflowFinalizer`, NOT
 * the activity's own `retry` policy — so this primitive runs exactly one attempt and
 * surfaces success or a thrown error to the caller. The activity's `timeout` is honored
 * as a per-attempt cap.
 *
 * @module core/engine/termination/finalizer-activity
 */

import { parseDuration } from '../../scheduler.ts';
import type { ActivityContext, Duration } from '../../types.ts';
import { withPerAttemptTimeout } from '../activity-per-attempt-timeout.ts';

/**
 * The minimal finalizer shape this primitive uses. A registered finalizer is stored
 * as `AnyActivityDefinition`, whose `execute` is typed `ActivityFunction<never>` (the
 * input is contravariantly `never`) and which erases `timeout` at the type level —
 * neither shape is directly invokable with `unknown` input. The drive narrows the
 * registry entry to this structural type, which is what the engine actually relies on
 * at teardown: a named, callable activity with an optional per-attempt `timeout`.
 */
export interface RunnableFinalizer {
  readonly name: string;
  readonly timeout?: Duration;
  // A finalizer is an ordinary `activity()` function, so its body may return either
  // a value or a promise — both are awaited identically below. Typing the return as
  // `unknown` (rather than `Promise<unknown>`) lets the registered activity's actual
  // signature structurally satisfy this interface without a cast at the resolve point.
  execute(input: unknown, context?: ActivityContext): unknown;
}

/** Outcome of a single finalizer attempt. */
export type FinalizerAttemptResult =
  | { ok: true }
  | { ok: false; error: unknown; abortedByShutdown: boolean };

/**
 * Run one attempt of a workflow's finalizer activity against the recorded finalizer
 * state, under a caller-supplied abort signal (the engine shutdown signal) composed
 * with the activity's own per-attempt timeout. Resolves to a structured result rather
 * than throwing, so the drive can branch on success / retryable-failure / dead-letter
 * without a try/catch around it.
 *
 * @param finalizer - the resolved finalizer activity definition (from the engine-lifetime registry)
 * @param input - the decoded `ctx.setFinalizerState` payload passed as the activity input
 * @param attempt - 1-based attempt number, for the per-attempt timeout error message
 * @param shutdownSignal - the engine's dispose/shutdown abort signal; aborting it stops a cooperating finalizer
 */
export async function runFinalizerActivity(
  finalizer: RunnableFinalizer,
  input: unknown,
  attempt: number,
  shutdownSignal: AbortSignal,
): Promise<FinalizerAttemptResult> {
  const perAttemptTimeoutMs =
    finalizer.timeout === undefined ? undefined : parseDuration(finalizer.timeout);

  // The finalizer gets its own per-attempt controller, aborted either by the
  // per-attempt timeout or by engine shutdown (relayed below). It is intentionally
  // NOT the workflow's controller — that was evicted when the workflow terminated.
  const attemptController = new AbortController();
  const relayShutdownAbort = (): void => attemptController.abort(shutdownSignal.reason);
  if (shutdownSignal.aborted) {
    attemptController.abort(shutdownSignal.reason);
  } else {
    shutdownSignal.addEventListener('abort', relayShutdownAbort, { once: true });
  }

  // The finalizer runs post-terminal with no durable step to record a heartbeat
  // against, so `heartbeat` is a no-op — recording it would consume bookkeeping that
  // terminal cleanup has already swept (and emit a spurious "heartbeat for unknown
  // step" warning). The activity may still call it; it is simply ignored.
  // `completeAsync()` is unsupported here: async completion resolves a live durable
  // step via a token, but a finalizer has no such step (the workflow is already
  // terminal), so it throws rather than silently stranding the teardown.
  const activityContext: ActivityContext = {
    signal: attemptController.signal,
    heartbeat: () => {},
    completeAsync: (): never => {
      throw new Error(
        `Finalizer "${finalizer.name}" called ctx.completeAsync(), which is not supported in a ` +
          `workflow finalizer: the finalizer runs after the workflow is already terminal, so there ` +
          `is no durable step to complete out of band. Run the teardown synchronously instead.`,
      );
    },
  };

  try {
    await withPerAttemptTimeout(
      finalizer.execute(input, activityContext),
      perAttemptTimeoutMs,
      finalizer.name,
      attempt,
      attemptController,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error, abortedByShutdown: shutdownSignal.aborted };
  } finally {
    shutdownSignal.removeEventListener('abort', relayShutdownAbort);
  }
}
