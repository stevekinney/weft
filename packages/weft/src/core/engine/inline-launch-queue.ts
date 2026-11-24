import { WorkflowStartedEvent } from '../events.ts';
import type {
  QueuedInlineWorkflowExecutionStart,
  QueuedInlineWorkflowStartRequest,
} from './engine-internal-types.ts';
import { letGoOfFailedQueuedStart } from './inline-launch-failure.ts';
import type { EngineInternals } from './internals.ts';
import { startWorkflowExecution } from './lifecycle.ts';
import {
  isPendingLaunchStale,
  recordInlineWorkflowStartLaunching,
  recordInlineWorkflowStartQueued,
  settleEveryInlineWorkflowStart,
  settleInlineWorkflowStart,
} from './local-execution.ts';
import {
  holdsForRunSlot,
  queueHasLaunchableStart,
  requeueStartsHeldForRunSlots,
} from './run-concurrency.ts';
import { loadWorkflowState } from './storage-io.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

export type InlineLaunchQueueCallbacks = {
  processPendingUpdatesAfterInlineAdvance: (workflowId: string) => Promise<void>;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
};

/**
 * The engines whose scheduled flush has not run yet, held strongly (COR-1425).
 *
 * The scheduled flush is the only thing that drives a queued start's first turn, and the
 * `MessageChannel` handler that runs it reaches its engine through a `WeakRef`: a port with a
 * `message` listener stays reachable until it is closed, so a strong reference there would keep
 * every engine alive until disposal. Nothing else roots an engine while its flush is pending. A
 * caller awaiting `handle.result()` holds a cycle (its suspended continuation, the handle, the
 * result waiter, the engine, and the engine's internals reference only one another), so a garbage
 * collection between the end of the microtask turn that queued the start and the delivery of the
 * flush message reclaimed all of it. Bun runs JSC's pending collection timer at exactly that
 * point, before it takes newly posted tasks such as the flush message. The handler then found no
 * engine, closed the channel, and `result()` never settled.
 *
 * An engine is added when its flush is scheduled and removed when the flush starts or the queue
 * is drained or discarded directly, so it is kept alive for that window and no longer.
 */
const enginesAwaitingScheduledInlineFlush = new Set<EngineInternals>();

function markInlineFlushScheduled(internals: EngineInternals): void {
  internals.queuedInlineWorkflowStartFlushScheduled = true;
  enginesAwaitingScheduledInlineFlush.add(internals);
}

/**
 * Record that no flush is scheduled any more, either because the scheduled flush is starting or
 * because the queue is being drained or discarded directly, and stop holding the engine for it.
 */
export function clearInlineFlushScheduled(internals: EngineInternals): void {
  internals.queuedInlineWorkflowStartFlushScheduled = false;
  enginesAwaitingScheduledInlineFlush.delete(internals);
}

/** Test-only: whether `internals`' engine is being held until its scheduled flush runs. */
export function isEngineHeldForScheduledInlineFlushForTesting(internals: EngineInternals): boolean {
  return enginesAwaitingScheduledInlineFlush.has(internals);
}

/**
 * Test-only: whether any engine in this process still has a scheduled inline flush that has not
 * started, so a queued start has not yet had its first turn driven. A test that has no handle on
 * the engine can wait for this to turn false instead of guessing how many event-loop turns the
 * flush needs.
 */
export function isAnyEngineAwaitingScheduledInlineFlushForTesting(): boolean {
  return enginesAwaitingScheduledInlineFlush.size > 0;
}

/**
 * Schedules a flush unless one is scheduled already, or `inlineLaunchSchedulingMode` is
 * `'manual'` (COR-74), where only the caller's `flushInlineLaunches()` drives the queue.
 */
function scheduleInlineFlush(internals: EngineInternals, callbacks: InlineLaunchQueueCallbacks) {
  if (internals.options.inlineLaunchSchedulingMode === 'manual') return;
  if (internals.queuedInlineWorkflowStartFlushScheduled) return;
  markInlineFlushScheduled(internals);
  if (internals.queuedInlineWorkflowStartChannel !== null) {
    internals.queuedInlineWorkflowStartChannel.port2.postMessage(undefined);
    return;
  }
  setTimeout(() => {
    clearInlineFlushScheduled(internals);
    void callbacks.swallowPromiseRejection(flushQueuedInlineWorkflowStarts(internals, callbacks));
  }, 0);
}

