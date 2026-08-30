import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../events/workflow-events.ts';
import type { WorkflowState } from '../types.ts';

type WorkflowHandleEventQueue = {
  events: Event[];
  resolver: (() => void) | undefined;
};

type WorkflowHandleIteratorState = {
  done: boolean;
};

const WORKFLOW_HANDLE_NON_TERMINAL_EVENT_TYPES = [
  'activity:started',
  'activity:completed',
  'signal:received',
] as const;

// The terminal lifecycle types come from the shared source of truth so the
// engine's handle iterator and both client transports stay in lockstep.
const WORKFLOW_HANDLE_TERMINAL_EVENT_TYPES = WORKFLOW_TERMINAL_EVENT_TYPES;

export async function* createWorkflowHandleEventIterator(
  handle: EventTarget,
  loadWorkflowState: () => Promise<WorkflowState | null>,
  synthesizeTerminalEvent: (state: WorkflowState) => Event | null,
): AsyncIterableIterator<Event> {
  const queue: WorkflowHandleEventQueue = { events: [], resolver: undefined };
  const state = { done: false };
  const removeListeners = addWorkflowHandleIteratorListeners(handle, queue, state);

  try {
    if (!state.done) {
      synthesizeIteratorTerminalEvent(
        queue,
        state,
        await loadWorkflowState(),
        synthesizeTerminalEvent,
      );
    }

    while (!state.done || queue.events.length > 0) {
      if (queue.events.length === 0) {
        await waitForWorkflowHandleIteratorEvent(queue);
      }
      while (queue.events.length > 0) {
        yield queue.events.shift()!;
      }
    }
  } finally {
    removeListeners();
  }
}

function addWorkflowHandleIteratorListeners(
  handle: EventTarget,
  queue: WorkflowHandleEventQueue,
  state: WorkflowHandleIteratorState,
): () => void {
  const listener = enqueueWorkflowHandleEvent.bind(undefined, queue);
  const terminal = finishWorkflowHandleIteration.bind(undefined, state, queue);

  for (const type of WORKFLOW_HANDLE_NON_TERMINAL_EVENT_TYPES) {
    handle.addEventListener(type, listener);
  }
  for (const type of WORKFLOW_HANDLE_TERMINAL_EVENT_TYPES) {
    handle.addEventListener(type, terminal);
  }

  return () => {
    for (const type of WORKFLOW_HANDLE_NON_TERMINAL_EVENT_TYPES) {
      handle.removeEventListener(type, listener);
    }
    for (const type of WORKFLOW_HANDLE_TERMINAL_EVENT_TYPES) {
      handle.removeEventListener(type, terminal);
    }
  };
}

function enqueueWorkflowHandleEvent(queue: WorkflowHandleEventQueue, event: Event): void {
  queue.events.push(event);
  queue.resolver?.();
}

function finishWorkflowHandleIteration(
  state: WorkflowHandleIteratorState,
  queue: WorkflowHandleEventQueue,
  event: Event,
): void {
  if (state.done) return;
  state.done = true;
  enqueueWorkflowHandleEvent(queue, event);
}

function synthesizeIteratorTerminalEvent(
  queue: WorkflowHandleEventQueue,
  state: WorkflowHandleIteratorState,
  persisted: WorkflowState | null,
  synthesizeTerminalEvent: (state: WorkflowState) => Event | null,
): void {
  if (!persisted || state.done) return;

  const synthetic = synthesizeTerminalEvent(persisted);
  if (!synthetic) return;

  queue.events.push(synthetic);
  state.done = true;
}

async function waitForWorkflowHandleIteratorEvent(queue: WorkflowHandleEventQueue): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queue.resolver = resolve;
  await promise;
  queue.resolver = undefined;
}
