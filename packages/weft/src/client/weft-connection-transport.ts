import {
  httpJsonRpcTransport as httpJsonRpcTransportForServer,
  type CatalogTransport,
} from "../embedded/backchannel/src/client/index.ts";
import { resolveConnection, type ConnectionOptions } from '../connection.ts';

/**
 * How a client reaches a Weft server: the same settings `ConnectionOptions`
 * describes, under the name the client surface uses.
 *
 * Every field is optional, so `{}` means "resolve everything from the
 * environment, profile, or default address". Library code should set
 * `includeRunLockfile: false`, so a local `weft serve` lockfile left behind on
 * a developer's machine cannot silently become the target.
 *
 * @example
 * ```ts
 * import { createWeftClient, type WeftClientConnection } from '@lostgradient/weft';
 *
 * const connection: WeftClientConnection = {
 *   server: 'https://weft.internal:7233',
 *   includeRunLockfile: false,
 * };
 *
 * const client = createWeftClient(connection);
 * console.log(typeof client);
 * ```
 */
export type WeftClientConnection = ConnectionOptions;

/**
 * Transport that dispatches catalog operations as JSON-RPC requests to a
 * remote Weft server, resolving the connection (server URL + token) per call.
 *
 * Because the connection resolves per call rather than once at construction, a
 * token that rotates, or a profile that changes between calls, is picked up
 * without rebuilding the client. Failures arrive as `CatalogClientError`, and
 * each call's `signal` and `fetch` reach the request.
 *
 * Weft's root does not export it, because `@lostgradient/backchannel/client` already exports
 * a transport of that name; the generated client and the CLI import this one directly.
 *
 * @example
 * ```ts
 * import { createWeftClient } from '@lostgradient/weft';
 *
 * const client = createWeftClient({
 *   server: 'http://localhost:7233',
 *   includeRunLockfile: false,
 * });
 *
 * const alerts = await client['weft.alerts.list']({});
 * console.log(alerts);
 * ```
 */
export function httpJsonRpcTransport(
  connectionOptions: WeftClientConnection = {},
): CatalogTransport {
  return (operationName, input, options) => {
    const connection = resolveConnection(connectionOptions);
    const token = connection.token;
    return httpJsonRpcTransportForServer({
      baseUrl: connection.server.toString(),
      requestId: 'weft-client',
      ...(token === undefined || token === ''
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
    })(operationName, input, options);
  };
}
