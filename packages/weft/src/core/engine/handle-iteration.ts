import type { WeftEventMap } from '../events/event-map.ts';
import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../events/workflow-events.ts';
import type { WorkflowState } from '../types.ts';
import { WeftError } from '../weft-error.ts';

/**
 * The most events one handle iterator holds for a consumer that has not pulled
 * them yet. It matches the server's per-subscriber live buffer
 * (`DEFAULT_LIVE_BUFFER_SIZE` in `server/workflow-event-feed.ts`), and overflow
 * is handled the same way: the iterator stops buffering and ends with an error
 * instead of growing for the rest of the workflow's life.
 */
export const WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT = 1000;

/**
 * Thrown by a workflow handle's event iterator once its consumer has fallen
 * more than {@link WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT} events behind. The
 * events buffered before the overflow are yielded first; `droppedCount` is how
 * many arrived after the buffer filled and were discarded, the terminal event
 * among them if it arrived. Read `handle.result()` or the persisted history to
 * learn how the workflow ended.
 */
export class WorkflowHandleEventOverflowError extends WeftError<'WorkflowHandleEventOverflowError'> {
  /** Events discarded after the buffer filled. */
  readonly droppedCount: number;
  /** The buffer limit the consumer exceeded. */
  readonly limit: number;

  constructor(droppedCount: number, limit: number) {
    super(
      'WorkflowHandleEventOverflowError',
      `Workflow handle event iterator overflowed: the consumer fell more than ${String(limit)} ` +
        `events behind and ${String(droppedCount)} later events were dropped.`,
    );
    this.droppedCount = droppedCount;
    this.limit = limit;
  }
}

type WorkflowHandleEventQueue = {
  events: Event[];
  /** Events discarded because `events` was already at the buffer limit. */
  droppedCount: number;
  resolver: (() => void) | undefined;
};

type WorkflowHandleIteratorState = {
  done: boolean;
};

/**
 * Every event kind in {@link WeftEventMap}. `satisfies` makes the record
 * exhaustive: a new kind added to the map fails type-checking here until it is
 * listed, so the handle iterator can never silently miss an event kind the
 * engine forwards to the handle. Subscribing to an engine-scoped kind (one
 * without a `workflowId`, such as `catalog:*`) is harmless, because the engine
 * forwards only events that name the handle's workflow.
 */
const WEFT_EVENT_KINDS = {
  'workflow:definition-registered': true,
  'workflow:started': true,
  'workflow:completed': true,
  'workflow:failed': true,
  'workflow:cancelled': true,
  'workflow:timed-out': true,
  'workflow:resumed': true,
  'workflow:suspended': true,
  'workflow:recovery-skipped': true,
  'workflow:teardown': true,
  'activity:started': true,
  'activity:completed': true,
  'activity:failed': true,
  'activity:async-pending': true,
  'activity:remote-queued': true,
  'activity:remote-cancellation-requested': true,
  'task:dead-lettered': true,
  'task:result-delivery': true,
  'task:attempt-transition': true,
  'signal:received': true,
  'signal:waiting': true,
  'signal:delivered': true,
  'schedule:fired': true,
  'human-review:requested': true,
  'human-review:completed': true,
  'attributes:changed': true,
  'schedule:missed-fire': true,
  'schedule:attempted': true,
  'schedule:skipped': true,
  'update:received': true,
  'update:completed': true,
  'checkpoint:size-warning': true,
  'development:warning': true,
  'cleanup:warning': true,
  'storage:size-reported': true,
  'worker:connected': true,
  'worker:disconnected': true,
  'alert:fired': true,
  'alert:resolved': true,
  'constraint:violated': true,
  'catalog:revision-installed': true,
  'catalog:revision-activated': true,
  'catalog:activation-rejected': true,
  'catalog:revision-draining': true,
  'catalog:revision-removed': true,
  'workflow-source:load-started': true,
  'workflow-source:load-ready': true,
  'workflow-source:load-failed': true,
  'workflow-source:load-cancelled': true,
  'realm:state-changed': true,
  'lease:health-changed': true,
  'worker:registration-rejected': true,
  'worker:deployment-changed': true,
  'stream:chunk': true,
  'queue:depth-changed': true,
} as const satisfies Record<keyof WeftEventMap, true>;

