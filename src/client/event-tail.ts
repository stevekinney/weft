/**
 * The client-facing live event tail contract. Both library mode
 * ({@link LocalClient}, via the in-process engine feed) and server mode
 * ({@link HttpClient}, via the `/watch` WebSocket channel) return a value
 * implementing this interface from their `tail()` methods.
 *
 * @module client/event-tail
 */

import type { WorkflowEvent } from '../core/types.ts';

/**
 * A live workflow-event tail. Async-iterate it to consume events as they are
 * produced; the iteration terminates cleanly when the workflow reaches a
 * terminal state, the server closes the stream, or {@link WorkflowEventTail.close}
 * is called.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient, type WorkflowEventTail } from 'weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * const client = new LocalClient(engine);
 * const handle = await client.start('ping', null);
 * const tail: WorkflowEventTail = client.tail(handle.id);
 * await tail.whenConnected();
 * for await (const event of tail) {
 *   console.log(event.type);
 * }
 * ```
 */
export interface WorkflowEventTail extends AsyncIterable<WorkflowEvent> {
  /** Stop the tail and release its resources. Idempotent. */
  close(): void;

  /**
   * Resolves once the tail is live and ready to deliver events (or when it has
   * terminated). Await this before triggering work whose events you intend to
   * observe, so nothing is missed in the window before the underlying transport
   * connects. In library mode it resolves immediately — the in-process engine
   * stream is live from construction.
   */
  whenConnected(): Promise<void>;
}
