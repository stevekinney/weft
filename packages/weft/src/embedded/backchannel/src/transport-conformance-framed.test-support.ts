import { CatalogClientError, type JsonRpcErrorObject } from './client/index.ts';
import { SESSION_METHODS } from './json-rpc-websocket-subscriptions.ts';
import type { TransportConformancePair } from './transport-conformance.test-support.ts';

/** Minimal client for exercising a JSON-RPC session's actual response and notification frames. */
export function connectFramedTransport(
  connect: (receive: (frame: string) => void) => {
    send: (frame: string) => void | Promise<void>;
    close: () => Promise<void>;
  },
): TransportConformancePair {
  let incoming!: ReadableStreamDefaultController<string>;
  const reader = new ReadableStream<string>({
    start(controller) {
      incoming = controller;
    },
  }).getReader();
  const { send, close } = connect((frame) => incoming.enqueue(frame));
  let id = 0;

  async function read() {
    const frame = await reader.read();
    if (frame.done) throw new Error('JSON-RPC session ended before the expected frame');
    return JSON.parse(frame.value) as {
      id?: number;
      result?: unknown;
      error?: JsonRpcErrorObject;
      method?: string;
      params?: { subscriptionId: string; envelope: { cursor: string }; reason?: string };
    };
  }

  async function request(method: string, params: unknown): Promise<number> {
    const nextId = ++id;
    await send(JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }));
    return nextId;
  }

  async function call(method: string, params: unknown): Promise<unknown> {
    const requestId = await request(method, params);
    const response = await read();
    if (response.id !== requestId) throw new Error('Unexpected JSON-RPC response ID');
    if (response.error !== undefined) throw new CatalogClientError(method, response.error);
    return response.result;
  }

  return {
    call,
    async *subscribe(method, params, options) {
      const signal = options?.signal;
      const started = (await call(method, {
        ...(params as Record<string, unknown>),
        ...(options?.lastEventId === undefined ? {} : { fromCursor: options.lastEventId }),
      })) as { subscriptionId: string };
      const subscriptionId = started.subscriptionId;
      let unsubscribing: Promise<number> | undefined;
      let terminated = false;
      const unsubscribe = (): Promise<number> =>
        (unsubscribing ??= request(SESSION_METHODS.UNSUBSCRIBE, { subscriptionId }));
      const stop = (): void => {
        void unsubscribe().catch(() => {});
      };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        if (signal?.aborted) stop();
        while (!terminated) {
          const frame = await read();
          if (frame.params?.subscriptionId !== subscriptionId) continue;
          if (frame.method === SESSION_METHODS.TERMINATED) terminated = true;
          if (frame.method === SESSION_METHODS.DELIVER && unsubscribing === undefined) {
            yield { type: 'event', id: frame.params.envelope.cursor, data: frame.params.envelope };
          }
        }
      } finally {
        signal?.removeEventListener('abort', stop);
        if (!terminated) {
          await unsubscribe();
          while (!terminated) {
            const frame = await read();
            terminated =
              frame.method === SESSION_METHODS.TERMINATED &&
              frame.params?.subscriptionId === subscriptionId;
          }
        }
      }
    },
    async close() {
      await close();
      await reader.cancel();
    },
  };
}
