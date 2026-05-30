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

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    // The engine handle's async iterator removes its listeners in its own
    // `finally`; calling `return()` drives that teardown.
    void iterator.return?.(undefined);
  }

  return {
    close,
    // The in-process engine stream is live from construction — the handle's
    // event iterator attaches its listeners synchronously and synthesizes the
    // terminal event if the workflow already finished — so there is nothing to
    // wait for.
    whenConnected: () => Promise.resolve(),
    async *[Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
      try {
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
          const event = serializeEngineEvent(next.value);
          yield event;
          if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) return;
        }
      } finally {
        close();
      }
    },
  };
}
