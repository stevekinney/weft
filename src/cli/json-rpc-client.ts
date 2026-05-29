import { resolveCliConnection, type CliConnectionOptions } from './connection.ts';

export type JsonRpcErrorObject = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

export type JsonRpcCallResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: JsonRpcErrorObject };

export async function sendJsonRpcRequest(
  connectionOptions: CliConnectionOptions,
  method: string,
  params: unknown,
  id: string,
): Promise<JsonRpcCallResult> {
  const connection = await resolveCliConnection(connectionOptions);
  const response = await fetch(jsonRpcEndpoint(connection.server), {
    method: 'POST',
    headers: requestHeaders(connection.token),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id,
    }),
  });
  const body = (await response.json()) as unknown;
  if (isJsonRpcError(body)) return { ok: false, error: body.error };
  if (isJsonRpcResult(body)) return { ok: true, result: body.result };
  throw new Error(`Invalid JSON-RPC response from ${connection.server.toString()}`);
}

export function jsonRpcEndpoint(server: URL): URL {
  const endpoint = new URL(server.toString());
  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${basePath}jsonrpc`.replaceAll(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function requestHeaders(token: string | undefined): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== undefined && token !== '') headers.set('authorization', `Bearer ${token}`);
  return headers;
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

function isJsonRpcResult(value: unknown): value is { readonly result: unknown } {
  return typeof value === 'object' && value !== null && 'result' in value;
}
