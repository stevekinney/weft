/**
 * `createA2AHandler`: serve A2A 1.0.1 JSON-RPC (unary and streaming) and a public
 * Agent Card for a caller-supplied `A2ARequestHandler`, as a fetch-style
 * `(request: Request) => Promise<Response>`.
 *
 * Routes are relative to the mount, so the handler matches the two discovery routes
 * by their path suffix and treats every other path as the JSON-RPC endpoint:
 *
 * - `GET /.well-known/agent-card.json` — the public Agent Card. No credentials.
 * - `GET /.well-known/jwks.json` — the card-signing public key, when `signing` is set.
 *   No credentials.
 * - `POST /` — JSON-RPC. Every request on this route goes through `authenticate`.
 *
 * @module a2a/handler
 */

import { Extensions } from '@a2a-js/sdk';
import {
  A2A_ERROR_CODE,
  ContentTypeNotSupportedError,
  RequestMalformedError,
  VersionNotSupportedError,
} from '@a2a-js/sdk/errors';
import {
  type A2ARequestHandler,
  defaultServerCallContextBuilder,
  JsonRpcTransportHandler,
  type ServerCallContext,
  UnauthenticatedUser,
  type User,
} from '@a2a-js/sdk/server';

import {
  DEFAULT_REST_MAX_BODY_BYTES,
  isOperationFault,
  readRestTextBody,
} from "../embedded/backchannel/src/internals.ts";
import {
  type A2AAgentCardInput,
  type A2ASigningOptions,
  AGENT_CARD_PATH,
  createAgentCardRoutes,
  JWKS_PATH,
} from './agent-card-route.ts';
import {
  type A2AStreamTimerScheduler,
  createA2AEventStreamResponse,
  type JsonRpcResponseEnvelope,
  REQUEST_SIGNAL_STATE_KEY,
  scheduleWithTimeout,
} from './sse-response.ts';
import { recordStreamCursors, type StreamCursorEntry } from './stream-cursors.ts';
import { requireTimerDelayMs } from './timer-delay.ts';

/**
 * Authenticate one JSON-RPC request. Return the SDK `User` the request handler sees
 * as `context.user`, or a `Response` (for example a `401`) that the kit returns
 * unchanged.
 */
export type A2AAuthenticate = (request: Request) => User | Response | Promise<User | Response>;

/** Options for {@link createA2AHandler}. */
export type A2AHandlerOptions = {
  /** Serves every JSON-RPC method, typically the SDK's `DefaultRequestHandler`. */
  readonly requestHandler: A2ARequestHandler;
  /** The public Agent Card. The kit sets its interface list and signatures. */
  readonly agentCard: A2AAgentCardInput;
  /**
   * The JSON-RPC endpoint's public URL: the only source of the card's interface URL.
   * Nothing is derived from the request.
   */
  readonly publicUrl: string;
  /**
   * Base of the discovery URLs (the card's `jku` names `${discoveryUrl}/.well-known/jwks.json`).
   * Defaults to `publicUrl`. Set it when discovery is served from a different listener,
   * such as one that requests no client certificate in an mTLS deployment.
   */
  readonly discoveryUrl?: string;
  /**
   * Deployment identifier, published as the card interface's `tenant` and set as
   * `ServerCallContext.tenant`. A request naming any other tenant is malformed. The
   * mount the handler is served at selects the agent.
   */
  readonly tenant?: string;
  /** Without it, every JSON-RPC request is anonymous. */
  readonly authenticate?: A2AAuthenticate;
  /** Sign the Agent Card and serve its public key at `/.well-known/jwks.json`. */
  readonly signing?: A2ASigningOptions;
  /** Largest accepted JSON-RPC body: a positive safe integer. Defaults to 1 MiB; larger bodies get `413`. */
  readonly maxRequestBodyBytes?: number;
  /**
   * How long an SSE response stays open before the kit closes it with a final comment
   * line, so a long-lived stream authenticates again on reconnect. Defaults to
   * 900 000 ms (fifteen minutes). Must be an integer from 1 to 2 147 483 647.
   */
  readonly maxStreamDurationMs?: number;
};

/** A fetch-style A2A request handler. */
export type A2AHandler = (request: Request) => Promise<Response>;

export const DEFAULT_MAX_STREAM_DURATION_MS = 900_000;
const A2A_PROTOCOL_VERSION = '1.0';

