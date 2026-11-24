import { faultToHttpResponse } from '../fault-to-http.ts';
import {
  executeSubscription,
  type OperationRegistry,
  type SubscriptionOperationInvocation,
} from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  createEventEnvelopeSSEStream,
  requireServerSentEventsAccept,
  shapeServerSentEventsFault,
  SSE_RESPONSE_HEADERS,
  type ServerSentEventHeartbeatOptions,
} from '../operations/sse-stream.ts';
import type { Principal } from '../principal.ts';

/** How long one response may stream before the handler ends it: fifteen minutes. */
export const DEFAULT_MAX_STREAM_DURATION_MS = 900_000;

export type SubscriptionRouteContext = {
  readonly registry: OperationRegistry;
  readonly host: unknown;
  readonly principal: Principal;
  readonly maxStreamDurationMs: number;
  readonly heartbeat: ServerSentEventHeartbeatOptions | undefined;
  /** The host's error-code vocabulary (see `FaultPolicy.isKnownErrorCode`). */
  readonly isKnownErrorCode?: ((value: string) => boolean) | undefined;
};

/**
 * Map a query string onto a subscription's input. Every value is a string; a
 * key that repeats becomes an array of its values in order. Nothing is coerced
 * to a number or a boolean: a schema that wants one declares `z.coerce`.
 *
 * The record has no prototype, so a `__proto__` key is an ordinary own key
 * that the operation's unknown-key policy then rejects or strips, rather than
 * a write to the prototype.
 */
export function subscriptionInputFromQuery(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const input: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    input[key] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return input;
}

type SseEnvelope = {
  readonly kind: string;
  readonly cursor: string;
  readonly emittedAtMs: number;
};

/** A carriage return or line feed in a field would end it and start a forged one. */
const LINE_BREAK = /[\r\n]/;

function isSseEnvelope(value: unknown): value is SseEnvelope {
  if (value === null || typeof value !== 'object') return false;
  return (
    'kind' in value &&
    typeof value.kind === 'string' &&
    !LINE_BREAK.test(value.kind) &&
    'cursor' in value &&
    typeof value.cursor === 'string' &&
    !LINE_BREAK.test(value.cursor) &&
    'emittedAtMs' in value &&
    typeof value.emittedAtMs === 'number'
  );
}

/**
 * A subscription's elements reach the wire as SSE frames keyed by `cursor`, so
 * every element must carry one, and `cursor` and `kind` become the `id:` and
 * `event:` lines, so neither may contain a line break (an operation echoing
 * caller-controlled text there could forge a frame). Anything else is the
 * operation's defect, not the caller's, and ends the stream with a sanitized
 * error frame.
 */
async function* asEnvelopes(iterable: AsyncIterable<unknown>): AsyncGenerator<SseEnvelope> {
  for await (const element of iterable) {
    if (!isSseEnvelope(element)) {
      throw { code: 'EngineFailure', message: 'internal error', data: {} } satisfies OperationFault;
    }
    yield element;
  }
}

function acceptFailure(request: Request): Response | null {
  try {
    requireServerSentEventsAccept(request);
    return null;
  } catch (error) {
    // `requireServerSentEventsAccept` throws the fault it wants shaped.
    return shapeServerSentEventsFault(error as OperationFault);
  }
}

function streamResponse(
  invocation: SubscriptionRouteInvocation,
  request: Request,
  context: SubscriptionRouteContext,
): Response {
  const stream = createEventEnvelopeSSEStream({
    iterable: asEnvelopes(invocation.iterable),
    close: invocation.close,
    signal: request.signal,
    maxDurationMs: context.maxStreamDurationMs,
    ...(invocation.replayComplete === undefined ? {} : { ready: invocation.replayComplete }),
    ...(context.heartbeat === undefined ? {} : { heartbeat: context.heartbeat }),
  });
  return new Response(stream, { status: 200, headers: SSE_RESPONSE_HEADERS });
}

type SubscriptionRouteInvocation = Pick<
  SubscriptionOperationInvocation<unknown, unknown>,
  'iterable' | 'close'
> & { readonly replayComplete?: Promise<void> };

/**
 * Serve `GET /v1/subscriptions/:operationName`: the catalog subscription
 * `operationName` as Server-Sent Events, resumable with `Last-Event-ID`.
 *
 * A fetch handler cannot accept a WebSocket, so this is how a subscription
 * reaches a plain HTTP client. The operation runs through the same pipeline as
 * every other transport (`executeSubscription`), so access policy, `authorize`,
 * and input parsing are not reimplemented here.
 */
export async function handleSubscriptionRequest(
  request: Request,
  operationName: string,
  context: SubscriptionRouteContext,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
  }
  const refused = acceptFailure(request);
  if (refused !== null) return refused;

  const url = new URL(request.url);
  const input = subscriptionInputFromQuery(url.searchParams);
  // The header wins over a query `fromCursor`: it is what a reconnecting
  // EventSource sends, and the query is only the first connection's cursor.
  // The cursor's format belongs to the operation's feed, so the operation's
  // input schema and the feed validate it, not this route.
  const lastEventId = request.headers.get('Last-Event-ID');
  if (lastEventId !== null && lastEventId !== '') input['fromCursor'] = lastEventId;

  const result = await executeSubscription(operationName, input, {
    principal: context.principal,
    host: context.host,
    transport: 'http-rest',
    registry: context.registry,
    signal: request.signal,
  });
  if (!result.ok) {
    return faultToHttpResponse(
      result.fault,
      context.isKnownErrorCode === undefined
        ? undefined
        : { isKnownErrorCode: context.isKnownErrorCode },
    );
  }
  return streamResponse(result.value, request, context);
}
