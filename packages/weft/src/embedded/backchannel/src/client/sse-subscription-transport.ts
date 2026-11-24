import { CatalogClientError, type CatalogFetch } from './catalog-client.ts';
import {
  parseServerSentEventChunk,
  type ServerSentEventFrame,
} from './server-sent-event-parser.ts';
import type {
  SubscriptionCallOptions,
  SubscriptionMessage,
  SubscriptionTransport,
} from './subscription-client.ts';

/** The JSON-RPC server-error code a stream's `error` frame is reported under. */
const STREAM_ERROR_CODE = -32000;
/** The JSON-RPC parse-error code, for an event whose data is not JSON. */
const PARSE_ERROR_CODE = -32700;

/**
 * Where an SSE subscription transport opens its streams, and what it sends with them.
 *
 * `baseUrl` is the address of the handler's root, absolute or a path the browser resolves.
 * `routePrefix` is the path the handler serves subscriptions under, `/v1/subscriptions` unless
 * the catalog is mounted elsewhere; the operation name follows it. `headers` go on every call and
 * `fetch` is the default a call's own `fetch` overrides.
 *
 * @example
 * ```ts
 * import { sseSubscriptionTransport, type SseSubscriptionConnection } from '@lostgradient/backchannel/client';
 *
 * const connection: SseSubscriptionConnection = {
 *   baseUrl: '/api',
 *   routePrefix: '/v1/subscriptions',
 *   headers: { authorization: 'Bearer token' },
 * };
 *
 * console.log(typeof sseSubscriptionTransport(connection));
 * ```
 */
export type SseSubscriptionConnection = {
  /** The handler's root, absolute or a path the browser resolves. */
  readonly baseUrl: string;
  /** The path subscriptions are served under. Defaults to `/v1/subscriptions`. */
  readonly routePrefix?: string | undefined;
  /** Headers sent with every call. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** The `fetch` to use unless a call brings its own. Defaults to the global one. */
  readonly fetch?: CatalogFetch | undefined;
};

const DEFAULT_ROUTE_PREFIX = '/v1/subscriptions';

/**
 * The URL a subscription is opened at: the base, the route prefix, the encoded operation name,
 * and the input as a query string. A repeated key carries an array, an absent or `undefined`
 * field is left out, and a value that is not a string, number or boolean is sent as JSON.
 *
 * @example
 * ```ts
 * import { subscriptionUrl } from '@lostgradient/backchannel/client';
 *
 * console.log(
 *   subscriptionUrl({ baseUrl: '/api' }, 'probe.jobs.watch', { topic: 'a', kinds: ['x', 'y'] }),
 * ); // /api/v1/subscriptions/probe.jobs.watch?topic=a&kinds=x&kinds=y
 * ```
 */
export function subscriptionUrl(
  connection: Pick<SseSubscriptionConnection, 'baseUrl' | 'routePrefix'>,
  operationName: string,
  input: unknown,
): string {
  const base = connection.baseUrl.replace(/[?#].*$/u, '').replace(/\/+$/u, '');
  const prefix = (connection.routePrefix ?? DEFAULT_ROUTE_PREFIX).replace(/\/+$/u, '');
  const query = new URLSearchParams();
  if (typeof input === 'object' && input !== null) {
    for (const [key, value] of Object.entries(input)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry !== undefined) query.append(key, queryValue(entry));
      }
    }
  }
  const search = query.toString();
  return `${base}${prefix}/${encodeURIComponent(operationName)}${search === '' ? '' : `?${search}`}`;
}

function queryValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}

/**
 * Transport that opens a subscription as a Server-Sent Events stream at
 * `GET ${baseUrl}${routePrefix}/${operationName}`, which is what the operation handler serves.
 *
 * The iteration yields each event with its `id`, then one `replay-complete` marker when the
 * server says the replay is done. `lastEventId` is sent as `Last-Event-ID`, so the stream resumes
 * after that event. Aborting the signal ends the iteration without an error; leaving the loop
 * early closes the connection. A stream that reports an error, a response that is not a success
 * and a response that is not an event stream each throw a {@link CatalogClientError}. One call
 * opens one stream: reconnecting is the caller's.
 *
 * @example
 * ```ts
 * import { sseSubscriptionTransport } from '@lostgradient/backchannel/client';
 *
 * const transport = sseSubscriptionTransport({ baseUrl: 'https://api.example.test' });
 * const controller = new AbortController();
 *
 * for await (const message of transport('probe.jobs.watch', {}, { signal: controller.signal })) {
 *   if (message.type === 'event') console.log(message.id, message.data);
 * }
 * ```
 */
export function sseSubscriptionTransport(
  connection: SseSubscriptionConnection,
): SubscriptionTransport {
  return (operationName, input, options) =>
    readSubscription(connection, operationName, input, options);
}

