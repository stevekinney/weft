/**
 * HTTP catalog transport for {@link HttpClient}.
 *
 * Posts JSON-RPC requests to the client's own `${baseUrl}/jsonrpc` endpoint
 * using the client's configured headers. Unlike the CLI's
 * {@link httpJsonRpcTransport}, this transport does not consult on-disk CLI
 * profiles or run lockfiles — a programmatic {@link HttpClient} is constructed
 * with an explicit `baseUrl` and headers, so connection resolution would be
 * wrong here.
 *
 * @module client/http-operations
 */

import type { CatalogTransport } from '../cli/operation-client-runtime.ts';
import { HttpClientError } from './http-request.ts';

type JsonRpcSuccess = { readonly result: unknown };
type JsonRpcFailure = { readonly error: { readonly code: number; readonly message: string } };

function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  );
}

function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  return typeof value === 'object' && value !== null && 'result' in value;
}

/**
 * Build a {@link CatalogTransport} that dispatches catalog operations as
 * JSON-RPC requests to a remote Weft server at `${baseUrl}/jsonrpc`.
 *
 * A JSON-RPC error envelope is surfaced as an {@link HttpClientError} so faults
 * reach callers through the same error type the ergonomic HTTP methods use.
 */
export function httpClientCatalogTransport(
  baseUrl: string,
  headers: Record<string, string>,
): CatalogTransport {
  const endpoint = `${baseUrl}/jsonrpc`;
  return async (operationName, input) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: operationName,
        params: input,
        id: operationName,
      }),
    });
    const body = (await response.json()) as unknown;
    if (isJsonRpcFailure(body)) {
      throw new HttpClientError(response.status, body.error.message);
    }
    if (isJsonRpcSuccess(body)) return body.result;
    throw new HttpClientError(response.status, `Invalid JSON-RPC response from ${endpoint}`);
  };
}
