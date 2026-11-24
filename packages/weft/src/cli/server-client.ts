/**
 * Shared invocation seam for hand-authored, server-facing CLI commands.
 *
 * Every noun-verb command (`server`, `workflow`, `tail`) routes its operation
 * calls through {@link callCatalogOperation}, which wraps the generated typed
 * client. The generated client is the only path to the wire: commands never
 * build HTTP requests directly, so the compiler rejects any reference to an
 * operation the catalog does not define (drift is caught at build time).
 *
 * At runtime this helper maps two failure shapes the typed client cannot
 * express on its own: connection failures (server unreachable) and version
 * skew (a newer wrapper calling an operation an older server lacks). The
 * latter surfaces as a specific compatibility message instead of a raw
 * `Method not found` / HTTP 404 dump.
 *
 * @module cli/server-client
 */

import {
  CatalogClientError,
  createCatalogClient,
  type CatalogFetch,
} from "../embedded/backchannel/src/client/index.ts";
import { httpJsonRpcTransport } from '../client/weft-connection-transport.ts';
import {
  CATALOG_OPERATION_NAMES,
  type CatalogOperationName,
  type CatalogOperationTypes,
  type ConnectionOptions,
} from '../index.ts';
import {
  cliFault,
  faultFromTransportFailure,
  faultFromWireError,
  type CliFault,
} from './cli-fault.ts';

/**
 * Successful or failed result of a catalog operation call, never thrown. A failure carries its
 * {@link CliFault} (`code`, `message`, `retryable`, `remediation`) beside the `kind` that decides
 * the exit code.
 */
export type CatalogCallResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | ({ readonly ok: false; readonly kind: 'connection' } & CliFault)
  | ({ readonly ok: false; readonly kind: 'compat' } & CliFault)
  | ({
      readonly ok: false;
      readonly kind: 'operation';
      /** Present and `true` when the server answered with its `NotFound` fault. */
      readonly notFound?: true;
    } & CliFault);

/**
 * Invoke a single catalog operation through the generated typed client and
 * normalize every failure into a {@link CatalogCallResult}. The operation name
 * is a typed catalog key, so an unknown operation is a compile error rather
 * than a runtime surprise.
 */
export async function callCatalogOperation<Name extends CatalogOperationName>(
  connection: ConnectionOptions,
  operationName: Name,
  input: CatalogOperationTypes[Name]['input'],
): Promise<CatalogCallResult<CatalogOperationTypes[Name]['output']>> {
  const client = createCatalogClient<CatalogOperationTypes>(
    CATALOG_OPERATION_NAMES,
    httpJsonRpcTransport(connection),
  );
  // The transport drops the HTTP status of an answer that is not JSON-RPC (an authentication
  // challenge, a proxy error); the call's own `fetch` sees it, so a refused credential is told
  // from a server that is down.
  let lastHttpStatus: number | undefined;
  const recordingFetch: CatalogFetch = async (request, init) => {
    const response = await fetch(request, init);
    lastHttpStatus = response.status;
    return response;
  };
  try {
    const value = await client[operationName](input, { fetch: recordingFetch });
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CatalogClientError) {
      if (error.isUnknownOperation) {
        return {
          ok: false,
          kind: 'compat',
          ...cliFault(
            'MethodNotFound',
            `operation ${operationName} is not available on this server; the server is older than this CLI`,
            "Run 'weft server info' to compare versions, or upgrade the server",
          ),
        };
      }
      return {
        ok: false,
        kind: 'operation',
        ...faultFromWireError(error.message, error.data),
        ...(isNotFoundFaultData(error.data) ? { notFound: true as const } : {}),
      };
    }
    return {
      ok: false,
      kind: 'connection',
      ...faultFromTransportFailure({ error, httpStatus: lastHttpStatus }),
    };
  }
}

/**
 * Exit code of a command whose target does not exist: the server answered with its `NotFound`
 * fault. Apart from the other failures (1) so a script can tell "no such workflow" from "the
 * operation failed".
 */
export const NOT_FOUND_EXIT_CODE = 5;

/** Whether a fault's `data` is the server's `NotFound` fault, whose `weftCode` is the coarse fault code. */
function isNotFoundFaultData(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Reflect.get(data, 'weftCode') === 'NotFound';
}

/** Exit code for a {@link CatalogCallResult} failure, by failure kind. */
export function failureExitCode(kind: 'connection' | 'compat' | 'operation'): number {
  if (kind === 'connection') return 2;
  if (kind === 'compat') return 4;
  return 1;
}
