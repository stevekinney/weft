import { principalFromStdioLocal } from "../embedded/backchannel/src/index.ts";
import { inProcessCatalogTransport, type CatalogTransport } from "../embedded/backchannel/src/client/index.ts";
import { WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';
import type { Engine } from '../core/engine.ts';
import { createLiveOperationRegistry } from '../server/rest-bindings.ts';

/** Bind the embedded catalog client to Weft's engine and trusted local principal. */
export function weftInProcessCatalogTransport(
  engine: Engine,
  restOperationNames: ReadonlySet<string> = new Set(),
): CatalogTransport {
  return inProcessCatalogTransport({
    registry: createLiveOperationRegistry(),
    principal: principalFromStdioLocal(WEFT_SCOPE_VOCABULARY),
    host: engine,
    restOperationNames,
  });
}
