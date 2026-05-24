/**
 * WebSocket transport helpers shared by the JSON-RPC WebSocket integration
 * suite and the operation suites that exercise the WebSocket endpoint.
 *
 * These set up the transport (open a socket, wait for a matching inbound
 * frame) only. Each suite keeps its own `ws.send(...)` request bodies,
 * method names, correlation ids, and assertions inline at the call site.
 */

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
