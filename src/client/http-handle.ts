import type { WeftEventMap } from '../core/events.ts';
import type { WorkflowEventSubscription } from './event-stream.ts';
import { WorkflowHandleDelegation } from './handle-delegation.ts';
import type { HttpClient } from './http-client.ts';
import { HttpClientError, request } from './http-request.ts';

/**
 * Server-mode workflow handle. Lifecycle events are delivered push-based over
 * the server's per-workflow `/v1/workflows/:id/watch` WebSocket channel rather
 * than by polling `getEvents()` on a timer — listeners fire the moment an event
 * lands on the server. Each delivered event is re-dispatched as a `CustomEvent`
 * whose `detail` is the event's `data`, matching the long-standing handle
 * contract.
 */
export class HttpHandle extends WorkflowHandleDelegation<HttpClient> {
  readonly #events = new EventTarget();
  #subscription: WorkflowEventSubscription | null = null;
  #closed = false;

  #ensureSubscribed(): WorkflowEventSubscription | null {
    if (this.#closed) return null;
    // Re-open when there is no subscription yet, or the cached one has
    // terminated (reconnect exhausted, or auto-closed on a terminal event). A
    // dead subscription opens no socket, so without this a caller that attaches
    // listeners after termination would silently receive nothing.
    if (this.#subscription === null || this.#subscription.closeReason !== null) {
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
