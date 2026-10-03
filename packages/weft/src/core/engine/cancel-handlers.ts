import type { ContextOptions } from '../context/types.ts';
import { createFinalizerStateRecorder } from './finalizer-state.ts';
import type { EngineInternals } from './internals.ts';

export type CancelHandler = () => Promise<void> | void;

export function registerCancelHandler(
  internals: EngineInternals,
  workflowId: string,
  handler: CancelHandler,
): () => void {
  internals.cancelHandlersByWorkflow ??= new Map();
  let handlers = internals.cancelHandlersByWorkflow.get(workflowId);
  if (handlers === undefined) {
    handlers = [];
    internals.cancelHandlersByWorkflow.set(workflowId, handlers);
  }
  handlers.push(handler);

  return () => {
    const currentHandlers = internals.cancelHandlersByWorkflow.get(workflowId);
    if (currentHandlers === undefined) return;

    const handlerIndex = currentHandlers.indexOf(handler);
    if (handlerIndex !== -1) {
      currentHandlers.splice(handlerIndex, 1);
    }

    if (currentHandlers.length === 0) {
      internals.cancelHandlersByWorkflow.delete(workflowId);
    }
  };
}

export function createCancelHandlerRegistration(
  internals: EngineInternals,
  workflowId: string,
): (handler: CancelHandler) => () => void {
  return (handler) => registerCancelHandler(internals, workflowId, handler);
}

/**
 * The per-workflow callbacks every engine-built `Context` needs from the engine:
 * cancel-handler registration and finalizer-state recording. Recovery/resume and
 * checkpoint-launch contexts spread this so they cannot drift from the inline start
 * path — a replayed workflow re-executes `ctx.setFinalizerState`, which throws when
 * `recordFinalizerState` is absent (COR-1413).
 */
export function createWorkflowScopedContextCallbacks(
  internals: EngineInternals,
  workflowId: string,
): Pick<ContextOptions, 'registerCancelHandler' | 'recordFinalizerState'> {
  return {
    registerCancelHandler: createCancelHandlerRegistration(internals, workflowId),
    recordFinalizerState: createFinalizerStateRecorder(internals, workflowId),
  };
}

export function resetCancelHandlers(internals: EngineInternals, workflowId: string): void {
  internals.cancelHandlersByWorkflow ??= new Map();
  internals.cancelHandlersByWorkflow.delete(workflowId);
}

export function takeCancelHandlers(
  internals: EngineInternals,
  workflowId: string,
): CancelHandler[] {
  internals.cancelHandlersByWorkflow ??= new Map();
  const handlers = internals.cancelHandlersByWorkflow.get(workflowId) ?? [];
  internals.cancelHandlersByWorkflow.delete(workflowId);
  return handlers;
}
