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

import type { ConnectionOptions } from '../connection.ts';
import {
  CATALOG_OPERATION_NAMES,
  type CatalogOperationName,
  type CatalogOperationTypes,
} from './generated/operation-client.generated.ts';
import { CatalogClientError, createCatalogWeftClient } from './operation-client-runtime.ts';
import { messageOf } from './output.ts';

/** Successful or failed result of a catalog operation call, never thrown. */
export type CatalogCallResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly kind: 'connection'; readonly message: string }
  | { readonly ok: false; readonly kind: 'compat'; readonly message: string }
  | { readonly ok: false; readonly kind: 'operation'; readonly message: string };

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
  const client = createCatalogWeftClient<CatalogOperationTypes>(
    CATALOG_OPERATION_NAMES,
    connection,
  );
  try {
    const value = await client[operationName](input);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CatalogClientError) {
      if (error.isUnknownOperation) {
        return {
          ok: false,
          kind: 'compat',
          message: `operation ${operationName} is not available on this server; the server is older than this CLI. Run 'weft server info' to compare versions, or upgrade the server`,
        };
      }
      return { ok: false, kind: 'operation', message: error.message };
    }
    return { ok: false, kind: 'connection', message: messageOf(error) };
  }
}

/** Exit code for a {@link CatalogCallResult} failure, by failure kind. */
export function failureExitCode(kind: 'connection' | 'compat' | 'operation'): number {
  if (kind === 'connection') return 2;
  if (kind === 'compat') return 4;
  return 1;
}
