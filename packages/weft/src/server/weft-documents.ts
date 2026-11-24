/**
 * What makes the generic document generators Weft's: the title and version Weft's documents carry,
 * and the `rpc.discover` document of an engine-hosted server, which lists the engine's MCP tools.
 *
 * The generators (`openapi.ts`, `openrpc.ts`, `asyncapi.ts`) and the JSON-RPC dispatcher name no
 * server in particular. Weft's own entry points call through this module, and an application that
 * serves its own operations passes its own title and version.
 *
 * @module server/weft-documents
 */

import type { DiscoveryInfo } from "../embedded/backchannel/src/index.ts";
import {
  type OperationRegistry,
  generateOpenRpcDocument,
} from "../embedded/backchannel/src/internals.ts";
import type { Engine } from '../core/engine.ts';
import { listMcpTools } from '../mcp/tools.ts';
import { VERSION } from '../version.ts';

/** The title of Weft's own documents. */
export const WEFT_DOCUMENT_TITLE = 'Weft Workflow Engine';

/**
 * `info` with Weft's title and version filled in where it carries none. An application serving
 * its own operations sets its own title, and so overrides Weft's.
 */
export function weftDiscoveryInfo(info: DiscoveryInfo | undefined): DiscoveryInfo {
  return {
    ...info,
    title: info?.title ?? WEFT_DOCUMENT_TITLE,
    version: info?.version ?? VERSION,
  };
}

/**
 * The document `rpc.discover` answers with on a Weft server: HTTP and WebSocket methods, with the
 * MCP tools of a duck-typed engine host. The tools are listed on every call, so a workflow
 * registered after the session opened is listed.
 */
export function createWeftDiscoverDocument(
  registry: OperationRegistry,
  host: unknown,
): () => Record<string, unknown> {
  return () => {
    const engine = asMcpToolProvider(host);
    return generateOpenRpcDocument({
      registry,
      transports: ['http', 'websocket'],
      discoveryInfo: weftDiscoveryInfo(undefined),
      ...(engine === null ? {} : { mcpTools: listMcpTools(engine) }),
    });
  };
}

function asMcpToolProvider(host: unknown): Engine | null {
  if (
    host !== null &&
    typeof host === 'object' &&
    'listWorkflowDefinitions' in host &&
    typeof host.listWorkflowDefinitions === 'function'
  ) {
    return host as Engine;
  }
  return null;
}