async function yieldQueuedShutdownAdvanceOpportunity(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function settleQueuedShutdownWork(
  pendingWork: Array<{ workflowId: string; promise: Promise<unknown> | undefined }>,
): Promise<string[]> {
  if (pendingWork.length === 0) return [];
  const opportunityElapsed = yieldQueuedShutdownAdvanceOpportunity().then(() => false);
  const results = await Promise.all(
    pendingWork.map(async ({ workflowId, promise }) => {
      if (promise === undefined) return workflowId;
      const settled = await Promise.race([promise.then(() => true), opportunityElapsed]);
      return settled ? workflowId : null;
    }),
  );
  return results.filter((workflowId): workflowId is string => workflowId !== null);
}

/**
 * Queue a new inline workflow start and schedule a flush if one is not
 * already scheduled — unless `inlineLaunchSchedulingMode` is `'manual'`
 * (COR-74), in which case nothing is scheduled at all: the start sits queued
 * until a caller explicitly drives it via
 * {@link flushQueuedInlineWorkflowStartsUntilDrained} (`engine.flushInlineLaunches()`).
 */
export function queueInlineWorkflowExecutionStart(
  internals: EngineInternals,
  request: QueuedInlineWorkflowStartRequest,
  callbacks: InlineLaunchQueueCallbacks,
): void {
  const start: QueuedInlineWorkflowExecutionStart = {
    ...request,
    launch: recordInlineWorkflowStartQueued(internals, request.workflowId),
  };
  internals.queuedInlineWorkflowStarts.push(start);
  scheduleInlineFlush(internals, callbacks);
}

/**
 * Discard a set of queued inline starts consistently: settle each one's
 * `onStarted` liveness callback (so a `defer: false` awaiter does not hang on a
 * run that will never become live) AND remove its id from both queue-membership
 * indexes (so they never claim a start that is no longer queued). Used by every
 * path that drops queued starts without executing them: abort-during-flush,
 * synchronous dispose, and cancel-while-queued.
 */
function settleDiscardedInlineStarts(
  internals: EngineInternals,
  discarded: QueuedInlineWorkflowExecutionStart[],
): void {
  for (const start of discarded) {
    settleInlineWorkflowStart(internals, start.launch);
    start.onStarted?.();
  }
}

export async function flushQueuedInlineWorkflowStarts(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
  options?: { abortStartedWorkflows?: boolean },
): Promise<void> {
  if (internals.abortController.signal.aborted) {
    // The engine is tearing down. Discard the queue, but settle each start's
    // liveness callback and clear its membership indexes first so a defer:false
    // awaiter does not hang and the id sets do not claim discarded starts.
    const discarded = internals.queuedInlineWorkflowStarts;
    internals.queuedInlineWorkflowStarts = [];
    settleDiscardedInlineStarts(internals, discarded);
    return;
  }

  if (internals.queuedInlineWorkflowStarts.length === 0) {
    return;
  }

  const pendingStarts = internals.queuedInlineWorkflowStarts;
  internals.queuedInlineWorkflowStarts = [];
  const held: QueuedInlineWorkflowExecutionStart[] = [];

  for (const start of pendingStarts) {
    if (holdsForRunSlot(internals, start, held.length)) {
      held.push(start);
      continue;
    }
    // Isolate each start: a throw from one must not abandon the rest of the
    // batch. The batch was already removed from the queue above, so an escaping
    // throw would leave later starts' onStarted callbacks unfired forever —
    // hanging their defer:false awaiters. swallowPromiseRejection contains the
    // failure, which `startQueuedInlineWorkflowExecution` has already reported
    // and acted on (see `letGoOfFailedQueuedStart`); the per-start finally
    // still fires onStarted.
    await callbacks.swallowPromiseRejection(
      startQueuedInlineWorkflowExecution(internals, start, callbacks, options),
    );
  }
  requeueStartsHeldForRunSlots(internals, held, () => {
    if (internals.queuedInlineWorkflowStarts.length === 0) return;
    if (!internals.abortController.signal.aborted) scheduleInlineFlush(internals, callbacks);
  });
}

/** Used by scheduler-driven direct backfill flushes. Clears the scheduled flag first. */
export async function flushQueuedInlineWorkflowStartsDirectly(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
): Promise<void> {
  clearInlineFlushScheduled(internals);
  await flushQueuedInlineWorkflowStarts(internals, callbacks);
}

/**
 * Deterministically drain every currently-queued inline launch, and any
 * further start a completing turn enqueues synchronously (e.g.
 * `ctx.startChild`), without scheduling anything — the basis for
 * `engine.flushInlineLaunches()` (COR-74).
 *
 * Runs the exact same {@link startQueuedInlineWorkflowExecution} path a
 * scheduled flush uses (no step execution is skipped or stubbed), just called
 * directly instead of waiting for a `MessageChannel`/`setTimeout(0)`
 * macrotask. Safe to call regardless of `inlineLaunchSchedulingMode`: under
 * `'event-loop'` mode it simply runs the queue now, and the already-scheduled
 * flush becomes a no-op once it eventually fires against an empty queue (see
 * {@link flushQueuedInlineWorkflowStarts}'s empty-queue early return).
 *
 * Bounded by the same pass cap as {@link drainQueuedInlineWorkflowStarts},
 * guarding against a pathological self-enqueueing run — but unlike that
 * function, this is NOT a teardown path: it does not touch the abort signal,
 * run the shutdown-settle wait, or accept `abortStartedWorkflows`. A start
 * queued after the engine already aborted is discarded by
 * {@link flushQueuedInlineWorkflowStarts}'s own abort check, exactly as it
 * would be under the scheduled flush.
 */
export async function flushQueuedInlineWorkflowStartsUntilDrained(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
): Promise<void> {
  let passes = 0;
  const maxPasses = 1000;
  while (queueHasLaunchableStart(internals) && passes < maxPasses) {
    passes += 1;
    await flushQueuedInlineWorkflowStartsDirectly(internals, callbacks);
  }
}

/**
 * Drain every pending inline launch before engine teardown. Called from
 * `[Symbol.asyncDispose]` *before* `disposeEngine` aborts the signal, so the
 * flush actually executes the queued starts (the abort check in
 * {@link flushQueuedInlineWorkflowStarts} would otherwise discard them). This
 * turns a deferred-launch macrotask into work that completes before
 * `asyncDispose` returns, so a disposed engine leaves no dangling pending
 * launch — the fix for the test-runner macrotask-starvation footgun.
 *
 * A queued start that was already aborted (signal set before this is reached)
 * is left for the synchronous `disposeQueuedInlineWorkflowStarts` path, which
 * discards it and settles its `defer: false` awaiter.
 */
export async function drainQueuedInlineWorkflowStarts(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
  options?: { abortStartedWorkflows?: boolean },
): Promise<void> {
  clearInlineFlushScheduled(internals);
  // Drain repeatedly: a started workflow can synchronously enqueue a child
  // inline start (e.g. ctx.startChild), so one pass may leave fresh entries.
  // Bounded by the abort signal and an explicit pass cap so a pathological
  // self-enqueueing run cannot spin forever during teardown.
  let passes = 0;
  const maxPasses = 1000;
  while (
    queueHasLaunchableStart(internals) &&
    !internals.abortController.signal.aborted &&
    passes < maxPasses
  ) {
    passes += 1;
    const workflowIds = internals.queuedInlineWorkflowStarts.map((start) => start.workflowId);
    // Swallow per-pass rejection so a single failing start cannot reject the
    // whole drain — which, called from asyncDispose, would otherwise skip the
    // synchronous teardown and leave the engine half-disposed. Mirrors the
    // scheduled-flush path's swallowPromiseRejection wrapping.
    await callbacks.swallowPromiseRejection(
      flushQueuedInlineWorkflowStarts(internals, callbacks, options),
    );

    // Give cooperatively-aborted first advances one scheduler opportunity to
    // settle, but never let arbitrary user code that ignores ctx.signal hold
    // disposal indefinitely. The inline strategy suppresses a new operation
    // yielded after this shutdown abort, leaving it for successor recovery. A
    // cooperative terminal return still emits a finite durable turn, which must
    // commit before lease handoff.
    const pendingAdvances = workflowIds.map((workflowId) => {
      const pendingAdvance = internals.inlineStrategy?.waitForWorkflowAdvance(workflowId);
      return {
        workflowId,
        promise:
          pendingAdvance === undefined
            ? undefined
            : callbacks.swallowPromiseRejection(pendingAdvance),
      };
    });
    const settledWorkflowIds = await settleQueuedShutdownWork(pendingAdvances);
    if (settledWorkflowIds.length > 0) {
      const terminalTurns = settledWorkflowIds.flatMap((workflowId) => {
        if (internals.inlineStrategy?.hasGenerator(workflowId)) {
          return [];
        }
        const pendingTurn = internals.inlineStrategy?.waitForWorkflowTurn(workflowId);
        return pendingTurn === undefined ? [] : [callbacks.swallowPromiseRejection(pendingTurn)];
      });
      await Promise.all(terminalTurns);
    }
  }
  // The `passes < maxPasses` bound above is a backstop against a pathological
  // self-enqueueing run spinning teardown forever; in normal operation the abort
  // signal or an empty queue ends the loop first. Anything still queued at exit
  // is discarded by the synchronous dispose that follows.
}

/**
 * `confirmWakeOwnership` validated the HOLDER, but a linearizable holder read
 * can still return the pre-replacement generation while a cancellation
 * followed by `onTerminalConflict: 'start-new'` commits a REPLACEMENT run on
 * this same workflow id during that await — the new run's registry epoch can
 * already be live, so subsequent writes would use it while this queued start
 * still carries the OLD run's checkpoint and input. Re-read the run identity
 * and require it to still be the exact run this launch was queued for,
 * closing the gap the holder check alone cannot: a workflow id surviving a
 * status/holder check is not proof it is still the SAME run. Split out of
 * `startQueuedInlineWorkflowExecution` purely to keep that function's own
 * cyclomatic complexity under the repository's ceiling.
 *
 * The token is compared exactly (COR-1604). A queued start carries the token of
 * the record it was queued from, so it has none only for a pre-token run, and a
 * replacement always has one: a missing token identifies the pre-token run, not
 * every later run of the id.
 */
async function isQueuedStartStillTheLiveRun(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
): Promise<boolean> {
  const currentState = await loadWorkflowState(internals, start.workflowId);
  return (
    currentState !== null &&
    currentState.status === 'running' &&
    currentState.workflowExecutionToken === start.workflowExecutionToken
  );
}

/**
 * What follows the generator's first scheduled turn. Async disposal starts queued workflows so
 * their first turns cannot fire later against torn-down state: it aborts cooperatively after
 * `generator.next()` has been scheduled, before awaiting either the advance or pending-update
 * processing, so a first turn parked on `ctx.signal` can settle (if the aborted advance yields
 * another operation, the inline strategy suppresses it so nested work cannot begin during lease
 * handoff). Otherwise the pending updates are processed. Not `async`, and split out of
 * {@link startQueuedInlineWorkflowExecution} only for the repository's complexity ceiling: the
 * launch path's turn count is load-bearing, and this adds none on the processing path.
 */
function settleQueuedStartFirstAdvance(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  callbacks: Pick<InlineLaunchQueueCallbacks, 'processPendingUpdatesAfterInlineAdvance'>,
  options: { abortStartedWorkflows?: boolean } | undefined,
): Promise<void> | undefined {
  if (options?.abortStartedWorkflows === true) {
    internals.inlineStrategy?.abortWorkflowAdvanceForShutdown(start.workflowId);
    return undefined;
  }
  return callbacks.processPendingUpdatesAfterInlineAdvance(start.workflowId);
}

/**
 * Move the queued start's own record to `launching`, in the same synchronous turn as the launch
 * that follows, or report the start stale: enqueued under a claim this engine lost and took back
 * since, so its checkpoint may be behind the run's durable one; the reclaim that took the claim
 * back drives the run from storage instead (COR-1618). Synchronous, so the launch path gains no
 * turn.
 */
function beginQueuedStartLaunch(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
): boolean {
  if (isPendingLaunchStale(internals, start.launch)) return false;
  recordInlineWorkflowStartLaunching(internals, start.launch);
  return true;
}

async function startQueuedInlineWorkflowExecution(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  callbacks: Pick<InlineLaunchQueueCallbacks, 'processPendingUpdatesAfterInlineAdvance'>,
  options?: { abortStartedWorkflows?: boolean },
): Promise<void> {
  try {
    const state = await loadWorkflowState(internals, start.workflowId);
    if (!state || state.status !== 'running') {
      return;
    }

    // ADR 0002's `inline-macrotask-drive` wake kind: this launch was queued at
    // an earlier tick, and the gap before this deferred macrotask actually
    // runs is unbounded under load — long enough that this engine's claim for
    // `start.workflowId` (acquired at enqueue time via a folded enabling
    // write) may since have been taken over. Unlike a timer-driven wake, no
    // in-memory-only sanity check can bound that latency against any
    // configured TTL, so this is a REAL `wakeOwnershipCheck`, not a cheaper
    // local guard. A discard is a silent no-op here: this engine no longer
    // owns the workflow, so its own copy of the queued start must not drive
    // the generator's first turn — the takeover winner starts it instead.
    if (
      (await confirmWakeOwnership(internals, start.workflowId, 'inline-macrotask-drive')) ===
      'discard'
    ) {
      return;
    }

    if (!(await isQueuedStartStillTheLiveRun(internals, start))) {
      return;
    }

    if (!beginQueuedStartLaunch(internals, start)) {
      return;
    }
    internals.engine.dispatchEvent(
      new WorkflowStartedEvent(start.workflowId, start.workflowType, start.input),
    );
    startWorkflowExecution(
      internals,
      start.workflowId,
      state.workflowExecutionToken,
      start.workflowType,
      // Re-read off the RELOADED persisted state, exactly like
      // `workflowExecutionToken` above — never from `start` itself (WFT-20).
      state.revision,
      start.input,
      start.checkpoint,
      start.nestingDepth,
      start.executionDeadline,
      start.executionStateOwnerId,
    );

    await settleQueuedStartFirstAdvance(internals, start, callbacks, options);
  } catch (error) {
    await letGoOfFailedQueuedStart(internals, start, error);
    throw error;
  } finally {
    // The launch is over, whatever it did: the run is now live, let go, or someone else's.
    settleInlineWorkflowStart(internals, start.launch);
    // Settle the `defer: false` awaiter exactly once. The generator has been
    // driven by this point on the success path; on the skip/throw paths the run
    // will not become live, so resolving (rather than hanging the awaiter) is the
    // correct terminal signal. `onStarted` is one-shot at the call site.
    start.onStarted?.();
  }
}

export function dropQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  if (internals.queuedInlineWorkflowStarts.length === 0) {
    return false;
  }

  const initialLength = internals.queuedInlineWorkflowStarts.length;
  const dropped: QueuedInlineWorkflowExecutionStart[] = [];
  internals.queuedInlineWorkflowStarts = internals.queuedInlineWorkflowStarts.filter((start) => {
    if (start.workflowId === workflowId) {
      dropped.push(start);
      return false;
    }
    return true;
  });
  if (internals.queuedInlineWorkflowStarts.length !== initialLength) {
    // Settle the `defer: false` awaiter for a start dropped before it ran (e.g.
    // the workflow was cancelled/terminated while still queued) and clear its
    // membership indexes. The run never became live, but the awaiter must not
    // hang. Mirrors the dispose and abort paths.
    settleDiscardedInlineStarts(internals, dropped);
  }
  return internals.queuedInlineWorkflowStarts.length !== initialLength;
}

export function disposeQueuedInlineWorkflowStarts(internals: EngineInternals): void {
  clearInlineFlushScheduled(internals);
  // Settle any `defer: false` awaiters for starts discarded by a synchronous
  // dispose. The run never became live, but its awaiter must not hang on a
  // torn-down engine. (asyncDispose drains these instead of discarding them.)
  const discarded = internals.queuedInlineWorkflowStarts;
  internals.queuedInlineWorkflowStarts = [];
  settleDiscardedInlineStarts(internals, discarded);
  // Belt-and-suspenders full reset: the helper already settled each discarded
  // start, but a total clear guards against any index entry without a
  // matching queued start, and settles whatever waited on one.
  settleEveryInlineWorkflowStart(internals);

  const channel = internals.queuedInlineWorkflowStartChannel;
  if (channel !== null) {
    channel.port1.close();
    channel.port2.close();
    internals.queuedInlineWorkflowStartChannel = null;
  }
}
