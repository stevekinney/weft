/**
 * Library-mode live workflow-event tail for {@link LocalClient}.
 *
 * Server mode rides the `/watch` WebSocket channel; library mode has the engine
 * in-process, so it iterates the engine's own {@link WorkflowHandle} event
 * stream — the same primitive `handle.addEventListener` already uses — and maps
 * each dispatched `Event` into the transport-neutral {@link WorkflowEvent}
 * record (`{ type, timestamp, data }`). That mapping mirrors the server's
 * watch-channel serialization, so both clients deliver the same event records
 * and terminate on the same lifecycle events; only the wire in between differs.
 *
 * @module client/local-event-tail
 */

import type { Engine } from '../core/engine.ts';
import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../core/events/workflow-events.ts';
import type { WorkflowEvent } from '../core/types.ts';
import type { WorkflowEventTail } from './event-tail.ts';

/**
 * Serialize a dispatched engine `Event` into a {@link WorkflowEvent}. Mirrors
 * the server's watch-channel serialization: every own-property except `type`
 * is copied into `data`, with `Error` values flattened to their message so the
 * record survives a JSON round-trip on the server transport.
 */
function serializeEngineEvent(event: Event): WorkflowEvent {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    data[key] = value instanceof Error ? value.message : value;
  }
  return { type: event.type, timestamp: Date.now(), data };
}

/**
 * Build a {@link WorkflowEventTail} backed by the in-process engine. The tail
 * delivers live lifecycle/activity events until the workflow reaches a terminal
 * state or {@link WorkflowEventTail.close} is called. If the workflow has
 * already finished, the engine handle synthesizes the terminal event so the
 * tail still terminates cleanly.
 */
export function createLocalWorkflowEventTail(
  engine: Engine,
  workflowId: string,
): WorkflowEventTail {
  const handle = engine.getHandle(workflowId);
  const iterator = handle[Symbol.asyncIterator]();

  // The engine handle's iterator is an async generator: its body — including
  // the `addEventListener` calls that attach the listeners — does not run until
  // the first `next()`. If we waited for `for await` to drive that, any event
  // emitted between `client.tail(id)` and the start of iteration would be missed
  // (the listeners would not yet exist), so the local tail would not match the
  // HTTP tail's buffering contract. To close that gap we pump the iterator
  // eagerly from construction and buffer the events ourselves: the first
  // `next()` runs the generator body synchronously up to its first `await`,
  // attaching the listeners before this function returns.
  const buffer: WorkflowEvent[] = [];
  let pumpDone = false;
  let pumpError: unknown = null;
  let closed = false;
  let waker: (() => void) | null = null;

  function wake(): void {
    const resolve = waker;
    if (resolve !== null) {
      waker = null;
      resolve();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // The engine handle's async iterator removes its listeners in its own
    // `finally`; calling `return()` drives that teardown.
    void iterator.return?.(undefined);
    wake();
  }

  // Eagerly drain the engine iterator into `buffer`. Started synchronously so
  // listeners attach on this microtask, before the caller awaits
  // `whenConnected()` or begins iterating.
  const pump = (async (): Promise<void> => {
    try {
      for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
        if (closed) return;
        const event = serializeEngineEvent(next.value);
        buffer.push(event);
        wake();
        if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) return;
      }
    } catch (error) {
      pumpError = error;
    } finally {
      pumpDone = true;
      // Drive the engine iterator's own `finally` so its listeners are removed
      // once the pump stops draining (terminal event reached, stream exhausted,
      // or an error). Idempotent with the consumer's `close()` in its `finally`;
      // does not clear `buffer`, so any frames already buffered (e.g. a terminal
      // event) are still delivered to a consumer that starts iterating later.
      void iterator.return?.(undefined);
      wake();
    }
  })();
  // The pump owns iterator teardown; swallow its settled promise so an
  // unconsumed tail never surfaces an unhandled rejection.
  void pump.catch(() => {});

  return {
    close,
    // The in-process engine stream is live from construction — the eager pump
    // above has already attached the handle's listeners and will synthesize the
    // terminal event if the workflow already finished — so there is nothing to
    // wait for.
    whenConnected: () => Promise.resolve(),
    async *[Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
      try {
        while (true) {
          while (buffer.length > 0) {
            yield buffer.shift()!;
          }
          if (pumpError !== null) throw pumpError;
          if (pumpDone || closed) return;
          await new Promise<void>((resolve) => {
            waker = resolve;
          });
        }
      } finally {
        close();
      }
    },
  };
}
