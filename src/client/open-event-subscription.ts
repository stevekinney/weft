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
import { detectRuntime } from '../runtime/portable.ts';
import type { WorkflowEventStreamOptions } from './event-stream-options.ts';
import { workflowWatchWebSocketUrl } from './event-stream-transport.ts';
import { WorkflowEventSubscription } from './event-stream.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import { SseWorkflowEventSubscription, workflowEventsSseUrl } from './sse-event-stream.ts';

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
): WorkflowEventTail {
  const options = bufferForIteration ? { ...streamOptions, bufferForIteration } : streamOptions;
  const transport = options.eventTransport ?? 'auto';
  if (transport === 'sse') {
    return openSseEventSubscription(host, workflowId, onEvent, options);
  }
  if (shouldPreferServerSentEventsFallback(host, options, transport)) {
    return openSseEventSubscription(host, workflowId, onEvent, options);
  }
  try {
    return new WorkflowEventSubscription(
      workflowWatchWebSocketUrl(host.baseUrl, workflowId),
      host.headers,
      workflowId,
      (id) => host.getEvents(id),
      onEvent,
      options,
    );
  } catch (error) {
    if (transport !== 'auto') throw error;
    if (!isWebSocketTransportUnavailable(error)) throw error;
    return openSseEventSubscription(host, workflowId, onEvent, options);
  }
}

function shouldPreferServerSentEventsFallback(
  host: WorkflowEventStreamHost,
  options: WorkflowEventStreamOptions,
  transport: WorkflowEventStreamOptions['eventTransport'],
): boolean {
  return (
    transport === 'auto' &&
    options.webSocketFactory === undefined &&
    detectRuntime() !== 'bun' &&
    Object.keys(host.headers).length > 0
  );
}

function isWebSocketTransportUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('no global websocket') ||
    message.includes('cannot send the configured auth headers over websocket') ||
    message.includes('websocket headers unavailable') ||
    message.includes('websocket constructor has no header support') ||
    message.includes('provide httpclientoptions.websocketfactory')
  );
}

function openSseEventSubscription(
  host: WorkflowEventStreamHost,
  workflowId: string,
  onEvent: (event: WorkflowEvent) => void,
  options: WorkflowEventStreamOptions,
): SseWorkflowEventSubscription {
  return new SseWorkflowEventSubscription(
    workflowEventsSseUrl(host.baseUrl, workflowId),
    host.headers,
    workflowId,
    onEvent,
    options,
  );
}
