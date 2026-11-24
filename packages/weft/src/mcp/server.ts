import {
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ResourceNotFoundError,
  type CallToolResult,
  type JsonSchemaType,
  type McpRequestContext,
  type McpServerFactory,
  type RegisteredTool,
} from '@modelcontextprotocol/server';

import type { Principal } from "../embedded/backchannel/src/index.ts";
import type { Engine } from '../core/engine.ts';
import { VERSION } from '../version.ts';
import { McpToolExecutionError, type McpAccessContext } from './access.ts';
import type { McpChangeFeed } from './change-feed.ts';
import {
  isWorkflowSearchResourceUri,
  listMcpResources,
  listMcpResourceTemplates,
  readMcpResource,
  workflowResourceUri,
} from './resources.ts';
import { callMcpTool, listMcpTools, type McpToolDefinition } from './tools.ts';

/**
 * What one server instance serves with: the engine, the caller's principal
 * and whether the endpoint requires authentication, and the protocol era the
 * instance is bound to.
 *
 * @example
 * ```ts
 * import type { McpServerContext } from '@lostgradient/weft';
 *
 * function describe(context: McpServerContext): string {
 *   return `${context.era} era, principal ${context.principal.method}`;
 * }
 * void describe;
 * ```
 */
export type McpServerContext = McpAccessContext & {
  readonly era: McpRequestContext['era'];
};

/**
 * Registers further tools or prompts on each SDK server instance Weft builds,
 * after Weft has registered the operation-catalog tool projection and its
 * workflow resources. Instances are built per HTTP request and per stdio
 * connection, so a registrar runs many times and must only register; keep any
 * state outside it. Resources are Weft's own: a registrar must not register
 * resources, because Weft serves `resources/*` itself.
 *
 * @example
 * ```ts
 * import type { McpServerRegistrar } from '@lostgradient/weft';
 *
 * const registerPing: McpServerRegistrar = (server, context) => {
 *   server.registerTool('ping', { description: 'Answer pong.' }, async () => ({
 *     content: [{ type: 'text', text: `pong (${context.era})` }],
 *   }));
 * };
 * void registerPing;
 * ```
 */
export type McpServerRegistrar = (server: McpServer, context: McpServerContext) => void;

/** How Weft builds the SDK server instances one MCP entry serves. */
export type McpServerFactoryOptions = {
  readonly engine: Engine;
  /** Resolves the caller from the SDK's per-instance construction context. */
  readonly access: (request: McpRequestContext) => {
    readonly principal: Principal;
    readonly authRequired: boolean;
  };
  /**
   * `request` for the HTTP entry, which builds one instance per request;
   * `connection` for stdio, which pins one instance for the connection and
   * pushes engine changes to it through `feed`.
   */
  readonly lifetime: 'request' | 'connection';
  readonly feed?: McpChangeFeed;
  readonly registrars?: ReadonlyArray<McpServerRegistrar>;
  /** Receives work a tool call starts and does not await; see `McpToolCallContext`. */
  readonly trackPendingWork?: ((work: Promise<unknown>) => void) | undefined;
};

const SERVER_INFO = { name: 'weft', title: 'Weft', version: VERSION };

/**
 * Build the SDK server factory every Weft MCP entry serves from. Each
 * instance registers the operation-catalog tool projection (`listMcpTools`)
 * and Weft's workflow resources, then runs the configured registrars.
 */
export function createMcpServerFactory(options: McpServerFactoryOptions): McpServerFactory {
  return (request) => buildServer(options, request);
}

function buildServer(options: McpServerFactoryOptions, request: McpRequestContext): McpServer {
  const context: McpServerContext = {
    engine: options.engine,
    ...options.access(request),
    era: request.era,
  };
  // A 2025-era instance can only deliver `resources/updated` over a
  // connection it keeps (stdio). The stateless HTTP lane answers one request
  // and keeps nothing, so it does not offer subscriptions; the 2026-07-28
  // lane subscribes through the SDK's `subscriptions/listen`.
  const subscriptions =
    options.lifetime === 'connection' && request.era === 'legacy' ? new Set<string>() : undefined;
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: { listChanged: true },
      resources: {
        subscribe: request.era === 'modern' || subscriptions !== undefined,
        listChanged: false,
      },
    },
  });
  const tools = new ProjectedTools(server, context, options.trackPendingWork);
  registerResourceHandlers(server, context, subscriptions);
  for (const registrar of options.registrars ?? []) registrar(server, context);
  if (options.lifetime === 'connection' && options.feed !== undefined) {
    options.feed.attach({
      workflowChanged: (workflowId) => {
        notifyWorkflowChanged(server, workflowId, subscriptions);
      },
      toolsChanged: () => {
        tools.synchronize();
      },
    });
  }
  return server;
}

