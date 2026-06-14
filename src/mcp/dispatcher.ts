import type { Engine } from '../core/engine.ts';
import { WeftError } from '../core/weft-error.ts';
import { JSON_RPC_ERROR_CODES, type JsonRpcId } from '../server/json-rpc-protocol.ts';
import { isAuthenticated, type Principal } from '../server/principal.ts';
import { VERSION } from '../version.ts';
import { McpToolExecutionError } from './access.ts';
import {
  forbidden,
  internalError,
  invalidParams,
  isMcpRequest,
  isNotification,
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_TEMPLATES_LIST_METHOD,
  MCP_RESOURCES_LIST_METHOD,
  MCP_TOOLS_LIST_METHOD,
  methodNotFound,
  resourceNotFound,
  successResponse,
  type McpDispatchResult,
  type McpRequest,
  type McpResponse,
} from './protocol.ts';
import {
  listMcpResources,
  listMcpResourceTemplates,
  readMcpResource,
  subscribeMcpResource,
  unsubscribeMcpResource,
} from './resources.ts';
import type { McpSession } from './session.ts';
import { callMcpTool, listMcpTools } from './tools.ts';

/** Inputs required to dispatch one MCP JSON-RPC message. */
export type McpDispatchContext = {
  readonly engine: Engine;
  readonly session: McpSession;
  readonly principal: Principal;
  readonly authRequired: boolean;
};

/** Dispatch a parsed MCP JSON-RPC message. */
export async function dispatchMcpMessage(
  message: unknown,
  context: McpDispatchContext,
): Promise<McpDispatchResult> {
  if (!isMcpRequest(message)) {
    return {
      kind: 'response',
      response: invalidParams(null, 'Invalid MCP JSON-RPC request'),
    };
  }

  if (isNotification(message)) {
    try {
      await dispatchNotification(message, context);
    } catch (error) {
      console.error(`[weft.mcp] Ignored MCP notification error for ${message.method}:`, error);
    }
    return { kind: 'accepted' };
  }

  const id = message.id ?? null;
  try {
    const result = await dispatchRequest(message, context);
    return { kind: 'response', response: successResponse(id, result) };
  } catch (error) {
    if (error instanceof McpProtocolError || error instanceof McpResponseError) {
      return { kind: 'response', response: error.toResponse(id) };
    }
    if (error instanceof McpToolExecutionError) {
      return { kind: 'response', response: forbidden(id, error.message) };
    }
    console.error('[weft.mcp] Unhandled MCP dispatcher error:', error);
    return { kind: 'response', response: internalError(id) };
  }
}

async function dispatchNotification(
  request: McpRequest,
  context: McpDispatchContext,
): Promise<void> {
  if (request.method === 'notifications/initialized') {
    if (context.session.phase === 'initializing') context.session.phase = 'ready';
    return;
  }

  if (context.session.phase !== 'ready') return;

  if (request.method === 'notifications/cancelled') {
    const params = objectParams(request.params);
    const workflowId = context.session.cancelRequest(params['requestId']);
    if (workflowId !== undefined) {
      await context.engine.cancel(workflowId);
    }
  }
}

type RequestHandler = (request: McpRequest, context: McpDispatchContext) => unknown;

const REQUEST_HANDLERS: Readonly<Record<string, RequestHandler>> = {
  initialize: async (request, context) => initialize(request.params, context.session),
  ping: async () => ({}),
  [MCP_TOOLS_LIST_METHOD]: async (_request, context) => ({ tools: listMcpTools(context.engine) }),
  'tools/call': callTool,
  [MCP_RESOURCES_LIST_METHOD]: async (_request, context) => ({
    resources: await listMcpResources(context),
  }),
  'resources/read': readResource,
  'resources/subscribe': subscribeResource,
  'resources/unsubscribe': unsubscribeResource,
  [MCP_RESOURCE_TEMPLATES_LIST_METHOD]: async () => ({
    resourceTemplates: listMcpResourceTemplates(),
  }),
  'prompts/list': async () => ({ prompts: [] }),
  'prompts/get': async () => {
    throw new McpProtocolError(-32002, 'Prompt not found');
  },
  'logging/setLevel': async () => ({}),
  'completion/complete': async () => ({ completion: { values: [], total: 0, hasMore: false } }),
};

