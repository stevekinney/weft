/**
 * Durable cursors for streamed A2A events.
 *
 * The SDK's `JsonRpcTransportHandler` converts every event a request handler's
 * streaming method yields into one JSON-RPC response (`StreamResponse.toJSON`), in
 * order. The conversion loses object identity, so a cursor cannot ride on the event
 * itself. Instead the kit wraps the request handler: for every event the handler
 * yields, the wrapper records one queue entry, carrying the cursor the event was
 * tagged with through {@link withStreamEventCursor} (or none), and the SSE writer
 * takes one entry per response, in the same order.
 *
 * @module a2a/stream-cursors
 */

import type { StreamResponse } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';

const streamEventCursors = new WeakMap<StreamResponse, string>();

/** One recorded streamed event: the durable cursor it was tagged with, if any. */
export type StreamCursorEntry = { readonly cursor: string | undefined };

/** Characters that would end an SSE `id:` line early (CR, LF) or make clients ignore it (NUL). */
const SSE_ID_FORBIDDEN = /[\r\n\0]/;

/**
 * Tag a streamed event with its durable cursor, which the kit writes as the event's
 * SSE `id` so a client can resume with `Last-Event-ID`. A cursor containing a carriage
 * return, line feed, or NUL cannot be an SSE `id` and throws a `TypeError`. Returns the
 * same event, so a request handler can tag as it yields:
 *
 * @example
 * ```ts
 * import type { StreamResponse } from '@a2a-js/sdk';
 * import { withStreamEventCursor } from '@lostgradient/weft/a2a';
 *
 * async function* replay(events: ReadonlyArray<{ cursor: string; event: StreamResponse }>) {
 *   for (const entry of events) yield withStreamEventCursor(entry.event, entry.cursor);
 * }
 * ```
 */
export function withStreamEventCursor<TEvent extends StreamResponse>(
  event: TEvent,
  cursor: string,
): TEvent {
  if (SSE_ID_FORBIDDEN.test(cursor)) {
    throw new TypeError(
      'A2A stream cursor must not contain a carriage return, line feed, or NUL: it is written as an SSE id.',
    );
  }
  streamEventCursors.set(event, cursor);
  return event;
}

async function* recordCursors(
  stream: AsyncGenerator<StreamResponse, void, undefined>,
  queue: StreamCursorEntry[],
): AsyncGenerator<StreamResponse, void, undefined> {
  for await (const event of stream) {
    queue.push({ cursor: streamEventCursors.get(event) });
    yield event;
  }
}

/**
 * Wrap a request handler so each event its streaming methods (`sendMessageStream`
 * and `resubscribe`) yield appends one {@link StreamCursorEntry} to `queue`. Every
 * other member is the handler's own, bound to the handler so private state survives.
 */
export function recordStreamCursors(
  requestHandler: A2ARequestHandler,
  queue: StreamCursorEntry[],
): A2ARequestHandler {
  return new Proxy(requestHandler, {
    get(target, property) {
      if (property === 'sendMessageStream') {
        return (
          params: Parameters<A2ARequestHandler['sendMessageStream']>[0],
          context: ServerCallContext,
        ) => recordCursors(target.sendMessageStream(params, context), queue);
      }
      if (property === 'resubscribe') {
        return (
          params: Parameters<A2ARequestHandler['resubscribe']>[0],
          context: ServerCallContext,
        ) => recordCursors(target.resubscribe(params, context), queue);
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