/**
 * The operation-catalog tools registered on one instance. A long-lived
 * (stdio) instance re-synchronizes them when the engine's registry changes;
 * the SDK announces each change with `notifications/tools/list_changed`.
 */
class ProjectedTools {
  readonly #server: McpServer;
  readonly #context: McpServerContext;
  readonly #registered = new Map<string, { signature: string; tool: RegisteredTool }>();
  readonly #trackPendingWork: ((work: Promise<unknown>) => void) | undefined;

  constructor(
    server: McpServer,
    context: McpServerContext,
    trackPendingWork: ((work: Promise<unknown>) => void) | undefined,
  ) {
    this.#server = server;
    this.#context = context;
    this.#trackPendingWork = trackPendingWork;
    this.synchronize();
  }

  synchronize(): void {
    const definitions = new Map(
      listMcpTools(this.#context.engine).map((definition) => [definition.name, definition]),
    );
    for (const [name, entry] of this.#registered) {
      const definition = definitions.get(name);
      if (definition !== undefined && toolSignature(definition) === entry.signature) {
        definitions.delete(name);
        continue;
      }
      entry.tool.remove();
      this.#registered.delete(name);
    }
    for (const definition of definitions.values()) {
      this.#registered.set(definition.name, {
        signature: toolSignature(definition),
        tool: this.#register(definition),
      });
    }
  }

  #register(definition: McpToolDefinition): RegisteredTool {
    const context = this.#context;
    return this.#server.registerTool(
      definition.name,
      {
        ...(definition.title !== undefined ? { title: definition.title } : {}),
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema as JsonSchemaType),
      },
      async (argumentsValue, handlerContext): Promise<CallToolResult> => {
        const result = await callMcpTool(definition.name, argumentsValue, {
          engine: context.engine,
          principal: context.principal,
          authRequired: context.authRequired,
          signal: handlerContext.mcpReq.signal,
          trackPendingWork: this.#trackPendingWork,
        });
        return {
          content: result.content.map((block) => ({ ...block })),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: { ...result.structuredContent } }),
        };
      },
    );
  }
}

function toolSignature(definition: McpToolDefinition): string {
  return JSON.stringify([definition.title, definition.description, definition.inputSchema]);
}

function registerResourceHandlers(
  server: McpServer,
  context: McpServerContext,
  subscriptions: Set<string> | undefined,
): void {
  const lowLevel = server.server;
  lowLevel.setRequestHandler('resources/list', async () => ({
    resources: await withAccessErrors(() => listMcpResources(context)),
  }));
  lowLevel.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: listMcpResourceTemplates(),
  }));
  lowLevel.setRequestHandler('resources/read', async (request) => {
    const result = await readVisibleResource(request.params.uri, context);
    return { contents: result.contents.map((content) => ({ ...content })) };
  });
  if (subscriptions === undefined) return;
  lowLevel.setRequestHandler('resources/subscribe', async (request) => {
    await readVisibleResource(request.params.uri, context);
    subscriptions.add(request.params.uri);
    return {};
  });
  lowLevel.setRequestHandler('resources/unsubscribe', async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });
}

async function readVisibleResource(uri: string, context: McpServerContext) {
  const result = await withAccessErrors(() => readMcpResource(uri, context));
  if (result === null) throw new ResourceNotFoundError(uri);
  return result;
}

/** Report an access refusal as the MCP forbidden error rather than an internal error. */
async function withAccessErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpToolExecutionError) {
      throw new ProtocolError(-32011, error.message, { reason: error.message });
    }
    throw error;
  }
}

function notifyWorkflowChanged(
  server: McpServer,
  workflowId: string,
  subscriptions: ReadonlySet<string> | undefined,
): void {
  if (!server.isConnected()) return;
  const workflowUris = (['state', 'events', 'checkpoints'] as const).map((kind) =>
    workflowResourceUri(workflowId, kind),
  );
  // A 2026-07-28 connection filters by each `subscriptions/listen` request's
  // own URI list, so it receives every candidate. A 2025-era connection keeps
  // its subscriptions here, and any workflow change may change a search.
  const uris =
    subscriptions === undefined
      ? workflowUris
      : [
          ...workflowUris.filter((uri) => subscriptions.has(uri)),
          ...[...subscriptions].filter(isWorkflowSearchResourceUri),
        ];
  for (const uri of uris) {
    server.server.sendResourceUpdated({ uri }).catch((error: unknown) => {
      console.warn('[weft.mcp] Failed to send a resource update notification:', error);
    });
  }
}
