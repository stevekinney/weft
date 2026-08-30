/**
 * WebSocket transport helpers shared by the JSON-RPC WebSocket integration
 * suite and the operation suites that exercise the WebSocket endpoint.
 *
 * These set up the transport (open a socket, wait for a matching inbound
 * frame) only. Each suite keeps its own `ws.send(...)` request bodies,
 * method names, correlation ids, and assertions inline at the call site.
 *
 * `collectWebSocketDeliveredEnvelopes` is the one higher-level helper here: it
 * drives the full subscribe-and-collect flow that the sequence-cursor and
 * acceptance suites share, so they stay in lockstep instead of each carrying a
 * near-identical copy.
 */

import type { WeftServer } from './index.ts';
import type { EventEnvelope } from './workflow-event-feed.ts';

/**
 * Resolve once a parsed inbound message satisfies `predicate`; reject after
 * `timeoutMs`. Frames that fail to parse as JSON are ignored. Removes its own
 * listener on settle.
 */
export function waitForMessage(
  ws: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMs = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    ws.addEventListener('message', handler);
  });
}

/**
 * Open a WebSocket and resolve on `open`, reject on `error`. When `token` is
 * given, send it as a Bearer `authorization` header in the upgrade request.
 *
 * Bun's WebSocket constructor accepts a `{ headers }` options object, but the
 * WHATWG type only types the second argument as a subprotocols array, so the
 * cast matches the existing project pattern.
 */
export function openWebSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      token === undefined
        ? new WebSocket(url)
        : new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as any);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', (event: Event) => reject(event));
  });
}

/**
 * Subscribe to a workflow's event stream over an authenticated WebSocket and
 * resolve with the delivered envelopes once `expectedCount` have arrived.
 *
 * `apiKey` is presented as the upgrade Bearer token; `correlationPrefix`
 * distinguishes the subscribe request id so concurrent suites do not collide
 * on the same correlation id.
 */
export async function collectWebSocketDeliveredEnvelopes(
  server: WeftServer,
  workflowId: string,
  expectedCount: number,
  apiKey: string,
  correlationPrefix = 'collect',
): Promise<EventEnvelope[]> {
  const webSocketUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
  const webSocket = await openWebSocket(webSocketUrl, apiKey);

  try {
    return await new Promise<EventEnvelope[]>((resolve, reject) => {
      const received: EventEnvelope[] = [];
      const correlationId = `${correlationPrefix}-${workflowId}`;
      let subscriptionId: string | undefined;

      const timer = setTimeout(() => {
        webSocket.removeEventListener('message', handler);
        reject(new Error('collectWebSocketDeliveredEnvelopes timed out'));
      }, 3_000);

      function finish(value: EventEnvelope[]): void {
        clearTimeout(timer);
        webSocket.removeEventListener('message', handler);
        resolve(value);
      }

      function handler(event: MessageEvent): void {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) {
          return;
        }

        const record = parsed as Record<string, unknown>;
        if (record['id'] === correlationId) {
          const result = record['result'];
          if (typeof result === 'object' && result !== null) {
            const candidateSubscriptionId = (result as Record<string, unknown>)['subscriptionId'];
            if (typeof candidateSubscriptionId === 'string') {
              subscriptionId = candidateSubscriptionId;
              if (expectedCount === 0) {
                finish([]);
              }
            }
          }
          return;
        }

        if (record['method'] !== 'weft.events.deliver' || subscriptionId === undefined) {
          return;
        }

        const params = record['params'];
        if (typeof params !== 'object' || params === null) {
          return;
        }

        const deliverParams = params as Record<string, unknown>;
        if (deliverParams['subscriptionId'] !== subscriptionId) {
          return;
        }

        const envelope = deliverParams['envelope'];
        if (typeof envelope !== 'object' || envelope === null) {
          return;
        }

        received.push(envelope as EventEnvelope);
        if (received.length >= expectedCount) {
          finish(received);
        }
      }

      webSocket.addEventListener('message', handler);
      webSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: correlationId,
          method: 'weft.workflows.subscribe',
          params: { workflowId, selector: 'events' },
        }),
      );
    });
  } finally {
    webSocket.close();
  }
}
