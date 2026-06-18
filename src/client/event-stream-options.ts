import type { WebSocketFactory } from './event-stream-transport.ts';

/**
 * Transport preference for live workflow event subscriptions opened by
 * {@link HttpClient}. `auto` keeps the WebSocket watch channel as the default
 * and falls back to fetch-based SSE only when WebSocket construction cannot
 * carry the required authentication headers.
 *
 * @example
 * ```ts
 * import { type WorkflowEventTransport } from '@lostgradient/weft';
 *
 * const transport: WorkflowEventTransport = 'sse';
 * void transport;
 * ```
 */
export type WorkflowEventTransport = 'auto' | 'websocket' | 'sse';

/**
 * Options for opening a live workflow event subscription from an
 * {@link HttpClient} or {@link HttpHandle}. These options apply to
 * `client.tail(id)`, `handle.tail()`, and handle event listeners.
 *
 * @example
 * ```ts
 * import { HttpClient, type WorkflowEventStreamOptions } from '@lostgradient/weft';
 *
 * const eventStreamOptions: WorkflowEventStreamOptions = {
 *   eventTransport: 'sse',
 * };
 *
 * const client = new HttpClient({
 *   baseUrl: 'http://localhost:7233',
 *   eventTransport: eventStreamOptions.eventTransport,
 * });
 * void client;
 * ```
 */
export type WorkflowEventStreamOptions = {
  /** Live event transport selection. Default `auto`. */
  readonly eventTransport?: WorkflowEventTransport;
  /** Maximum reconnect attempts after a dropped socket. Default 5. */
  readonly maxReconnectAttempts?: number;
  /** Base reconnect backoff in milliseconds. Default 50. */
  readonly reconnectBackoffMs?: number;
  /**
   * Constructor override for the underlying socket. Tests inject a fake here;
   * production omits it and the global `WebSocket` is used.
   */
  readonly webSocketFactory?: WebSocketFactory;
  /**
   * Buffer events for async iteration from construction rather than lazily on
   * first iterator pull. `tail()` sets this so the documented
   * `await tail.whenConnected(); for await (...)` pattern still sees the connect
   * catch-up history (which is emitted before the `for await` loop begins).
   * Callback-only subscribers (`HttpHandle.addEventListener`) leave it off so
   * the iterator buffer never accumulates a never-drained queue. Default false.
   */
  readonly bufferForIteration?: boolean;
};
