import {
  CatalogClientError,
  type CatalogCallOptions,
  type CatalogFetch,
  type CatalogTransport,
  type JsonRpcCallResult,
  type JsonRpcErrorObject,
} from './catalog-client.ts';

/**
 * Where a JSON-RPC HTTP transport sends its calls, and what it sends with them.
 *
 * `baseUrl` is the address of the handler's root: an absolute URL
 * (`https://api.example.test`) or a path a browser resolves against its own
 * origin (`/api`). The transport appends `/jsonrpc`, so it never builds a
 * `URL` from the base and a relative one works. `headers` go on every call, such
 * as an `authorization` header; `fetch` is the transport's default and a call's
 * own `fetch` overrides it.
 *
 * @example
 * ```ts
 * import { httpJsonRpcTransport, type JsonRpcHttpConnection } from '@lostgradient/backchannel/client';
 *
 * const connection: JsonRpcHttpConnection = {
 *   baseUrl: '/api',
 *   headers: { authorization: 'Bearer token' },
 * };
 *
 * const transport = httpJsonRpcTransport(connection);
 * console.log(typeof transport);
 * ```
 */
export type JsonRpcHttpConnection = {
  /** The handler's root, absolute or a path the browser resolves. */
  readonly baseUrl: string;
  /** Headers sent with every call. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** The `fetch` to use unless a call brings its own. Defaults to the global one. */
  readonly fetch?: CatalogFetch | undefined;
  /** The JSON-RPC request `id` every call carries. Defaults to `catalog-client`. */
  readonly requestId?: string | undefined;
};

const DEFAULT_REQUEST_ID = 'catalog-client';

/**
 * The JSON-RPC endpoint of a handler: its base URL with any query or fragment
 * removed, any trailing slash trimmed, and `/jsonrpc` appended.
 *
 * It joins strings, so the base may be absolute or a path the browser resolves.
 *
 * @example
 * ```ts
 * import { jsonRpcHttpEndpoint } from '@lostgradient/backchannel/client';
 *
 * console.log(jsonRpcHttpEndpoint('https://api.example.test/base/')); // https://api.example.test/base/jsonrpc
 * console.log(jsonRpcHttpEndpoint('/api')); // /api/jsonrpc
 * ```
 */
export function jsonRpcHttpEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/[?#].*$/u, '').replace(/\/+$/u, '')}/jsonrpc`;
}

/**
 * One JSON-RPC call over HTTP: the `endpoint` to post to, the method and its
 * params, the `id` to send, and the headers, `fetch` and abort `signal` to send
 * them with.
 *
 * @example
 * ```ts
 * import type { JsonRpcHttpCall } from '@lostgradient/backchannel/client';
 *
 * const call: JsonRpcHttpCall = {
 *   endpoint: 'https://api.example.test/jsonrpc',
 *   method: 'probe.echo',
 *   params: { message: 'hello' },
 *   id: 'example',
 * };
 * console.log(call.method);
 * ```
 */
export type JsonRpcHttpCall = CatalogCallOptions & {
  /** The full URL to post to. */
  readonly endpoint: string;
  /** The operation name. */
  readonly method: string;
  /** The operation's input. */
  readonly params: unknown;
  /** The JSON-RPC request `id`. */
  readonly id: string;
  /** Headers sent with the call. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

/**
 * Post one JSON-RPC request and read the envelope: a success carries the
 * operation's result, a JSON-RPC error comes back as `ok: false` rather than a
 * throw. A response that is neither throws, as does a transport failure,
 * including an abort.
 *
 * @example
 * ```ts
 * import { callJsonRpc } from '@lostgradient/backchannel/client';
 *
 * const outcome = await callJsonRpc({
 *   endpoint: 'https://api.example.test/jsonrpc',
 *   method: 'probe.echo',
 *   params: { message: 'hello' },
 *   id: 'example',
 * });
 * console.log(outcome.ok);
 * ```
 */
export async function callJsonRpc(call: JsonRpcHttpCall): Promise<JsonRpcCallResult> {
  const send = call.fetch ?? globalThis.fetch;
  const response = await send(call.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...call.headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: call.method,
      params: call.params,
      id: call.id,
    }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  });
  const body = (await response.json()) as unknown;
  if (isJsonRpcError(body)) return { ok: false, error: body.error };
  // A success envelope carries `jsonrpc` and `id`, but `result` is absent when the operation
  // returns void: `JSON.stringify` drops an `undefined` result key on the server.
  if (isJsonRpcSuccess(body)) {
    return { ok: true, result: 'result' in body ? body.result : undefined };
  }
  throw new Error(`Invalid JSON-RPC response from ${call.endpoint}`);
}

/**
 * Transport that dispatches catalog operations as JSON-RPC requests to a
 * handler at `${baseUrl}/jsonrpc`. A JSON-RPC error arrives as a
 * {@link CatalogClientError}.
 *
 * Each call's `signal` and `fetch` reach the request, so a caller can cancel one
 * call or answer it from a fake.
 *
 * @example
 * ```ts
 * import { httpJsonRpcTransport } from '@lostgradient/backchannel/client';
 *
 * const transport = httpJsonRpcTransport({ baseUrl: 'https://api.example.test' });
 *
 * const result = await transport('probe.echo', { message: 'hello' }, { signal: AbortSignal.timeout(5000) });
 * console.log(result);
 * ```
 */
export function httpJsonRpcTransport(connection: JsonRpcHttpConnection): CatalogTransport {
  const endpoint = jsonRpcHttpEndpoint(connection.baseUrl);
  return async (operationName, input, options) => {
    const fetchOverride = options?.fetch ?? connection.fetch;
    const outcome = await callJsonRpc({
      endpoint,
      method: operationName,
      params: input,
      id: connection.requestId ?? DEFAULT_REQUEST_ID,
      headers: connection.headers,
      ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!outcome.ok) throw new CatalogClientError(operationName, outcome.error);
    return outcome.result;
  };
}

function isJsonRpcError(value: unknown): value is { readonly error: JsonRpcErrorObject } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'code' in value.error &&
    typeof value.error.code === 'number' &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  );
}

function isJsonRpcSuccess(value: unknown): value is { readonly result?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'jsonrpc' in value &&
    (value as Record<string, unknown>)['jsonrpc'] === '2.0' &&
    'id' in value &&
    !('error' in value)
  );
}
