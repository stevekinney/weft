/**
 * In-process catalog transport for {@link LocalClient}.
 *
 * The generated catalog client ({@link createWeftClient}) speaks JSON-RPC over
 * HTTP by default. For the embedded library client there is no server to talk
 * to, so this module supplies a {@link CatalogTransport} that routes the exact
 * same operation calls straight through the shared `executeOperation` pipeline
 * against a local {@link Engine}.
 *
 * This is the seam that lets `LocalClient` and `HttpClient` expose one
 * generated low-level surface — `client.operations.<op>` / `client.call(op,
 * input)` — covering every catalog operation, not just the curated ergonomic
 * methods, while still routing local calls to the in-process engine.
 *
 * @module client/in-process-operations
 */

import type { CatalogTransport } from '../cli/operation-client-runtime.ts';
import type { Engine } from '../core/engine.ts';
import { executeOperation } from '../server/operation-catalog.ts';
import { principalFromStdioLocal } from '../server/principal.ts';
import { createLiveOperationRegistry } from '../server/rest-bindings.ts';

/**
 * Build a {@link CatalogTransport} that dispatches catalog operations against
 * an in-process {@link Engine}.
 *
 * The registry and trusted principal are constructed once and reused across
 * calls. Operations run with `transport: 'jsonRpcHttp'` so input/output
 * validation and unknown-key handling match the remote JSON-RPC path exactly.
 * A failed dispatch throws with the fault message, mirroring the HTTP
 * transport's `throw new Error(result.error.message)` contract so both clients
 * surface operation faults the same way.
 */
export function inProcessCatalogTransport(engine: Engine): CatalogTransport {
  const registry = createLiveOperationRegistry();
  const principal = principalFromStdioLocal();

  return async (operationName, input) => {
    const result = await executeOperation(operationName, input, {
      principal,
      engine,
      transport: 'jsonRpcHttp',
      registry,
    });
    if (!result.ok) throw new Error(result.fault.message);
    return result.value;
  };
}
