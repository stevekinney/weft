/**
 * Server-Sent Events writer for streamed A2A JSON-RPC responses.
 *
 * Each SSE event's `data:` is exactly one JSON-RPC response object. An event whose
 * cursor entry carries a durable cursor is written with that cursor as its SSE `id`.
 * The stream closes after `maxStreamDurationMs` with a final comment line, so a
 * long-lived subscription reconnects and is authenticated again.
 *
 * Closing the stream, by the client going away or by that timer, cannot stop a request
 * handler that is waiting for its next event: an async generator's `return()` waits
 * for the generator's next `yield`. So the handler aborts the request's signal, which
 * it carries in the call context's state under {@link REQUEST_SIGNAL_STATE_KEY}, and a
 * request handler that waits passes {@link requestSignalOf} to what it waits on.
 *
 * @module a2a/sse-response
 */

import { JsonRpcTransportHandler, type ServerCallContext } from '@a2a-js/sdk/server';

import { formatServerSentEvent } from "../embedded/backchannel/src/internals.ts";
import type { StreamCursorEntry } from './stream-cursors.ts';

/** A JSON-RPC response envelope as the SDK's transport handler produces it. */
export type JsonRpcResponseEnvelope = {
  readonly jsonrpc: string;
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: unknown;
};

/**
 * Schedules `callback` after `delayMs` and returns a function that cancels it. The
 * kit uses `setTimeout`; tests substitute a manual clock.
 */
export type A2AStreamTimerScheduler = (callback: () => void, delayMs: number) => () => void;

/** The call-context state key under which the handler stores the request's abort signal. */
export const REQUEST_SIGNAL_STATE_KEY = 'weft.a2a.requestSignal';

/**
 * The signal that aborts when the request `context` belongs to ends: its client went
 * away or its stream closed. `undefined` for a context the A2A handler did not build.
 */
export function requestSignalOf(context: ServerCallContext): AbortSignal | undefined {
  const signal = context.state.get(REQUEST_SIGNAL_STATE_KEY);
  return signal instanceof AbortSignal ? signal : undefined;
}

export const scheduleWithTimeout: A2AStreamTimerScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export type A2AEventStreamOptions = {
  /** The transport handler's response iterator, already advanced once. */
  readonly iterator: AsyncIterator<JsonRpcResponseEnvelope, void, undefined>;
  /** The result of the first `next()`, taken before the response was committed. */
  readonly first: IteratorResult<JsonRpcResponseEnvelope, void>;
  /** One entry per streamed event, filled in order by the cursor-recording wrapper. */
  readonly cursors: StreamCursorEntry[];
  /** The JSON-RPC request id, for an error that interrupts the stream. */
  readonly requestId: string | number | null;
  readonly maxStreamDurationMs: number;
  readonly schedule: A2AStreamTimerScheduler;
  readonly headers: Headers;
  /** Called once when the stream closes early, by the client or the duration timer. */
  readonly onClose?: () => void;
};

const textEncoder = new TextEncoder();

function encodeResponseEvent(
  response: JsonRpcResponseEnvelope,
  entry: StreamCursorEntry | undefined,
): Uint8Array {
  const data = JSON.stringify(response);
  const cursor = entry?.cursor;
  return textEncoder.encode(
    formatServerSentEvent(cursor === undefined ? { data } : { id: cursor, data }),
  );
}

/**
 * Await an upstream generator's `return()`. The response is already closed, so a
 * failure in the generator's own cleanup has no one left to report to.
 */
async function settleQuietly(settling: Promise<unknown> | undefined): Promise<void> {
  try {
    await settling;
  } catch {
    // Nothing to do: the client is gone or the stream has already ended.
  }
}

/** Build the `text/event-stream` response for a streaming JSON-RPC method. */
export function createA2AEventStreamResponse(options: A2AEventStreamOptions): Response {
  const { iterator, cursors } = options;
  let closed = false;
  let cancelTimer: (() => void) | undefined;

  function stopUpstream(): void {
    closed = true;
    cancelTimer?.();
    options.onClose?.();
    // Settles once any pending `next()` does; nothing waits on it.
    void settleQuietly(iterator.return?.());
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      cancelTimer = options.schedule(() => {
        if (closed) return;
        stopUpstream();
        controller.enqueue(
          textEncoder.encode(
            `: stream closed after ${options.maxStreamDurationMs} ms; reconnect to continue\n\n`,
          ),
        );
        controller.close();
      }, options.maxStreamDurationMs);

      void (async () => {
        let step = options.first;
        try {
          while (step.done !== true) {
            controller.enqueue(encodeResponseEvent(step.value, cursors.shift()));
            step = await iterator.next();
            if (closed) return;
          }
        } catch (error) {
          if (closed) return;
          const response: JsonRpcResponseEnvelope = {
            jsonrpc: '2.0',
            id: options.requestId,
            error: JsonRpcTransportHandler.mapToJSONRPCError(error),
          };
          controller.enqueue(encodeResponseEvent(response, undefined));
        }
        closed = true;
        cancelTimer?.();
        controller.close();
      })();
    },
    cancel() {
      stopUpstream();
    },
  });

  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  headers.set('x-accel-buffering', 'no');
  return new Response(body, { status: 200, headers });
}