// The terminal lifecycle types come from the shared source of truth so the
// engine's handle iterator and both client transports stay in lockstep.
const WORKFLOW_HANDLE_TERMINAL_EVENT_TYPES = WORKFLOW_TERMINAL_EVENT_TYPES;

const WORKFLOW_HANDLE_NON_TERMINAL_EVENT_TYPES: readonly string[] = Object.keys(
  WEFT_EVENT_KINDS,
).filter((type) => !WORKFLOW_HANDLE_TERMINAL_EVENT_TYPES.has(type));

/**
 * Iterate a workflow handle's events: every workflow-scoped event the engine
 * dispatches for the workflow after iteration starts, in dispatch order, ending
 * with its terminal event.
 *
 * Replay contract: the iterator replays nothing it did not observe, except the
 * terminal event. Like any `EventTarget` listener, it sees only events
 * dispatched after its listeners attach (on the first `next()`); a non-terminal
 * event dispatched before then is not delivered. When the workflow has already
 * finished, the terminal event is synthesized from persisted state so iteration
 * still ends. Callers that need earlier events read the persisted history (the
 * local client tail replays `engine.getEvents` for this).
 *
 * Buffering: events wait in an in-order FIFO queue per iterator until the
 * consumer pulls them, and the queue is released when iteration ends. The
 * engine never waits on a slow consumer; instead the queue is bounded at
 * {@link WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT} events. Once it is full, later
 * events are dropped and counted, and after yielding what it buffered the
 * iterator throws a {@link WorkflowHandleEventOverflowError}. A consumer that
 * stops pulling, or abandons the iterator without calling `return()`, therefore
 * holds at most that many events.
 */
export async function* createWorkflowHandleEventIterator(
  handle: EventTarget,
  loadWorkflowState: () => Promise<WorkflowState | null>,
  synthesizeTerminalEvent: (state: WorkflowState) => Event | null,
): AsyncIterableIterator<Event> {
  const queue: WorkflowHandleEventQueue = { events: [], droppedCount: 0, resolver: undefined };
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

    while (true) {
      while (queue.events.length > 0) {
        yield queue.events.shift()!;
      }
      if (queue.droppedCount > 0) {
        throw new WorkflowHandleEventOverflowError(
          queue.droppedCount,
          WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT,
        );
      }
      if (state.done) return;
      await waitForWorkflowHandleIteratorEvent(queue);
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
  const listener = enqueueNonTerminalWorkflowHandleEvent.bind(undefined, state, queue);
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

// Iteration ends with the terminal event, so an event dispatched after it (a
// `workflow:teardown`, a late cleanup warning) is not queued behind it.
function enqueueNonTerminalWorkflowHandleEvent(
  state: WorkflowHandleIteratorState,
  queue: WorkflowHandleEventQueue,
  event: Event,
): void {
  if (state.done) return;
  enqueueWorkflowHandleEvent(queue, event);
}

function enqueueWorkflowHandleEvent(queue: WorkflowHandleEventQueue, event: Event): void {
  // Once one event has been dropped, keep dropping, so the consumer never sees
  // a gap followed by later events as if nothing were missing.
  if (queue.droppedCount > 0 || queue.events.length >= WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT) {
    queue.droppedCount += 1;
  } else {
    queue.events.push(event);
  }
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

  finishWorkflowHandleIteration(state, queue, synthetic);
}

async function waitForWorkflowHandleIteratorEvent(queue: WorkflowHandleEventQueue): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queue.resolver = resolve;
  await promise;
  queue.resolver = undefined;
}