/**
 * A2A 1.0.1 section 3.6 makes patch versions equivalent, so `1.0.1` is served as `1.0`, and
 * the handler's context always carries the normalized Major.Minor value. An absent or empty
 * header is `0.3` (section 3.6.2), which this agent does not serve.
 */
function isServedVersion(requested: string | null): boolean {
  return requested !== null && /^1\.0(?:\.(?:0|[1-9]\d*))?$/.test(requested);
}
const EXTENSIONS_HEADER = 'A2A-Extensions';
const JSON_MEDIA_TYPE = 'application/json';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNPARSEABLE = Symbol('unparseable JSON');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return UNPARSEABLE;
  }
}

/**
 * The SDK's own HTTP adapter accepts a request with no `Content-Type` and rejects one
 * that names any media type other than `application/json`, before reading the body.
 */
function declaresNonJsonContentType(request: Request): string | undefined {
  const contentType = request.headers.get('content-type');
  if (contentType === null) return undefined;
  const mediaType = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return mediaType === JSON_MEDIA_TYPE ? undefined : contentType;
}

function requestIdOf(body: unknown): string | number | null {
  const id = isRecord(body) ? body['id'] : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function errorEnvelope(id: string | number | null, error: unknown): JsonRpcResponseEnvelope {
  return { jsonrpc: '2.0', id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) };
}

function rpcHeaders(context: ServerCallContext | undefined): Headers {
  const headers = new Headers({ 'cache-control': 'no-store' });
  const activated = context?.activatedExtensions;
  if (activated !== undefined && activated.length > 0) {
    headers.set(EXTENSIONS_HEADER, Extensions.toServiceParameter(activated));
  }
  return headers;
}

function jsonRpcResponse(
  envelope: JsonRpcResponseEnvelope,
  context: ServerCallContext | undefined,
): Response {
  return Response.json(envelope, { status: 200, headers: rpcHeaders(context) });
}

