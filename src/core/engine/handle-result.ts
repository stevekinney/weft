import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { EngineDisposedError } from './errors.ts';
import { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowResult, loadWorkflowState } from './storage-io.ts';

export function createWorkflowHandleWithResultPromise(
  internals: EngineInternals,
  workflowId: string,
): WorkflowHandle {
  const handle = new WorkflowHandle(workflowId, internals.engine);
  cacheHandle(internals, workflowId, handle);
  return handle;
}

export function createWorkflowResultWaiter(
  internals: EngineInternals,
  workflowId: string,
): WorkflowResultWaiter {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const waiter = { promise, resolve, reject };
  internals.resultResolvers.set(workflowId, waiter);
  void promise.catch(() => {});
  return waiter;
}

export function getWorkflowResultPromise(
  internals: EngineInternals,
  workflowId: string,
): Promise<unknown> {
  const existingWaiter = internals.resultResolvers.get(workflowId);
  if (existingWaiter) {
    return existingWaiter.promise;
  }

  // A result() call after disposal would otherwise register a fresh waiter in a
  // map the torn-down engine can never settle (the bootstrap returns without
  // resolving for a still-running workflow). Reject up front instead of leaking
  // a promise that never settles. Mirrors disposeEngine rejecting in-flight
  // waiters.
  if (internals.disposed) {
    const rejected = Promise.reject(new EngineDisposedError());
    // Attach a no-op catch so a caller that wires up its own handler in a later
    // microtask (or drops the promise) does not trip an unhandled-rejection
    // warning, matching the guard on waiter promises in createWorkflowResultWaiter.
    void rejected.catch(() => {});
    return rejected;
  }

  const waiter = createWorkflowResultWaiter(internals, workflowId);
  void bootstrapWorkflowResultResolver(internals, workflowId, waiter).then(() =>
    scheduleCrossEngineResultPollIfPending(internals, workflowId, waiter),
  );
  return waiter.promise;
}

/**
 * Closes the cross-engine parent/child completion gap ADR 0002 § Open
 * questions names as a blocking correctness gap: `WorkflowHandle.result()`
 * (the sole production path here, per `[HANDLE_RESULT_PROMISE]` in
 * `index.ts` — used for BOTH top-level handles and `ctx.startChild()`'s
 * default `parentClosePolicy: 'await'`) settles purely through the in-memory
 * `resultResolvers` map, which only `termination/complete.ts`'s terminal
 * paths on the OWNING engine ever resolve. Under `ownership: 'workflow-lease'`
 * a workflow can terminate on a DIFFERENT engine than the one holding this
 * waiter — e.g. a parent's owner crashes mid-await (an in-flight
 * `ctx.startChild()` await is never checkpointed, so nothing marks it
 * "parked"; replay re-runs it from scratch) and a successor engine takes over
 * the parent while some other engine independently takes over the still-
 * running child. That successor's in-memory map is never touched by the
 * child's eventual termination, so the parent would hang forever without
 * this poll.
 *
 * This is ADR 0002's "durable child-terminal notification the parent's owner
 * can observe" option, realized as owner-side polling of the child's own
 * persisted `WorkflowState` — the same accepted shape the ADR already uses
 * for cross-engine signal delivery (`owner-side-signal-poll.ts`) — rather
 * than the alternative "child always claimed by its parent's owner" rule.
 * The latter is only true by construction at LAUNCH time (the engine driving
 * the parent's turn is the one that calls `start()` for the child); it is
 * NOT preserved across an independent crash-and-reclaim of parent versus
 * child, and enforcing that through takeover lives in the claim-registry/
 * renewal-task machinery this stage does not own. Polling needs none of
 * that: it only re-reads the already-durable terminal state any workflow's
 * own termination commit already writes, using the EXISTING, idempotent
 * {@link bootstrapWorkflowResultResolver} as its re-check — no new durable
 * record, no new `EngineInternals` field (state lives in this closure, not
 * on `internals`), and no `index.ts`/`internals.ts`/renewal-task changes.
 *
 * Deliberately polls even when THIS engine's own claim registry currently
 * tracks `workflowId`: local ownership at waiter-creation time proves
 * nothing about ownership at the moment the awaited workflow actually
 * terminates (a live claim can still be lost to `renew`'s self-deposition
 * before then). The only safe stop conditions are the waiter settling or
 * being replaced (`internals.resultResolvers.get(workflowId) !== waiter`)
 * — which also covers engine disposal for free: {@link disposeEngine} is
 * fully synchronous and rejects+clears every `resultResolvers` entry before
 * any other code can run, so no separate `internals.disposed` check can ever
 * observe disposal without this map check already having caught it too.
 * Inert under `ownership: 'none'`/`'lease'`, where no claim registry is
 * installed at all.
 */
