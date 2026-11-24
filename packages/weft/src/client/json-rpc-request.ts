import { callJsonRpc, type JsonRpcCallResult } from "../embedded/backchannel/src/client/index.ts";
import { resolveConnection, type ConnectionOptions } from '../connection.ts';

export async function sendJsonRpcRequest(
  connectionOptions: ConnectionOptions,
  method: string,
  params: unknown,
  id: string,
): Promise<JsonRpcCallResult> {
  const connection = resolveConnection(connectionOptions);
  const token = connection.token;
  return callJsonRpc({
    endpoint: jsonRpcEndpoint(connection.server).toString(),
    method,
    params,
    id,
    ...(token === undefined || token === ''
      ? {}
      : { headers: { authorization: `Bearer ${token}` } }),
  });
}

export function jsonRpcEndpoint(server: URL): URL {
  const endpoint = new URL(server.toString());
  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${basePath}jsonrpc`.replaceAll(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}