type StreamState = { replayCompleteSeen: boolean };

async function* readSubscription(
  connection: SseSubscriptionConnection,
  operationName: string,
  input: unknown,
  options: SubscriptionCallOptions | undefined,
): AsyncGenerator<SubscriptionMessage<unknown>> {
  const caller = options?.signal;
  if (caller?.aborted) return;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(caller?.reason);
  caller?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await open(connection, operationName, input, options, controller.signal);
    if (response === null) return;
    yield* readFrames(operationName, response, caller);
  } finally {
    caller?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** Opens the stream, or returns null when the caller aborted before the response arrived. */
async function open(
  connection: SseSubscriptionConnection,
  operationName: string,
  input: unknown,
  options: SubscriptionCallOptions | undefined,
  signal: AbortSignal,
): Promise<Response | null> {
  const send = options?.fetch ?? connection.fetch ?? globalThis.fetch;
  // The call's options belong to the caller: read the signal now, not after the request awaits.
  const caller = options?.signal;
  let response: Response;
  try {
    response = await send(subscriptionUrl(connection, operationName, input), {
      method: 'GET',
      headers: requestHeaders(connection, options),
      signal,
    });
  } catch (error) {
    if (caller?.aborted === true) return null;
    throw error;
  }
  if (!response.ok) throw await failedResponse(operationName, response);
  await requireEventStream(operationName, response);
  return response;
}

/** The connection's headers, the media type asked for, and `Last-Event-ID` when resuming. */
function requestHeaders(
  connection: SseSubscriptionConnection,
  options: SubscriptionCallOptions | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...connection.headers, accept: 'text/event-stream' };
  if (options?.lastEventId !== undefined) headers['last-event-id'] = options.lastEventId;
  return headers;
}

async function requireEventStream(operationName: string, response: Response): Promise<void> {
  if (isEventStream(response) && response.body !== null) return;
  await response.body?.cancel().catch(() => undefined);
  throw new CatalogClientError(operationName, {
    code: response.status,
    message: `Expected an event stream for ${operationName}, not ${response.headers.get('content-type') ?? 'no content type'}`,
  });
}

async function* readFrames(
  operationName: string,
  response: Response,
  caller: AbortSignal | undefined,
): AsyncGenerator<SubscriptionMessage<unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = { replayCompleteSeen: false };
  let remainder = '';
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (caller?.aborted === true) return;
        throw error;
      }
      if (chunk.done) return;
      const parsed = parseServerSentEventChunk(
        decoder.decode(chunk.value, { stream: true }),
        remainder,
      );
      remainder = parsed.remainder;
      for (const frame of parsed.frames) {
        const message = interpret(operationName, frame, state);
        if (message !== undefined) yield message;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function interpret(
  operationName: string,
  frame: ServerSentEventFrame,
  state: StreamState,
): SubscriptionMessage<unknown> | undefined {
  if (frame.event === 'error') throw streamError(operationName, frame.data);
  if (frame.event === 'ping') {
    if (state.replayCompleteSeen || !isReplayComplete(frame.data)) return undefined;
    state.replayCompleteSeen = true;
    return { type: 'replay-complete' };
  }
  if (frame.id === undefined) return undefined;
  return { type: 'event', id: frame.id, data: parseEventData(operationName, frame.data) };
}

function parseEventData(operationName: string, data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new CatalogClientError(operationName, {
      code: PARSE_ERROR_CODE,
      message: `${operationName} sent an event whose data is not JSON`,
    });
  }
}

function isReplayComplete(data: string): boolean {
  const parsed = tryParse(data);
  return isRecord(parsed) && parsed['replayComplete'] === true;
}

function streamError(operationName: string, data: string): CatalogClientError {
  const parsed = tryParse(data);
  const body = isRecord(parsed) ? parsed : {};
  const message = typeof body['message'] === 'string' ? body['message'] : 'The stream failed';
  return new CatalogClientError(operationName, {
    code: STREAM_ERROR_CODE,
    message,
    // The frame's `retryable` and `remediation` are the fault's advice, kept for the caller.
    data: {
      code: body['code'],
      data: body['data'],
      ...(typeof body['retryable'] === 'boolean' ? { retryable: body['retryable'] } : {}),
      ...(typeof body['remediation'] === 'string' ? { remediation: body['remediation'] } : {}),
    },
  });
}

async function failedResponse(
  operationName: string,
  response: Response,
): Promise<CatalogClientError> {
  const parsed = tryParse(await response.text().catch(() => ''));
  const body = isRecord(parsed) ? parsed : {};
  const text = body['message'] ?? body['error'];
  return new CatalogClientError(operationName, {
    code: response.status,
    message: typeof text === 'string' ? text : response.statusText || `HTTP ${response.status}`,
    data: parsed,
  });
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
