import { resolveConnection } from '../connection.ts';
import { failureCategoryForFaultCode, isFaultCode, type FaultCode } from '../core/fault-code.ts';
import type { FailureCategory } from '../core/types/identity.ts';
import { WeftError } from '../core/weft-error.ts';
import type { WebSocketFactory } from './event-stream.ts';

/**
 * Configuration for the HTTP client.
 *
 * @example
 * ```ts
 * import { HttpClient, type HttpClientOptions } from 'weft';
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
 * When the server sends a structured fault body (`{ error: { code, message } }`),
 * the wire fault `code` is surfaced as {@link HttpClientError.faultCode} and a
 * derived {@link HttpClientError.category} so callers can branch programmatically
 * instead of string-matching `message`. Both are `undefined` when the body is a
 * plain `{ error: string }` or carries no recognized code.
 *
 * @example
 * ```ts
 * import { HttpClient, HttpClientError } from 'weft';
 *
 * const client = new HttpClient({ baseUrl: 'http://localhost:3000' });
 * try {
 *   await client.cancel('nonexistent-id');
 * } catch (err) {
 *   if (err instanceof HttpClientError) {
 *     if (err.faultCode === 'NotFound') {
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

  constructor(status: number, message: string, options?: { faultCode?: FaultCode | undefined }) {
    super('HttpClientError', message);
    this.status = status;
    this.faultCode = options?.faultCode;
    this.category =
      options?.faultCode === undefined ? undefined : failureCategoryForFaultCode(options.faultCode);
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

/** Flat error body shape from `shapeOperationFaultAsJson`: `{ error: string }`. */
function isFlatErrorBody(value: unknown): value is { error: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

/**
 * Structured error body from `faultToHttpResponse`:
 * `{ error: { code, message, data? } }`. The human `message` is required; the
 * `code` is validated separately so an unrecognized (e.g. future) fault code
 * still surfaces its message — only the typed {@link FaultCode} is withheld.
 */
function isStructuredErrorBody(
  value: unknown,
): value is { error: { code?: unknown; message: string } } {
  if (value === null || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return false;
  return typeof (error as { message?: unknown }).message === 'string';
}

/**
 * Parse a non-2xx response body into the human message and, when the server
 * sent a structured fault with a recognized code, its wire {@link FaultCode}.
 * A structured body with an unknown code still yields its message. Falls back
 * to `response.statusText` when the body is missing, non-JSON, or carries no
 * usable message.
 */
async function parseErrorBody(
  response: Response,
): Promise<{ message: string; faultCode?: FaultCode | undefined }> {
  try {
    const body: unknown = await response.json();
    if (isStructuredErrorBody(body)) {
      const { code, message } = body.error;
      return isFaultCode(code) ? { message, faultCode: code } : { message };
    }
    if (isFlatErrorBody(body) && body.error) {
      return { message: body.error };
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
    const { message, faultCode } = await parseErrorBody(response);
    throw new HttpClientError(response.status, message, { faultCode });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
