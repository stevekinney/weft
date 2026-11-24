import { z } from 'zod';
import type { ScopeVocabulary } from '../authorization-scope.ts';

import type { AuthContext } from '../authentication.ts';
import type { DiscoveryInfo } from '../discovery-info.ts';
import { handleJsonRpcHttpRequest } from '../json-rpc-http.ts';
import {
  closeJsonRpcWebSocketSession,
  handleJsonRpcWebSocketMessage,
  openGenericJsonRpcWebSocketSession,
  type JsonRpcSocket,
  type JsonRpcSocketData,
} from '../json-rpc-session-runtime.ts';
import {
  createOperationRegistry,
  executeOperation,
  executeSubscription,
  type FaultPolicy,
  type OperationHostFactory,
  type OperationInterceptor,
  type OperationRegistry,
  type RegistrableOperation,
} from '../operation-catalog.ts';
import type { ServerSentEventHeartbeatOptions } from '../operations/sse-stream.ts';
import type { Principal } from '../principal.ts';
import { GENERIC_SUBSCRIPTION_ROUTE_PREFIX, JSON_RPC_PATH } from '../route-model.ts';
import {
  buildPreflightResponse,
  decorateResponseWithCors,
  isOriginAllowed,
  isPreflightRequest,
  resolveCorsPolicy,
  validateCorsOptions,
  type CorsOptions,
} from '../runtime/cors.ts';
import { authContextToPrincipal } from './auth-context-principal.ts';
import { errorResponse, jsonResponse, negotiatedJsonOrBinary } from './json-responses.ts';
import type { OperationHandlerAuthenticate } from './operation-handler-authentication.ts';
import {
  createOperationHandlerDocuments,
  type OperationHandlerDocuments,
} from './operation-handler-discovery.ts';
import {
  DEFAULT_OPERATION_HANDLER_PUBLIC_PATHS,
  isAtOrUnder,
  resolveHandlerPublicPaths,
  resolveMounts,
  type OperationHandlerMount,
  type OperationHandlerMountContext,
  type OperationHandlerMountDispatchOptions,
} from './operation-handler-mounts.ts';
import {
  DEFAULT_MAX_STREAM_DURATION_MS,
  handleSubscriptionRequest,
} from './operation-handler-subscription.ts';
import { createWorkspaceRevalidation, guardWorkspaceResponse } from './workspace-release.ts';

/**
 * Options for {@link createOperationHandler}.
 *
 * `Host` is whatever the registered operations read from `host` in their
 * `invoke` and `authorize` hooks. It is inferred from `host` alone, so an
 * operation that needs a capability the host lacks is a compile error here.
 */
