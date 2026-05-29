/**
 * Test-only fake WebSocket for the `/watch` channel the
 * {@link WorkflowEventSubscription} consumes. Build a {@link FakeWebSocketServer}
 * and hand its {@link FakeWebSocketServer.factory} to `HttpClient`'s
 * `webSocketFactory` option so live event streaming runs without a real socket.
 *
 * The watch channel is unidirectional server → client: the client never sends
 * frames, so the fake only needs to deliver events and simulate drops/opens.
 *
 * @module client/event-stream.test-support
 */

import type { WorkflowEvent } from '../core/types.ts';
import type { StreamSocket, WebSocketFactory } from './event-stream-transport.ts';

type Listeners = {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  close: Array<() => void>;
  error: Array<(event: unknown) => void>;
};

/** A single fake `/watch` socket the {@link WorkflowEventSubscription} drives. */
export class FakeWebSocket implements StreamSocket {
  readonly #listeners: Listeners = { open: [], message: [], close: [], error: [] };
  readonly url: string;
  closed = false;
  opened = false;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: keyof Listeners, listener: (event: { data: unknown }) => void): void {
    // The union of listener shapes is intentionally loose for the fake.
    (this.#listeners[type] as Array<(event: { data: unknown }) => void>).push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#listeners.close) listener();
  }

  /** Fire the `open` handlers (call once the socket is "connected"). */
  fireOpen(): void {
    this.opened = true;
    for (const listener of this.#listeners.open) listener();
  }

  /** Deliver one workflow event as a watch-channel frame. */
  deliver(event: WorkflowEvent): void {
    const data = JSON.stringify(event);
    for (const listener of this.#listeners.message) listener({ data });
  }

  /** Simulate the socket dropping (transport-level disconnect). */
  drop(): void {
    this.close();
  }
}

/**
 * Tracks every {@link FakeWebSocket} a subscription opens (reconnects produce
 * new sockets) and exposes a {@link WebSocketFactory} to inject into the client.
 */
export class FakeWebSocketServer {
  readonly sockets: FakeWebSocket[] = [];
  /** Auto-fire `open` on construction. Set false to control timing in tests. */
  autoOpen = true;

  readonly factory: WebSocketFactory = (url) => {
    const socket = new FakeWebSocket(url);
    this.sockets.push(socket);
    if (this.autoOpen) {
      // Open on the next microtask so the subscription has wired its listeners.
      queueMicrotask(() => socket.fireOpen());
    }
    return socket;
  };

  /** The most recently created socket. */
  latest(): FakeWebSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('no socket created yet');
    return socket;
  }
}
