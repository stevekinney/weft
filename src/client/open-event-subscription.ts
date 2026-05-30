/**
 * Opens a {@link WorkflowEventSubscription} from a client-like host.
 *
 * Splitting this concern out of `event-stream.ts` keeps the subscription class
 * file focused on the socket/catch-up/reconnect state machine. The host shape
 * and the `openClientEventSubscription` factory are the seam both `HttpHandle`
 * (push-based `addEventListener`) and `HttpClient.tail` use to turn a client
 * into a live `/watch` subscription.
 *
 * @module client/open-event-subscription
 */

import type { WorkflowEvent } from '../core/types.ts';
import { workflowWatchWebSocketUrl } from './event-stream-transport.ts';
import { WorkflowEventSubscription, type WorkflowEventStreamOptions } from './event-stream.ts';

/**
 * The streaming-relevant view of an HTTP client: the fields a workflow event
 * subscription needs to open its `/watch` socket and run `getEvents` catch-up.
 * `HttpClient` satisfies this structurally, so {@link openClientEventSubscription}
 * takes the client directly instead of an assembled context literal.
 */
export type WorkflowEventStreamHost = {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  getEvents(workflowId: string): Promise<WorkflowEvent[]>;
};

/**
 * Open a live {@link WorkflowEventSubscription} for a workflow over the `/watch`
 * WebSocket channel, wiring the watch URL and the `getEvents` catch-up fetch
 * from the given client. Shared by `HttpHandle` (push-based `addEventListener`)
 * and `HttpClient.tail`. Pass `bufferForIteration` for iteration-intended
 * consumers (`tail()`) so the connect catch-up is buffered for the async
 * iterator rather than dropped.
 */
export function openClientEventSubscription(
  host: WorkflowEventStreamHost,
  streamOptions: WorkflowEventStreamOptions,
  workflowId: string,
  onEvent: (event: WorkflowEvent) => void,
  bufferForIteration = false,
): WorkflowEventSubscription {
  return new WorkflowEventSubscription(
    workflowWatchWebSocketUrl(host.baseUrl, workflowId),
    host.headers,
    workflowId,
    (id) => host.getEvents(id),
    onEvent,
    bufferForIteration ? { ...streamOptions, bufferForIteration } : streamOptions,
  );
}
