import type { WeftEventMap } from '../core/events.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import { WorkflowHandleDelegation } from './handle-delegation.ts';
import type { HttpClient } from './http-client.ts';
import { HttpClientError, request } from './http-request.ts';

/**
 * Server-mode workflow handle. Lifecycle events are delivered push-based over
 * the server's per-workflow WebSocket or SSE event stream rather than by
 * polling `getEvents()` on a timer — listeners fire the moment an event lands
 * on the server. Each delivered event is re-dispatched as a `CustomEvent` whose
 * `detail` is the event's `data`, matching the long-standing handle contract.
 */
export class HttpHandle extends WorkflowHandleDelegation<HttpClient> {
  readonly #events = new EventTarget();
  #subscription: WorkflowEventTail | null = null;
  #closed = false;

  #ensureSubscribed(): WorkflowEventTail | null {
    if (this.#closed) return null;
    // Open once and cache for the handle's lifetime. We deliberately do NOT
    // re-open after the subscription terminates (workflow reached a terminal
    // event, or reconnects were exhausted): the catch-up replays the full
    // persisted history on connect, so a fresh subscription would re-dispatch
    // every already-delivered event to listeners still registered from before —
    // duplicate delivery. A terminal workflow emits nothing further, and an
    // exhausted reconnect means the server is unreachable; in both cases the
    // right recovery is a new handle (or `getEvents()` for history), not a
    // silent re-subscribe that double-fires existing listeners.
    if (this.#subscription === null) {
      this.#subscription = this.client.openEventSubscription(this.id, (event) => {
        this.#events.dispatchEvent(new CustomEvent(event.type, { detail: event.data }));
      });
    }
    return this.#subscription;
  }

  /**
   * Resolves once the handle's live event subscription is connected, so a
   * caller can attach listeners and then trigger work without missing the
   * events emitted in the window before the socket connects. Opens the
   * subscription if it is not already open.
   */
  override whenConnected(): Promise<void> {
    return this.#ensureSubscribed()?.whenConnected() ?? Promise.resolve();
  }

  /** Stop the event subscription and release resources. Cannot be restarted. */
  close(): void {
    this.#closed = true;
    if (this.#subscription !== null) {
      this.#subscription.close();
      this.#subscription = null;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  async result(): Promise<unknown> {
    const response = await request<{ result: unknown } | null>(
      this.client.baseUrl,
      `/workflows/${encodeURIComponent(this.id)}/result`,
      this.client.headers,
    );
    if (response === null) {
      throw new HttpClientError(404, `Workflow "${this.id}" not found`);
    }
    return response.result;
  }

  addEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#ensureSubscribed();
    this.#events.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#events.removeEventListener(type, listener, options);
  }
}