function bodyReadFailure(error: unknown): Response {
  const tooLarge = isOperationFault(error) && error.code === 'PayloadTooLarge';
  return new Response(tooLarge ? 'Payload Too Large' : 'Bad Request', {
    status: tooLarge ? 413 : 400,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * Check a request's `params.tenant` against the deployment's tenant. An absent (or
 * empty, the protobuf default) tenant is served; a matching one is removed before
 * dispatch, because the kit has already set the context's tenant and the SDK would
 * otherwise try to set it again.
 */
function bindRequestTenant(body: unknown, tenant: string | undefined): unknown {
  if (!isRecord(body) || !isRecord(body['params'])) return body;
  const { tenant: requested, ...params } = body['params'];
  if (requested === undefined || requested === '') return body;
  if (requested !== tenant) {
    const reason = tenant === undefined ? 'accepts no tenant' : `serves only tenant '${tenant}'`;
    throw new RequestMalformedError(`Unknown tenant; this agent ${reason}.`);
  }
  return { ...body, params };
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return isRecord(value) && Symbol.asyncIterator in value;
}

type ReceivedJsonRpcRequest = {
  /** What the SDK's transport handler decodes: the checked object, or the raw text it rejects. */
  readonly body: string | JsonRecord;
  readonly requestId: string | number | null;
};

/**
 * Check a JSON-RPC request's `Content-Type`, read its body within the size limit and
 * parse it, then check its `A2A-Version` and its tenant, in the order the SDK's HTTP
 * adapter does. Returns the body to dispatch, or the response that rejects the request.
 */
async function receiveJsonRpcRequest(
  request: Request,
  maxBodyBytes: number,
  tenant: string | undefined,
): Promise<ReceivedJsonRpcRequest | Response> {
  const unsupportedContentType = declaresNonJsonContentType(request);
  if (unsupportedContentType !== undefined) {
    const error = new ContentTypeNotSupportedError(
      `Unsupported Content-Type "${unsupportedContentType}"; expected ${JSON_MEDIA_TYPE}.`,
    );
    return jsonRpcResponse(errorEnvelope(null, error), undefined);
  }

  let text: string;
  try {
    text = await readRestTextBody(request, { maxBodyBytes });
  } catch (error) {
    return bodyReadFailure(error);
  }
  const parsed = parseJson(text);
  if (parsed === UNPARSEABLE) {
    const error = { code: A2A_ERROR_CODE.PARSE_ERROR, message: 'Invalid JSON payload.' };
    return jsonRpcResponse({ jsonrpc: '2.0', id: null, error }, undefined);
  }
  const requestId = requestIdOf(parsed);

  const requestedVersion = request.headers.get('A2A-Version');
  if (!isServedVersion(requestedVersion)) {
    const error = new VersionNotSupportedError(
      `A2A-Version '${requestedVersion ?? ''}' is not supported; this agent serves '${A2A_PROTOCOL_VERSION}'.`,
    );
    return jsonRpcResponse(errorEnvelope(requestId, error), undefined);
  }

  try {
    const body = bindRequestTenant(parsed, tenant);
    return { body: isRecord(body) ? body : text, requestId };
  } catch (error) {
    return jsonRpcResponse(errorEnvelope(requestId, error), undefined);
  }
}

/**
 * {@link createA2AHandler} with the stream-duration timer injected. Tests drive it
 * with a manual clock; the public entry point uses `setTimeout`.
 */
export function createA2AHandlerWithScheduler(
  options: A2AHandlerOptions,
  schedule: A2AStreamTimerScheduler,
): A2AHandler {
  const tenant = options.tenant;
  const maxStreamDurationMs = requireTimerDelayMs(
    'maxStreamDurationMs',
    options.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS,
  );
  const maxBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_REST_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new RangeError(
      `maxRequestBodyBytes must be a positive safe integer; received ${maxBodyBytes}.`,
    );
  }
  const discovery = createAgentCardRoutes({
    agentCard: options.agentCard,
    publicUrl: options.publicUrl,
    discoveryUrl: options.discoveryUrl ?? options.publicUrl,
    tenant,
    signing: options.signing,
  });

  async function handleJsonRpc(request: Request): Promise<Response> {
    const user =
      options.authenticate === undefined
        ? new UnauthenticatedUser()
        : await options.authenticate(request);
    if (user instanceof Response) return user;

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'POST', 'cache-control': 'no-store' },
      });
    }

    const received = await receiveJsonRpcRequest(request, maxBodyBytes, tenant);
    if (received instanceof Response) return received;

    const context = defaultServerCallContextBuilder({
      extensions: Extensions.parseServiceParameter(
        request.headers.get(EXTENSIONS_HEADER) ?? undefined,
      ),
      user,
      headers: Object.fromEntries(request.headers),
      requestedVersion: A2A_PROTOCOL_VERSION,
      ...(tenant === undefined ? {} : { tenant }),
    });
    // Ends with the request: its client going away, or its stream closing.
    const ended = new AbortController();
    context.state.set(REQUEST_SIGNAL_STATE_KEY, AbortSignal.any([request.signal, ended.signal]));
    const cursors: StreamCursorEntry[] = [];
    const transport = new JsonRpcTransportHandler(
      recordStreamCursors(options.requestHandler, cursors),
    );
    const result = await transport.handle(received.body, context);
    if (!isAsyncIterable<JsonRpcResponseEnvelope>(result)) return jsonRpcResponse(result, context);

    const iterator = result[Symbol.asyncIterator]();
    let first: IteratorResult<JsonRpcResponseEnvelope, void>;
    try {
      first = await iterator.next();
    } catch (error) {
      return jsonRpcResponse(errorEnvelope(received.requestId, error), context);
    }
    return createA2AEventStreamResponse({
      iterator,
      first,
      cursors,
      requestId: received.requestId,
      maxStreamDurationMs,
      schedule,
      headers: rpcHeaders(context),
      onClose: () => {
        ended.abort();
      },
    });
  }

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname.endsWith(AGENT_CARD_PATH)) {
      return discovery.serveAgentCard(request);
    }
    if (
      request.method === 'GET' &&
      discovery.serveJwks !== undefined &&
      pathname.endsWith(JWKS_PATH)
    ) {
      return discovery.serveJwks();
    }
    return handleJsonRpc(request);
  };
}

/**
 * Create a fetch-style handler serving A2A 1.0.1 JSON-RPC (unary and streaming) and
 * the public Agent Card for `options.requestHandler`.
 *
 * @example
 * ```ts
 * import type { A2ARequestHandler } from '@a2a-js/sdk/server';
 * import { createA2AHandler, type A2AHandlerOptions } from '@lostgradient/weft/a2a';
 *
 * declare const requestHandler: A2ARequestHandler;
 * declare const agentCard: A2AHandlerOptions['agentCard'];
 *
 * const handler = createA2AHandler({
 *   requestHandler,
 *   agentCard,
 *   publicUrl: 'https://agents.example.com/a2a',
 * });
 * ```
 */
export function createA2AHandler(options: A2AHandlerOptions): A2AHandler {
  return createA2AHandlerWithScheduler(options, scheduleWithTimeout);
}
