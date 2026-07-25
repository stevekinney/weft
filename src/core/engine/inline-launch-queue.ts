import { WorkflowStartedEvent } from '../events.ts';
import type { QueuedInlineWorkflowExecutionStart } from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';
import { startWorkflowExecution } from './lifecycle.ts';
import { loadWorkflowState } from './storage-io.ts';

export type InlineLaunchQueueCallbacks = {
  processPendingUpdatesAfterInlineAdvance: (workflowId: string) => Promise<void>;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
};

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

/** Queue a new inline workflow start and schedule a flush if one is not already scheduled. */
export function queueInlineWorkflowExecutionStart(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  callbacks: InlineLaunchQueueCallbacks,
): void {
  internals.queuedInlineWorkflowStartIds.add(start.workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.add(start.workflowId);
  internals.queuedInlineWorkflowStarts.push(start);
  if (internals.queuedInlineWorkflowStartFlushScheduled) {
    return;
  }

  internals.queuedInlineWorkflowStartFlushScheduled = true;
  if (internals.queuedInlineWorkflowStartChannel !== null) {
    internals.queuedInlineWorkflowStartChannel.port2.postMessage(undefined);
    return;
  }

  setTimeout(() => {
    internals.queuedInlineWorkflowStartFlushScheduled = false;
    void callbacks.swallowPromiseRejection(flushQueuedInlineWorkflowStarts(internals, callbacks));
  }, 0);
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
    internals.queuedInlineWorkflowStartIds.delete(start.workflowId);
    internals.queuedOrLaunchingInlineWorkflowStartIds.delete(start.workflowId);
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

  for (const start of pendingStarts) {
    // Isolate each start: a throw from one must not abandon the rest of the
    // batch. The batch was already removed from the queue above, so an escaping
    // throw would leave later starts' onStarted callbacks unfired forever —
    // hanging their defer:false awaiters. swallowPromiseRejection contains the
    // failure; the per-start finally still fires onStarted.
    await callbacks.swallowPromiseRejection(
      startQueuedInlineWorkflowExecution(internals, start, callbacks, options),
    );
  }
}

/** Used by scheduler-driven direct backfill flushes. Clears the scheduled flag first. */
export async function flushQueuedInlineWorkflowStartsDirectly(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
): Promise<void> {
  internals.queuedInlineWorkflowStartFlushScheduled = false;
  await flushQueuedInlineWorkflowStarts(internals, callbacks);
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
  internals.queuedInlineWorkflowStartFlushScheduled = false;
  // Drain repeatedly: a started workflow can synchronously enqueue a child
  // inline start (e.g. ctx.startChild), so one pass may leave fresh entries.
  // Bounded by the abort signal and an explicit pass cap so a pathological
  // self-enqueueing run cannot spin forever during teardown.
  let passes = 0;
  const maxPasses = 1000;
  while (
    internals.queuedInlineWorkflowStarts.length > 0 &&
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

    internals.queuedInlineWorkflowStartIds.delete(start.workflowId);
    internals.engine.dispatchEvent(
      new WorkflowStartedEvent(start.workflowId, start.workflowType, start.input),
    );
    startWorkflowExecution(
      internals,
      start.workflowId,
      state.workflowExecutionToken,
      start.workflowType,
      start.input,
      start.checkpoint,
      start.nestingDepth,
      start.executionDeadline,
      start.executionStateOwnerId,
    );

    // Async disposal starts queued workflows so their first turns cannot fire
    // later against torn-down state. Abort cooperatively after generator.next()
    // has been scheduled, before awaiting either the advance or pending-update
    // processing, so a first turn parked on ctx.signal can settle. If the
    // aborted advance yields another operation, the inline strategy suppresses
    // it so nested work cannot begin during lease handoff.
    if (options?.abortStartedWorkflows === true) {
      internals.inlineStrategy?.abortWorkflowAdvanceForShutdown(start.workflowId);
    } else {
      await callbacks.processPendingUpdatesAfterInlineAdvance(start.workflowId);
    }
  } finally {
    internals.queuedInlineWorkflowStartIds.delete(start.workflowId);
    internals.queuedOrLaunchingInlineWorkflowStartIds.delete(start.workflowId);
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
  internals.queuedInlineWorkflowStartFlushScheduled = false;
  // Settle any `defer: false` awaiters for starts discarded by a synchronous
  // dispose. The run never became live, but its awaiter must not hang on a
  // torn-down engine. (asyncDispose drains these instead of discarding them.)
  const discarded = internals.queuedInlineWorkflowStarts;
  internals.queuedInlineWorkflowStarts = [];
  settleDiscardedInlineStarts(internals, discarded);
  // Belt-and-suspenders full reset: the helper already cleared each discarded
  // start's id, but a total clear guards against any index entry without a
  // matching queued start.
  internals.queuedInlineWorkflowStartIds.clear();
  internals.queuedOrLaunchingInlineWorkflowStartIds.clear();

  const channel = internals.queuedInlineWorkflowStartChannel;
  if (channel !== null) {
    channel.port1.close();
    channel.port2.close();
    internals.queuedInlineWorkflowStartChannel = null;
  }
}

export function hasQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.queuedInlineWorkflowStartIds.has(workflowId);
}

export function hasQueuedOrLaunchingInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.queuedOrLaunchingInlineWorkflowStartIds.has(workflowId);
}

function workflowStatusCanRetainLocalOwnership(workflowStatus: string): boolean {
  return workflowStatus === 'running' || workflowStatus === 'pending';
}

export function isInlineWorkflowLocallyOwned(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  if (!workflowStatusCanRetainLocalOwnership(workflowStatus)) {
    return false;
  }

  if (hasQueuedOrLaunchingInlineWorkflowStart(internals, workflowId)) {
    return true;
  }

  if (internals.inlineStrategy === null) {
    return false;
  }

  return (
    internals.inlineStrategy.getContext(workflowId) !== undefined ||
    internals.inlineStrategy.waitForWorkflowTurn(workflowId) !== undefined ||
    internals.parkedInlineWorkflows.has(workflowId)
  );
}

export function hasLocalCheckpointOwnership(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  return (
    internals.checkpoints.has(workflowId) && workflowStatusCanRetainLocalOwnership(workflowStatus)
  );
}
