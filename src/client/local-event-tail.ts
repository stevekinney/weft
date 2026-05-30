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
 * Like the HTTP tail, the local tail also replays the workflow's persisted
 * event history on connect (via `engine.getEvents`) so a tail opened after
 * events were already persisted still delivers them — the two transports honor
 * the same unified catch-up contract — deduping the overlap window so an event
 * present in both the replayed history and the live stream is delivered once.
 *
 * @module client/local-event-tail
 */

import type { Engine } from '../core/engine.ts';
import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../core/events/workflow-events.ts';
import type { WorkflowEvent } from '../core/types.ts';
import { dropOverlappingLiveFrames } from './event-stream-transport.ts';
import type { WorkflowEventTail } from './event-tail.ts';

/**
 * Serialize a dispatched engine `Event` into a {@link WorkflowEvent}. Mirrors
 * the server's watch-channel serialization exactly: every own-property except
 * `type` is copied into `data`, with `Error` values flattened to their message,
 * then the bag is passed through a JSON round-trip — the same one the server's
 * `serializeEvent` + WebSocket transport applies. That round-trip drops
 * `undefined`-valued properties (e.g. a signal delivered with no payload yields
 * no `payload` key, just like the HTTP tail), so library mode and server mode
 * produce identical {@link WorkflowEvent} records.
 */
function serializeEngineEvent(event: Event): WorkflowEvent {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    raw[key] = value instanceof Error ? value.message : value;
  }
  // JSON round-trip to match the server transport: drops `undefined` values and
  // normalizes the bag to the same shape the HTTP tail receives off the wire.
  const data = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  return { type: event.type, timestamp: Date.now(), data };
}

/**
 * Build a {@link WorkflowEventTail} backed by the in-process engine. The tail
 * replays the workflow's persisted event history on connect, then delivers live
 * lifecycle/activity events until the workflow reaches a terminal state or
 * {@link WorkflowEventTail.close} is called. If the workflow has already
 * finished, the persisted history ends with the terminal event so the tail
 * still terminates cleanly.
 */
export function createLocalWorkflowEventTail(
  engine: Engine,
  workflowId: string,
): WorkflowEventTail {
  const handle = engine.getHandle(workflowId);
  const iterator = handle[Symbol.asyncIterator]();

  // `output` holds events ready for the consumer. Live engine events are routed
  // through `deliverLive`, which buffers them only while the history catch-up is
  // in flight; once catch-up has run, the buffered frames are reconciled against
  // history (the overlap window) exactly once and every subsequent live frame is
  // emitted directly. Mirrors the HTTP tail, which likewise dedups only frames
  // buffered during the fetch — never all future live frames, so a legitimate
  // repeated signal/activity after catch-up is not dropped as a false overlap.
  const output: WorkflowEvent[] = [];
  const pendingLive: WorkflowEvent[] = [];
  let catchUpDone = false;
  let terminated = false;
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

  function emit(event: WorkflowEvent): void {
    if (terminated) return;
    output.push(event);
    wake();
    if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) terminated = true;
  }

  // Deliver a live engine event: buffer while the catch-up is in flight (the
  // `connected` IIFE reconciles the buffer against history once it resolves);
  // after catch-up, emit directly with no further dedup so legitimate repeated
  // events are never dropped.
  function deliverLive(event: WorkflowEvent): void {
    if (!catchUpDone) {
      pendingLive.push(event);
      return;
    }
    emit(event);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // The engine handle's async iterator removes its listeners in its own
    // `finally`; calling `return()` drives that teardown.
    void iterator.return?.(undefined);
    wake();
  }

  // Eagerly attach the live engine listener. The handle's iterator is an async
  // generator whose body — including its `addEventListener` calls — only runs on
  // the first `next()`, so we pump it from construction. The first `next()` runs
  // the generator body synchronously up to its first `await`, attaching the
  // listeners before this function returns; that closes the gap where events
  // emitted between `client.tail(id)` and the start of iteration would otherwise
  // be missed (the HTTP tail buffers from construction too).
  const pump = (async (): Promise<void> => {
    try {
      for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
        if (closed) return;
        deliverLive(serializeEngineEvent(next.value));
        if (terminated) return;
      }
    } catch (error) {
      pumpError = error;
    } finally {
      pumpDone = true;
      // Drive the engine iterator's own `finally` so its listeners are removed
      // once the pump stops draining. Idempotent with the consumer's `close()`;
      // does not clear `output`, so any frames already queued are still
      // delivered to a consumer that starts iterating later.
      void iterator.return?.(undefined);
      wake();
    }
  })();
  // The pump owns iterator teardown; swallow its settled promise so an
  // unconsumed tail never surfaces an unhandled rejection.
  void pump.catch(() => {});

  // Replay persisted history on connect, then release the buffered live events
  // through the same overlap dedup. Mirrors the HTTP tail's reconciliation.
  const connected = (async (): Promise<void> => {
    let history: WorkflowEvent[] = [];
    try {
      history = await engine.getEvents(workflowId);
    } catch {
      // A failed history fetch must not kill the stream; fall through so the
      // buffered live events still drain and live delivery resumes.
      history = [];
    }
    if (closed) return;

    for (const event of history) {
      emit(event);
      if (terminated) break;
    }

    // Drain the frames buffered during the fetch, dropping the overlap with the
    // history just replayed (the consuming dedup keeps a genuinely-new repeat),
    // then flip to direct live delivery for all subsequent frames.
    const buffered = pendingLive.splice(0, pendingLive.length);
    const fresh = terminated ? [] : dropOverlappingLiveFrames(history, buffered);
    catchUpDone = true;
    for (const live of fresh) {
      if (terminated) break;
      emit(live);
    }
    wake();
  })();
  void connected.catch(() => {});

  return {
    close,
    // The local stream is live once the connect catch-up has replayed history
    // (matching the HTTP tail, where `whenConnected` resolves after the first
    // catch-up). Resolving only after catch-up — rather than immediately — means
    // a caller that awaits it before triggering work still sees the replayed
    // history ahead of any live frame.
    whenConnected: () => connected,
    async *[Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
      try {
        while (true) {
          while (output.length > 0) {
            const event = output.shift()!;
            yield event;
            if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) return;
          }
          if (pumpError !== null) throw pumpError;
          if (closed) return;
          // End iteration only once the output queue is drained AND no more
          // events are coming: the pump finished and catch-up has run (so no
          // buffered history is still pending).
          if (pumpDone && catchUpDone) return;
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