export type OperationHandlerOptions<Host> = {
  /**
   * The whole catalog this handler serves. Weft's own operations are not added.
   *
   * A `subscription` that declares `transports.http` must accept `fromCursor`
   * in its input: the route delivers `Last-Event-ID` as `fromCursor`, and
   * construction throws naming an operation that does not. The cursor's format
   * is the operation's own; it should reject a malformed one as
   * `InvalidParams` (a schema `refine` does), which answers 400.
   */
  readonly operations: ReadonlyArray<RegistrableOperation<NoInfer<Host>>>;
  /** Delivered as `host` to every `invoke` and `authorize` call. */
  readonly host: Host | OperationHostFactory<Host>;
  /** Interceptors that wrap each authorized invocation in registration order. */
  readonly interceptors?: readonly OperationInterceptor[];
  /**
   * Resolves the caller. Omitted, every request is anonymous and only
   * `public` operations pass. See `createOperationHandlerAuthenticator` for
   * Weft's API-key and JWT schemes, including package `additionalScopes`.
   *
   * A host with exactly one caller, such as an embedded single-user app, can
   * admit every request as the `unauthenticated-local` principal using
   * `authenticate: async () => unauthenticatedLocalAuthContext(vocabulary)`.
   */
  readonly authenticate?: OperationHandlerAuthenticate;
  /** Vocabulary for fallback principals when an authenticator returns only claims. */
  readonly scopeVocabulary?: ScopeVocabulary;
  /** Same validation and defaults as `ServeOptions.cors`; omitted means no CORS headers. */
  readonly cors?: CorsOptions;
  /** Adapters that claim a path prefix ahead of catalog routing. */
  readonly mounts?: ReadonlyArray<OperationHandlerMount>;
  /**
   * Exact paths the handler answers without calling `authenticate`. Defaults
   * to `/v1/health` and the three discovery documents; `[]` authenticates all
   * of them. This is the only place the handler's own public paths are
   * decided: `createOperationHandlerAuthenticator` has none of its own, and a
   * mount's `publicPaths` cover its paths. An entry must be a path the handler
   * serves exactly: a fixed route, or `/v1/subscriptions/<name>` for a
   * registered subscription (a mount cannot claim one, so the two never overlap).
   */
  readonly publicPaths?: ReadonlyArray<string>;
  /** The facts the discovery documents report, such as the server URL. */
  readonly discoveryInfo?: DiscoveryInfo;
  /**
   * A binary encoding for `GET /v1/health`: when a request accepts `application/msgpack` and this
   * is supplied, the answer is its bytes with that content type. Omitted, the answer is JSON. The
   * handler carries no codec of its own; a host on Weft passes Weft's `encode`.
   */
  readonly encodeBinary?: (value: unknown) => Uint8Array;
  /**
   * What the host decides about the faults its operations throw: whether an undeclared fault
   * answers `EngineFailure` (`strict`, on by default) or passes through with a warning, and how
   * the host's own error classes map to faults. The handler reads no environment variable; a host
   * on Weft's engine passes `weftFaultPolicy`, which follows `NODE_ENV` and `WEFT_STRICT_FAULTS`.
   */
  readonly faultPolicy?: FaultPolicy;
  /** Maximum JSON-RPC request body size in bytes. Defaults to 1 MB. */
  readonly maxRequestBodyBytes?: number;
  /**
   * How long one Server-Sent Events subscription response may stream before
   * the handler ends it cleanly, so a client resumes with `Last-Event-ID`.
   * A positive integer number of milliseconds, at most 2147483647 (a larger
   * value overflows the timer, which then fires immediately); defaults to
   * fifteen minutes.
   * It applies to `GET /v1/subscriptions/:operationName` only.
   */
  readonly maxStreamDurationMs?: number;
  /**
   * Heartbeat interval and the timer and clock seam behind it. The
   * `maxStreamDurationMs` deadline is armed through the same `schedule`, so a
   * test drives both with one manual clock.
   */
  readonly heartbeat?: ServerSentEventHeartbeatOptions;
};

/** A fetch handler over a caller-supplied operation registry. */
export type OperationHandlerUpgradeServer = {
  upgrade(request: Request, options: { data: JsonRpcSocketData }): boolean;
};

/**
 * The WebSocket entry points of the handler, typed against the part of a socket a session uses.
 * Bun's `ServerWebSocket` satisfies {@link JsonRpcSocket}, so `Bun.serve({ websocket })` takes
 * these as they are.
 */
export type OperationHandlerWebSocket = {
  open(ws: JsonRpcSocket<JsonRpcSocketData>): void;
  message(ws: JsonRpcSocket<JsonRpcSocketData>, message: string | Uint8Array): void;
  close(ws: JsonRpcSocket<JsonRpcSocketData>): void;
};

/** A callable catalog handler with an optional Bun WebSocket entry point. */
export type OperationHandler = ((request: Request) => Promise<Response>) & {
  upgrade(request: Request, server: OperationHandlerUpgradeServer): Promise<boolean>;
  websocket: OperationHandlerWebSocket;
};

const HEALTH_PATH = '/v1/health';

