import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';

/**
 * An SDK transport over newline-delimited JSON-RPC lines that Weft's stdio
 * session reads itself. Weft owns the byte stream because its admission frame
 * and frame-size bound come before any MCP traffic; the SDK owns everything
 * after a line is parsed. The transport counts the requests it delivered and
 * the responses it sent, so the session can let in-flight calls finish after
 * the input ends.
 */
export class StreamLineTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  readonly #write: (line: string) => Promise<void>;
  readonly #inFlight = new Set<string>();
  #settledWaiters: Array<() => void> = [];
  #closed = false;

  constructor(write: (line: string) => Promise<void>) {
    this.#write = write;
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      this.#settle(message.id);
    }
    await this.#write(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inFlight.clear();
    this.#wakeSettledWaiters();
    this.onclose?.();
  }

  /** Parse one line and hand it to the SDK, answering malformed lines itself. */
  receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      void this.reject(null, -32700, 'Parse error');
      return;
    }
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(value);
    } catch {
      // Valid JSON that is not a JSON-RPC message: answer it, so the peer is not left waiting.
      void this.reject(requestIdOf(value), -32600, 'Invalid Request');
      return;
    }
    // A `subscriptions/listen` request stays open until the connection ends,
    // so it never counts as a call the session waits for.
    if (isJSONRPCRequest(message) && message.method !== 'subscriptions/listen') {
      this.#inFlight.add(requestIdKey(message.id));
    }
    this.onmessage?.(message);
    // The SDK sends no response to a request the client cancelled.
    if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      this.#settle(cancelledRequestId(message.params));
    }
  }

  /** Write a JSON-RPC error that never reached the SDK. */
  async reject(id: RequestId | null, code: number, message: string): Promise<void> {
    await this.#write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  /** Resolves once every delivered request has been answered. */
  async settled(): Promise<void> {
    if (this.#inFlight.size === 0) return;
    await new Promise<void>((resolve) => {
      this.#settledWaiters.push(resolve);
    });
  }

  #settle(id: RequestId | undefined): void {
    if (id === undefined) return;
    this.#inFlight.delete(requestIdKey(id));
    if (this.#inFlight.size === 0) this.#wakeSettledWaiters();
  }

  #wakeSettledWaiters(): void {
    const waiters = this.#settledWaiters;
    this.#settledWaiters = [];
    for (const wake of waiters) wake();
  }
}

function cancelledRequestId(params: unknown): RequestId | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const requestId = (params as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}

function requestIdKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

/** The id a malformed frame names, when it names one a response can echo. */
function requestIdOf(value: unknown): RequestId | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}
