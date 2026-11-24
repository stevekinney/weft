/**
 * Test-only builder for the wire goldens: Weft's generated OpenAPI, OpenRPC and AsyncAPI
 * documents and its catalog snapshot, built from the live registry and REST bindings.
 */

import { join } from 'node:path';

import {
  generateAsyncApiDocument,
  generateOpenApiDocument,
  generateOpenRpcDocument,
} from "../embedded/backchannel/src/internals.ts";
import {
  formatGoldenJson,
  withGoldenVersion,
  writeGoldenDirectory,
} from "../embedded/backchannel/src/testing.ts";
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';
import { createCatalogSnapshot } from './weft-catalog-snapshot.ts';
import { weftDiscoveryInfo } from './weft-documents.ts';

export const WIRE_GOLDEN_DIRECTORY = join(import.meta.dir, '__fixtures__', 'wire-golden');

/** The golden files, keyed by file name. */
export function buildWireGolden(): Record<string, string> {
  const registry = createLiveOperationRegistry();
  const restBindings = createLiveRestBindings();
  const discoveryInfo = weftDiscoveryInfo(undefined);
  return {
    'openapi.json': formatGoldenJson(
      withGoldenVersion(generateOpenApiDocument({ registry, restBindings, discoveryInfo })),
    ),
    'openrpc.json': formatGoldenJson(
      withGoldenVersion(
        generateOpenRpcDocument({ registry, transports: ['http', 'websocket'], discoveryInfo }),
      ),
    ),
    'asyncapi.json': formatGoldenJson(
      withGoldenVersion(generateAsyncApiDocument({ registry, restBindings, discoveryInfo })),
    ),
    'catalog-snapshot.json': formatGoldenJson(createCatalogSnapshot()),
  };
}

/** Rewrite a directory to hold exactly the wire goldens. */
export async function writeWireGolden(directory: string): Promise<void> {
  await writeGoldenDirectory(directory, buildWireGolden());
}
