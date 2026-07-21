import { resolveConnection } from '../connection.ts';
import { failureCategoryForFaultCode, isFaultCode, type FaultCode } from '../core/fault-code.ts';
import type { FailureCategory } from '../core/types/identity.ts';
import { isWeftErrorCode, WeftError, type WeftErrorCode } from '../core/weft-error.ts';
import type { WorkflowEventTransport } from './event-stream-options.ts';
import type { WebSocketFactory } from './event-stream-transport.ts';

/**
 * Configuration for the HTTP client.
 *
 * @example
 * ```ts
 * import { HttpClient, type HttpClientOptions } from '@lostgradient/weft';
 *
 * const options: HttpClientOptions = {
 *   baseUrl: 'http://localhost:3000',
 *   headers: { 'X-API-Key': 'my-secret-key' },
 * };
 * const client = new HttpClient(options);
 * ```
 */
export interface HttpClientOptions {
  /**
   * Base URL of the Weft server (e.g. `http://localhost:3000`). Defaults to
   * `WEFT_ADDR`, then the `~/.weft/config` profile, then `http://localhost:7233`
   * when omitted.
   */
  baseUrl?: string;
  /**
   * Bearer token sent as `Authorization: Bearer <token>`. Defaults to
   * `WEFT_TOKEN` or the profile token when omitted. An explicit
   * `headers.Authorization` always wins; pass an empty string to suppress a
   * resolved token entirely.
   */
  token?: string;
  /** Optional headers to include on every request (e.g. auth tokens). */
  headers?: Record<string, string>;
  /**
   * Live workflow-event transport. `auto` prefers WebSocket and falls back to
   * fetch-based SSE when the initial WebSocket constructor cannot carry the
   * configured headers. Defaults to `auto`.
   */
  eventTransport?: WorkflowEventTransport;
  /**
   * Override the WebSocket constructor used for live event streaming
   * (`tail()` / push-based `handle.addEventListener`). Production omits this and
   * the global `WebSocket` is used; tests inject a fake to drive the
   * subscription protocol without a real socket.
   */
  webSocketFactory?: WebSocketFactory;
}

/**
 * Resolve {@link HttpClientOptions} into the concrete `baseUrl` and request
 * headers an {@link HttpClient} uses. With no `baseUrl`/`token`, the server
 * address and bearer token come from {@link resolveConnection} (explicit
 * options, then `WEFT_ADDR`/`WEFT_TOKEN`, then the `~/.weft/config` profile,
 * then `http://localhost:7233`). The CLI-only run lockfile is never consulted.
 * A caller-supplied `headers.Authorization` always takes precedence over a
 * resolved token; pass an empty `token` to suppress a resolved token entirely.
 */