/** The largest delay a timer honors; above it the runtime clamps the delay to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function assertPositiveInteger(
  value: number | undefined,
  name: string,
  max: number = Number.MAX_SAFE_INTEGER,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    const bound = max === Number.MAX_SAFE_INTEGER ? '' : ` no greater than ${max}`;
    throw new Error(
      `createOperationHandler: ${name} must be a positive integer${bound} (got ${value})`,
    );
  }
}

/**
 * The `fromCursor` contract: `Last-Event-ID` is delivered to a subscription as
 * its `fromCursor` input, so a subscription served over HTTP has to accept one.
 * Checked at construction so a missing field is a startup error naming the
 * operation, not a 400 on every reconnect.
 */
function assertSubscriptionsAcceptFromCursor(registry: OperationRegistry): void {
  for (const operation of registry.list()) {
    if (operation.kind !== 'subscription' || !operation.transports.http) continue;
    const accepts =
      operation.inputSchema instanceof z.ZodObject && 'fromCursor' in operation.inputSchema.shape;
    if (!accepts) {
      throw new Error(
        `createOperationHandler: subscription "${operation.name}" declares transports.http but its input has no fromCursor field, so Last-Event-ID cannot resume it`,
      );
    }
  }
}

function normalizedPathname(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * Create a fetch handler that serves a caller-supplied operation registry with
 * Weft's transport plumbing and never reads an `Engine`.
 *
 * What it serves, and in what order a request is handled: CORS preflight,
 * authentication, mounts, then the catalog routes (`POST /jsonrpc`,
 * `GET /v1/subscriptions/:operationName` as Server-Sent Events with
 * `Last-Event-ID` replay, `GET /v1/health`, and the OpenAPI, OpenRPC, and
 * AsyncAPI documents generated from the registry alone), and finally CORS
 * decoration of the response.
 *
 * It does not serve the engine's `/mcp` (its workflow tools and resources),
 * `/.well-known/*`, `/v1/metrics`, the workflow WebSocket streams, or any
 * remote-worker route; those need an `Engine` and stay behind `serve()`. Its
 * `upgrade` and `websocket` properties do serve catalog JSON-RPC WebSocket
 * operations that declare `transports.jsonRpcWebSocket`. A catalog's own
 * `mcpExposable` operations can be served as MCP tools by
 * mounting `createOperationMcpMount` from `@lostgradient/weft`. Rate limiting stays there too, since its key falls back
 * to the client address a fetch handler cannot see; put a limiter in front.
 *
 * A factory rather than a per-request function, so registry construction, CORS
 * validation, mount validation, and option validation fail once, synchronously,
 * before the first request.
 *
 * @example
 * ```ts
 * import { createOperationHandler, defineOperation } from '@lostgradient/backchannel';
 * import { z } from 'zod';
 *
 * const echo = defineOperation({
 *   name: 'probe.echo',
 *   mcpExposable: false,
 *   summary: 'Echo a message',
 *   destructive: false,
 *   inputSchema: z.object({ message: z.string() }),
 *   outputSchema: z.object({ message: z.string() }),
 *   access: { kind: 'public' },
 *   transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
 *   unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
 *   invoke: async ({ input }) => ({ message: input.message }),
 * });
 *
 * const handler = createOperationHandler({ operations: [echo], host: {} });
 * const response = await handler(new Request('http://localhost/v1/health'));
 * console.log(response.status); // 200
 * ```
 */
export function createOperationHandler<Host>(
  options: Omit<OperationHandlerOptions<Host>, 'host'> & {
    readonly host: OperationHostFactory<Host>;
  },
): OperationHandler;
/** Build a catalog handler with a host value or a per-dispatch factory. */
export function createOperationHandler<Host>(
  options: OperationHandlerOptions<Host>,
): OperationHandler;
export function createOperationHandler<Host>(
  options: OperationHandlerOptions<Host>,
): OperationHandler {
  assertPositiveInteger(options.maxRequestBodyBytes, 'maxRequestBodyBytes');
  assertPositiveInteger(options.maxStreamDurationMs, 'maxStreamDurationMs', MAX_TIMER_DELAY_MS);
  const authenticate = options.authenticate;
  const registry = createOperationRegistry<Host>(options.operations, {
    faultPolicy: options.faultPolicy,
    interceptors: options.interceptors,
  });
  assertSubscriptionsAcceptFromCursor(registry);
  const mounts = resolveMounts(options.mounts ?? []);
  const publicPaths = resolveHandlerPublicPaths(
    options.publicPaths ?? DEFAULT_OPERATION_HANDLER_PUBLIC_PATHS,
    registry,
  );
  const corsPolicy =
    options.cors === undefined
      ? undefined
      : (validateCorsOptions(options.cors, authenticate !== undefined),
        resolveCorsPolicy(options.cors, authenticate !== undefined));
  const documents = createOperationHandlerDocuments({
    registry,
    discoveryInfo: options.discoveryInfo,
    authenticates: authenticate !== undefined,
    publicPaths,
  });
  const activeSessions = new Set<import('../json-rpc-websocket.ts').JsonRpcWebSocketSession>();

  const handle = async (request: Request): Promise<Response> => {
    const pathname = normalizedPathname(request);
    const isPublic = publicPaths.has(pathname) || mounts.isPublic(pathname);
    let authContext: AuthContext | undefined;
    if (authenticate !== undefined && !isPublic) {
      const outcome = await authenticate(request);
      if (outcome instanceof Response) return outcome;
      authContext = outcome;
    }
    const principal = authContextToPrincipal(authContext, options.scopeVocabulary);
    const revalidate = createWorkspaceRevalidation(authenticate, request, principal);

    const mount = mounts.match(pathname);
    if (mount !== undefined) {
      return guardWorkspaceResponse(
        await mount.fetch(request, mountContext(registry, options.host, principal, request.signal)),
        revalidate,
      );
    }
    return guardWorkspaceResponse(
      await routeCatalog({ request, pathname, principal, registry, documents, options }),
      revalidate,
    );
  };

  const handler = async (request: Request): Promise<Response> => {
    if (corsPolicy !== undefined && isPreflightRequest(request)) {
      return buildPreflightResponse(corsPolicy, request);
    }
    let response: Response;
    try {
      response = await handle(request);
    } catch (error) {
      console.error('Unhandled error in createOperationHandler', {
        method: request.method,
        path: new URL(request.url).pathname,
        error,
      });
      response = errorResponse('Internal server error', 500);
    }
    return corsPolicy === undefined ? response : decorate(corsPolicy, request, response);
  };

  handler.upgrade = async (
    request: Request,
    server: OperationHandlerUpgradeServer,
  ): Promise<boolean> => {
    const pathname = normalizedPathname(request);
    if (pathname !== JSON_RPC_PATH) return false;
    const origin = request.headers.get('Origin');
    if (corsPolicy !== undefined && origin !== null && !isOriginAllowed(corsPolicy, origin)) {
      return false;
    }
    let authContext: AuthContext | undefined;
    const isPublic = publicPaths.has(pathname) || mounts.isPublic(pathname);
    if (authenticate !== undefined && !isPublic) {
      const outcome = await authenticate(request);
      if (outcome instanceof Response) return false;
      authContext = outcome;
    }
    const principal = authContextToPrincipal(authContext, options.scopeVocabulary);
    const revalidateWorkspace = createWorkspaceRevalidation(authenticate, request, principal);
    return server.upgrade(request, {
      data: {
        pathname,
        connectionType: 'jsonrpc',
        principal,
        ...(revalidateWorkspace === undefined ? {} : { revalidateWorkspace }),
      },
    });
  };
  handler.websocket = {
    open(ws: JsonRpcSocket<JsonRpcSocketData>) {
      openGenericJsonRpcWebSocketSession({
        ws,
        registry,
        host: options.host,
        activeSessions,
        discoverDocument: documents.openRpc,
      });
    },
    message(ws: JsonRpcSocket<JsonRpcSocketData>, message: string | Uint8Array) {
      handleJsonRpcWebSocketMessage(ws, message);
    },
    close(ws: JsonRpcSocket<JsonRpcSocketData>) {
      ws.data.workspaceClosed = true;
      closeJsonRpcWebSocketSession({ session: ws.data.jsonRpcSession, activeSessions });
    },
  };
  return handler;
}

/**
 * Add the CORS headers to a mutable copy of the response. A `fetch()` result,
 * `Response.redirect()`, or any response a hook hands back may carry immutable
 * headers, and `decorateResponseWithCors` sets them in place. The copy shares
 * the body stream, so nothing is buffered. A network-error response
 * (`Response.error()`) has no headers to add and cannot be copied, so it is
 * returned as it is.
 */
function decorate(
  policy: Parameters<typeof decorateResponseWithCors>[0],
  request: Request,
  response: Response,
): Response {
  if (response.type === 'error') return response;
  return decorateResponseWithCors(policy, request, new Response(response.body, response));
}

function mountContext(
  registry: OperationRegistry,
  host: unknown,
  principal: Principal,
  signal: AbortSignal,
): OperationHandlerMountContext {
  const contextFor = (options: OperationHandlerMountDispatchOptions | undefined) =>
    ({ principal, host, transport: options?.transport ?? 'http-rest', registry, signal }) as const;
  return {
    principal,
    operations: registry.list(),
    dispatch: (operationName, input, options) =>
      executeOperation(operationName, input, contextFor(options)),
    subscribe: (operationName, input, options) =>
      executeSubscription(operationName, input, contextFor(options)),
  };
}

type CatalogRequest<Host> = {
  readonly request: Request;
  readonly pathname: string;
  readonly principal: Principal;
  readonly registry: OperationRegistry;
  readonly documents: OperationHandlerDocuments;
  readonly options: OperationHandlerOptions<Host>;
};

async function routeCatalog<Host>(catalog: CatalogRequest<Host>): Promise<Response> {
  const { request, pathname, options } = catalog;
  if (pathname === JSON_RPC_PATH) {
    return handleJsonRpcHttpRequest(request, {
      registry: catalog.registry,
      host: options.host,
      principal: catalog.principal,
      discoverDocument: catalog.documents.openRpc,
      ...(options.maxRequestBodyBytes === undefined
        ? {}
        : { maxBodyBytes: options.maxRequestBodyBytes }),
    });
  }
  if (isAtOrUnder(pathname, GENERIC_SUBSCRIPTION_ROUTE_PREFIX)) {
    return routeSubscription(catalog);
  }
  if (request.method === 'GET') {
    const response = routeGet(catalog, options.encodeBinary);
    if (response !== null) return response;
  }
  return errorResponse(`Not found: ${request.method} ${pathname}`, 404);
}

function routeGet(
  catalog: Pick<CatalogRequest<unknown>, 'request' | 'pathname' | 'documents'>,
  encodeBinary: ((value: unknown) => Uint8Array) | undefined,
): Response | null {
  const { request, pathname, documents } = catalog;
  switch (pathname) {
    case HEALTH_PATH:
      return negotiatedJsonOrBinary(request, { status: 'ok' }, 200, encodeBinary);
    case '/openapi.json':
      return jsonResponse(documents.openApi());
    case '/openrpc.json':
      return jsonResponse(documents.openRpc());
    case '/asyncapi.json':
      return jsonResponse(documents.asyncApi());
    default:
      return null;
  }
}

function routeSubscription<Host>(catalog: CatalogRequest<Host>): Promise<Response> {
  const { request, pathname, options } = catalog;
  const rawName = pathname.slice(GENERIC_SUBSCRIPTION_ROUTE_PREFIX.length + 1);
  if (rawName === '' || rawName.includes('/')) {
    return Promise.resolve(errorResponse(`Not found: ${request.method} ${pathname}`, 404));
  }
  let operationName: string;
  try {
    operationName = decodeURIComponent(rawName);
  } catch {
    return Promise.resolve(errorResponse('Malformed route parameter', 400));
  }
  return handleSubscriptionRequest(request, operationName, {
    registry: catalog.registry,
    host: options.host,
    principal: catalog.principal,
    maxStreamDurationMs: options.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS,
    heartbeat: options.heartbeat,
    isKnownErrorCode: options.faultPolicy?.isKnownErrorCode,
  });
}
