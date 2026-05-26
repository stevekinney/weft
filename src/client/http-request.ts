import { WeftError } from '../core/weft-error.ts';

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
  /** Base URL of the Weft server (e.g. `http://localhost:3000`). */
  baseUrl: string;
  /** Optional headers to include on every request (e.g. auth tokens). */
  headers?: Record<string, string>;
}

/**
 * Error thrown when the server returns a non-2xx response.
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
 *     console.error('HTTP', err.status, err.message);
 *   }
 * }
 * ```
 */
export class HttpClientError extends WeftError<'HttpClientError'> {
  readonly status: number;

  constructor(status: number, message: string) {
    super('HttpClientError', message);
    this.status = status;
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

function isErrorBody(value: unknown): value is { error?: string } {
  if (value === null || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return error === undefined || typeof error === 'string';
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    return isErrorBody(body) && body.error ? body.error : response.statusText;
  } catch {
    return response.statusText;
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
    const message = await parseErrorBody(response);
    throw new HttpClientError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
