import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { EngineDisposedError } from './errors.ts';
import { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowResult, loadWorkflowState } from './storage-io.ts';

export function createWorkflowHandleWithResultPromise(
  internals: EngineInternals,
  workflowId: string,
): WorkflowHandle {
  const handle = new WorkflowHandle<unknown>(workflowId, internals.engine);
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
    void rejected.catch(() => {});
    return rejected;
  }

  const waiter = createWorkflowResultWaiter(internals, workflowId);
  void bootstrapWorkflowResultResolver(internals, workflowId, waiter);
  return waiter.promise;
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

    if (state.status === 'running' || state.status === 'pending') {
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