function scheduleCrossEngineResultPollIfPending(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return;
  if (internals.resultResolvers.get(workflowId) !== waiter) return;
  // `backgroundTasks: 'manual'` is documented to start no timers at all; that
  // mode drives this through an awaited `runMaintenance()` instead.
  if (internals.options.backgroundTaskMode !== 'automatic') return;
  // Only a workflow this engine does NOT hold can terminate somewhere else
  // without touching this resolver map. When the claim is local — the common
  // case, since every `ctx.startChild()` await is for a workflow this engine
  // just started — our own terminal path settles the waiter and re-reading
  // state on a timer would be pure overhead.

  const handle = setTimeout(() => {
    void bootstrapWorkflowResultResolver(internals, workflowId, waiter).then(() =>
      scheduleCrossEngineResultPollIfPending(internals, workflowId, waiter),
    );
  }, internals.options.workflowClaimRenewIntervalMs);
  // Never let a pending cross-engine poll hold an otherwise-idle process open,
  // matching the renewal task's own interval handling.
  (handle as { unref?: () => void }).unref?.();
}

/**
 * Settle result waiters for workflows this engine does not own, whose terminal
 * transition lands on another engine and so never touches this engine's
 * in-memory resolver map.
 *
 * Exported for `backgroundTasks: 'manual'`, where no timer runs and the host
 * drives every background step through an awaited `runMaintenance()`.
 */
export async function pollPendingCrossEngineResultWaiters(
  internals: EngineInternals,
): Promise<void> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return;

  // Snapshot first: settling a waiter deletes it from the live map, and
  // mutating a Map mid-iteration can skip entries.
  const pending = Array.from(internals.resultResolvers.entries());
  for (const [workflowId, waiter] of pending) {
    if (registry.currentEpoch(workflowId) !== null) continue;
    try {
      await bootstrapWorkflowResultResolver(internals, workflowId, waiter);
    } catch {
      // Best effort: one unreadable workflow must not stop the others from
      // settling on this tick, and the next tick retries it.
    }
  }
}

export async function bootstrapWorkflowResultResolver(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): Promise<void> {
  try {
    const state = await loadWorkflowState(internals, workflowId);
    if (linkToReplacementWaiter(internals, workflowId, waiter)) {
      return;
    }

    if (!state) {
      internals.resultResolvers.delete(workflowId);
      waiter.reject(new Error(`Workflow "${workflowId}" not found in storage`));
      return;
    }

    // A suspended workflow has not produced a result and will be resumed later,
    // so the waiter must stay pending — same as running/pending. (For a waiter
    // created before suspend, the existing-waiter branch above already keeps it
    // pending; this covers a fresh result() call made while suspended.)
    if (state.status === 'running' || state.status === 'pending' || state.status === 'suspended') {
      return;
    }

    try {
      const result = await loadWorkflowResult(internals, workflowId);
      clearResultWaiter(internals, workflowId, waiter);
      waiter.resolve(result);
    } catch (error) {
      clearResultWaiter(internals, workflowId, waiter);
      waiter.reject(error);
    }
  } catch (error) {
    clearResultWaiter(internals, workflowId, waiter);
    waiter.reject(error);
  }
}

function linkToReplacementWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): boolean {
  const currentWaiter = internals.resultResolvers.get(workflowId);
  if (currentWaiter === undefined || currentWaiter === waiter) {
    return false;
  }

  void currentWaiter.promise.then(waiter.resolve, waiter.reject);
  return true;
}

function clearResultWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  if (internals.resultResolvers.get(workflowId) === waiter) {
    internals.resultResolvers.delete(workflowId);
  }
}

export function cacheHandle(
  internals: EngineInternals,
  workflowId: string,
  handle: WorkflowHandle,
): void {
  const existing = internals.handleCache.get(workflowId);
  if (existing) {
    internals.finalizationRegistry.unregister(existing.unregisterToken);
  }
  const unregisterToken = {};
  internals.handleCache.set(workflowId, {
    ref: new WeakRef(handle),
    unregisterToken,
  });
  internals.finalizationRegistry.register(handle, workflowId, unregisterToken);
}