async function dispatchRequest(request: McpRequest, context: McpDispatchContext): Promise<unknown> {
  if (
    context.authRequired &&
    !isAuthenticated(context.principal) &&
    request.method !== 'initialize'
  ) {
    throw new McpProtocolError(-32011, 'MCP request requires authentication');
  }

  enforceSessionPhase(request, context);

  const handler = REQUEST_HANDLERS[request.method];
  if (handler === undefined) {
    throw new McpResponseError(methodNotFound(request.id ?? null, request.method));
  }
  return handler(request, context);
}

function initialize(params: unknown, session: McpSession): unknown {
  const record = objectParams(params);
  const requestedVersion =
    typeof record['protocolVersion'] === 'string' ? record['protocolVersion'] : undefined;
  session.protocolVersion =
    requestedVersion === MCP_PROTOCOL_VERSION ? requestedVersion : MCP_PROTOCOL_VERSION;
  session.phase = 'initializing';
  return {
    protocolVersion: session.protocolVersion,
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: false },
      prompts: {},
      logging: {},
      completions: {},
    },
    serverInfo: {
      name: 'weft',
      title: 'Weft',
      version: VERSION,
    },
  };
}

function enforceSessionPhase(request: McpRequest, context: McpDispatchContext): void {
  if (request.method === 'initialize') {
    if (context.session.phase !== 'new') {
      throw new McpProtocolError(-32000, 'MCP session is already initialized');
    }
    return;
  }
  if (context.session.phase === 'new') {
    throw new McpProtocolError(-32000, 'MCP session must be initialized before requests');
  }
  if (context.session.phase === 'initializing') {
    throw new McpProtocolError(
      -32000,
      'MCP session must receive notifications/initialized before requests',
    );
  }
}

async function callTool(request: McpRequest, context: McpDispatchContext): Promise<unknown> {
  const params = objectParams(request.params);
  const name = params['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new McpResponseError(invalidParams(request.id ?? null, 'tools/call requires name'));
  }
  return callMcpTool(name, params['arguments'] ?? {}, {
    ...context,
    requestId: request.id,
  });
}

async function readResource(request: McpRequest, context: McpDispatchContext): Promise<unknown> {
  const uri = requireUri(request);
  const result = await readMcpResource(uri, context);
  if (result === null) throw new McpResponseError(resourceNotFound(request.id ?? null, uri));
  return result;
}

async function subscribeResource(
  request: McpRequest,
  context: McpDispatchContext,
): Promise<unknown> {
  const uri = requireUri(request);
  const subscribed = await subscribeMcpResource(uri, context.session, context);
  if (!subscribed) throw new McpResponseError(resourceNotFound(request.id ?? null, uri));
  return {};
}

function unsubscribeResource(request: McpRequest, context: McpDispatchContext): unknown {
  const uri = requireUri(request);
  unsubscribeMcpResource(uri, context.session);
  return {};
}

function requireUri(request: McpRequest): string {
  const params = objectParams(request.params);
  const uri = params['uri'];
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new McpResponseError(invalidParams(request.id ?? null, `${request.method} requires uri`));
  }
  return uri;
}

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  throw new McpProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'MCP params must be an object');
}

class McpProtocolError extends WeftError<'McpProtocolError'> {
  readonly jsonRpcCode: number;
  readonly data: unknown;

  constructor(jsonRpcCode: number, message: string, data?: unknown) {
    super('McpProtocolError', message);
    this.jsonRpcCode = jsonRpcCode;
    this.data = data;
  }

  toResponse(id: JsonRpcId): McpResponse {
    if (this.jsonRpcCode === -32011) return forbidden(id, this.message);
    return {
      jsonrpc: '2.0',
      id,
      error:
        this.data === undefined
          ? { code: this.jsonRpcCode, message: this.message }
          : { code: this.jsonRpcCode, message: this.message, data: this.data },
    };
  }
}

class McpResponseError extends WeftError<'McpResponseError'> {
  readonly response: McpResponse;

  constructor(response: McpResponse) {
    super('McpResponseError', response.error?.message ?? 'MCP response error');
    this.response = response;
  }

  toResponse(_id: JsonRpcId): McpResponse {
    return this.response;
  }
}