export function resolveHttpClientConnection(options: HttpClientOptions): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const connection = resolveConnection({
    includeRunLockfile: false,
    ...(options.baseUrl !== undefined ? { server: options.baseUrl } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
  });
  const baseUrl = connection.server.toString().replace(/\/+$/, '');

  const headers = new Headers(options.headers);
  if (connection.token !== undefined && connection.token !== '' && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${connection.token}`);
  }

  return { baseUrl, headers: Object.fromEntries(headers.entries()) };
}

/**
 * Error thrown when the server returns a non-2xx response.
 *
 * When the server sends a fault body with a recognized coarse `code`, the wire
 * value is surfaced as {@link HttpClientError.faultCode} with a derived
 * {@link HttpClientError.category}, so callers can branch without
 * string-matching `message`. Both are `undefined` for the production flat REST
 * body, which carries no coarse code. The fault's typed
 * `data` payload (e.g. `InvalidParams`'s `issues`, `NotFound`/`Conflict`'s
 * `resource`/`identifier`) is surfaced verbatim as {@link HttpClientError.data}
 * when the body carries an audited `data` object; `undefined` otherwise —
 * including for a masked `EngineFailure`, whose flat body carries no `data`.
 *
 * @example
 * ```ts
 * import { HttpClient, HttpClientError } from '@lostgradient/weft';
 *
 * const client = new HttpClient({ baseUrl: 'http://localhost:3000' });
 * try {
 *   await client.cancel('nonexistent-id');
 * } catch (err) {
 *   if (err instanceof HttpClientError) {
 *     if (err.status === 404 && err.data?.['resource'] === 'workflow') {
 *       // handle a missing resource specifically
 *     } else if (err.category === 'resource') {
 *       // back off on rate limits and capacity faults
 *     }
 *     console.error('HTTP', err.status, err.faultCode ?? err.message);
 *   }
 * }
 * ```
 */
export class HttpClientError extends WeftError<'HttpClientError'> {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /**
   * The server's stable wire fault code, when the response carried a structured
   * fault body. `undefined` for plain-string error bodies or unrecognized codes.
   */
  readonly faultCode?: FaultCode | undefined;
  /**
   * The {@link FailureCategory} derived from {@link faultCode}. Derived, not
   * carried on the wire; `undefined` when `faultCode` is `undefined`.
   */
  readonly category?: FailureCategory | undefined;
  /**
   * The fine-grained originating public {@link WeftErrorCode} the server
   * attached (e.g. `WorkflowNotFoundError`), when the structured fault carried
   * one. This is what makes cross-transport branching work: a producer can call
   * `isWeftFault(error, 'WorkflowNotFoundError')` and have it match over HTTP
   * exactly as it matches the in-process typed error. `undefined` when the fault
   * carried only the coarse {@link faultCode} (most faults) or no structured body.
   */
  readonly weftCode?: WeftErrorCode | undefined;
  /**
   * The fault's wire `data` payload, when the response carried a structured
   * body (`{ error, data }` for production REST, nested `{ error: { data } }`
   * for structured REST responses, or `error.data` for JSON-RPC). Shape is
   * fault-code-dependent — see {@link FaultCode} and the server's
   * `OperationFault` per-code `data` union for what each code carries (e.g.
   * `InvalidParams.data.issues`, `NotFound.data.resource`). `undefined` for
   * plain-string error bodies, bodies with no `data` field, or a `data` field
   * that is not a JSON object.
   *
   * Over JSON-RPC-over-HTTP this is the raw envelope `error.data` verbatim
   * (see `httpClientCatalogTransport` in `http-operations.ts`), so it also
   * carries the envelope's own `weftCode` (the coarse {@link FaultCode}, not
   * a fine-grained {@link WeftErrorCode}) and `httpStatus` keys alongside the
   * per-code payload — those two are not part of the `OperationFault` data
   * union.
   */
  readonly data?: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    message: string,
    options?: {
      faultCode?: FaultCode | undefined;
      weftCode?: WeftErrorCode | undefined;
      data?: Readonly<Record<string, unknown>> | undefined;
    },
  ) {
    super('HttpClientError', message);
    this.status = status;
    this.faultCode = options?.faultCode;
    this.category =
      options?.faultCode === undefined ? undefined : failureCategoryForFaultCode(options.faultCode);
    this.weftCode = options?.weftCode;
    this.data = options?.data;
  }
}

function buildRequestHeaders(
  baseHeaders: Record<string, string>,
  options: RequestInit | undefined,
): Headers {
  const headers = new Headers(baseHeaders);
  if (options?.headers) {
    const extra = new Headers(options.headers);
    for (const [key, value] of extra) {
      headers.set(key, value);
    }
  }
  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

/**
 * Flat error body shape from `shapeRestFault`: `{ error: string }`, optionally
 * with top-level `weftCode` and audited `data` siblings.
 */
function isFlatErrorBody(
  value: unknown,
): value is { error: string; weftCode?: unknown; data?: unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

function parseFlatErrorBody(body: { error: string; weftCode?: unknown; data?: unknown }): {
  message: string;
  weftCode?: WeftErrorCode;
  data?: Readonly<Record<string, unknown>>;
} {
  const weftCode = isWeftErrorCode(body.weftCode) ? body.weftCode : undefined;
  const data = isRecord(body.data) ? body.data : undefined;
  return {
    message: body.error,
    ...(weftCode === undefined ? {} : { weftCode }),
    ...(data === undefined ? {} : { data }),
  };
}

/**
 * Structured error body accepted from older or alternate servers:
 * `{ error: { code, message, data? } }`. Current Weft REST responses use the
 * flat shape above. The human `message` is required; `code` and `data` are
 * validated separately so an unrecognized (e.g. future) fault code still
 * surfaces its message — only the typed {@link FaultCode} is withheld.
 */
function isStructuredErrorBody(
  value: unknown,
): value is { error: { code?: unknown; message: string; data?: unknown } } {
  if (value === null || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return false;
  return typeof (error as { message?: unknown }).message === 'string';
}

/**
 * Pull the fine-grained `weftCode` out of a structured fault's `data`, when the
 * server attached a recognized public code. Returns `undefined` for faults that
 * carry only the coarse code or no `data.weftCode`.
 */
function weftCodeFromData(data: unknown): WeftErrorCode | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const candidate = (data as { weftCode?: unknown }).weftCode;
  return isWeftErrorCode(candidate) ? candidate : undefined;
}

/**
 * Narrow an untrusted wire `data` value to a plain JSON object. The wire body
 * is server-controlled but crosses a network boundary, so `data` is
 * shape-checked before being surfaced on {@link HttpClientError.data} rather
 * than trusted as-is; arrays and primitives are rejected.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a non-2xx response body into the human message and, when the server
 * sent a structured fault, its coarse wire {@link FaultCode}, any fine-grained
 * {@link WeftErrorCode} (`data.weftCode`), and the fault's typed `data`
 * payload. A structured body with an unknown code still yields its message.
 * Falls back to `response.statusText` when the body is missing, non-JSON, or
 * carries no usable message.
 */
async function parseErrorBody(response: Response): Promise<{
  message: string;
  faultCode?: FaultCode | undefined;
  weftCode?: WeftErrorCode;
  data?: Readonly<Record<string, unknown>>;
}> {
  try {
    const body: unknown = await response.json();
    if (isStructuredErrorBody(body)) {
      const { code, message, data } = body.error;
      const weftCode = weftCodeFromData(data);
      const base: {
        message: string;
        weftCode?: WeftErrorCode;
        data?: Readonly<Record<string, unknown>>;
      } = { message };
      if (weftCode !== undefined) base.weftCode = weftCode;
      if (isRecord(data)) base.data = data;
      return isFaultCode(code) ? { ...base, faultCode: code } : base;
    }
    if (isFlatErrorBody(body) && body.error) {
      // `shapeRestFault` flat body, optionally with top-level `weftCode` and
      // audited `data` siblings. The masked EngineFailure body has neither.
      return parseFlatErrorBody(body);
    }
    return { message: response.statusText };
  } catch {
    return { message: response.statusText };
  }
}

export async function request<T>(
  baseUrl: string,
  path: string,
  baseHeaders: Record<string, string>,
  options?: RequestInit,
): Promise<T> {
  const headers = buildRequestHeaders(baseHeaders, options);
  const response = await fetch(`${baseUrl}/v1${path}`, { ...options, headers });

  if (response.status === 404 && (!options?.method || options.method === 'GET')) {
    return null as T;
  }
  if (!response.ok) {
    const { message, faultCode, weftCode, data } = await parseErrorBody(response);
    throw new HttpClientError(response.status, message, { faultCode, weftCode, data });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
