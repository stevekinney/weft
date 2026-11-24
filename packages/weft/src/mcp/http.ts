import {
  createMcpHandler,
  type AuthInfo,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server';

import { anonymousPrincipal, type Principal } from "../embedded/backchannel/src/index.ts";
import { isAuthenticated } from "../embedded/backchannel/src/internals.ts";
import type { Engine, RegistryAgnosticEngine } from '../core/engine.ts';
import { McpToolExecutionError, type McpAccessContext } from './access.ts';
import { McpChangeFeed } from './change-feed.ts';
import { DEFAULT_MCP_MAX_BODY_BYTES } from './protocol.ts';
import { assertResourceSubscriptionAllowed, workflowResourceUri } from './resources.ts';
import { readListenRequest, SearchSubscriptions } from './search-subscriptions.ts';
import { createMcpServerFactory, type McpServerRegistrar } from './server.ts';

/**
 * Options for an MCP HTTP endpoint.
 *
 * @example
 * ```ts
 * import { type McpEndpointOptions } from '@lostgradient/weft';
 *
 * const options: McpEndpointOptions = { maxBodyBytes: 64 * 1024 };
 * void options;
 * ```
 */
export type McpEndpointOptions = {
  /** Upper bound on a POST body, answered `413` when exceeded. */
  readonly maxBodyBytes?: number;
  /** Registers further tools or prompts on every server instance the endpoint builds. */
  readonly registrars?: McpServerRegistrar | ReadonlyArray<McpServerRegistrar>;
  /**
   * The most `subscriptions/listen` streams the endpoint keeps open at once, across every
   * caller; a further listen is refused in-band. Defaults to the SDK's 1024.
   */
  readonly maxSubscriptions?: number;
};

/**
 * Weft's MCP endpoint, served through the official MCP SDK. It answers the
 * 2026-07-28 revision on the SDK's modern lane and 2025-era clients on the
 * SDK's stateless legacy lane, from one server factory, and publishes engine
 * changes to `subscriptions/listen` streams. Dispose it to stop listening to
 * the engine and close in-flight modern exchanges.
 *
 * @example
 * ```ts
 * import { createMcpEndpoint } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using endpoint = createMcpEndpoint(engine);
 *
 * void endpoint;
 * ```
 */
export class McpEndpoint implements AsyncDisposable {
  readonly #engine: Engine;
  readonly #feed: McpChangeFeed;
  readonly #searchSubscriptions = new SearchSubscriptions();
  readonly #maxBodyBytes: number;
  readonly #handler: McpHttpHandler;

  constructor(engine: RegistryAgnosticEngine, options: McpEndpointOptions = {}) {
    // Registry-erase the covariance-widened parameter (#708) to the plain
    // default `Engine` the tool and resource projections read.
    const erasedEngine = engine as Engine;
    this.#engine = erasedEngine;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MCP_MAX_BODY_BYTES;
    this.#feed = new McpChangeFeed(erasedEngine);
    this.#handler = createMcpHandler(
      createMcpServerFactory({
        engine: erasedEngine,
        access: accessFromRequestContext,
        lifetime: 'request',
        registrars: registrarList(options.registrars),
      }),
      {
        legacy: 'stateless',
        maxRequestBodySize: this.#maxBodyBytes,
        ...(options.maxSubscriptions === undefined
          ? {}
          : { maxSubscriptions: options.maxSubscriptions }),
      },
    );
    const notify = this.#handler.notify;
    this.#feed.attach({
      workflowChanged: (workflowId) => {
        notify.resourceUpdated(workflowResourceUri(workflowId, 'state'));
        notify.resourceUpdated(workflowResourceUri(workflowId, 'events'));
        notify.resourceUpdated(workflowResourceUri(workflowId, 'checkpoints'));
        for (const uri of this.#searchSubscriptions.uris()) notify.resourceUpdated(uri);
      },
      toolsChanged: () => {
        notify.toolsChanged();
      },
    });
  }

  /**
   * Serve one request as `principal` through the SDK's HTTP entry. Prefer
   * {@link handleMcpHttpRequest}, which also validates the request's origin
   * and refuses an anonymous caller when authentication is required.
   */
  async serve(request: Request, principal: Principal, authRequired: boolean): Promise<Response> {
    // The SDK opens a listen stream without asking Weft, so refuse any resource the caller
    // could not read before the stream exists.
    const refusal = await refuseUnreadableSubscriptions(request, this.#maxBodyBytes, {
      engine: this.#engine,
      principal,
      authRequired,
    });
    if (refusal !== undefined) return refusal;
    const authInfo = accessAuthInfo(principal, authRequired);
    return this.#searchSubscriptions.serve(request, this.#maxBodyBytes, () =>
      this.#handler.fetch(request, { authInfo }),
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#feed[Symbol.asyncDispose]();
    await this.#handler.close();
  }
}

/**
 * Create an MCP HTTP endpoint for an engine.
 *
 * @example
 * ```ts
 * import { createMcpEndpoint } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using endpoint = createMcpEndpoint(engine, { maxBodyBytes: 64 * 1024 });
 *
 * void endpoint;
 * ```
 */
export function createMcpEndpoint(
  engine: RegistryAgnosticEngine,
  options?: McpEndpointOptions,
): McpEndpoint {
  return new McpEndpoint(engine, options);
}

/**
 * Options for handling one Streamable HTTP MCP request.
 *
 * @example
 * ```ts
 * import { createMcpEndpoint, type McpHttpRequestOptions } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using endpoint = createMcpEndpoint(engine);
 *
 * const request = new Request('http://localhost/mcp', { method: 'POST' });
 * const options: McpHttpRequestOptions = { request, endpoint, authRequired: false };
 * void options;
 * ```
 */
export type McpHttpRequestOptions = {
  readonly request: Request;
  readonly endpoint: McpEndpoint;
  readonly principal?: Principal;
  readonly authRequired: boolean;
  readonly publicOrigin?: string;
  readonly trustedHosts?: ReadonlyArray<string>;
};

/**
 * Handle one MCP Streamable HTTP request.
 *
 * Most applications should use `serve({ engine })`, which mounts `/mcp`
 * automatically. Use this helper when embedding the MCP transport in a custom
 * Bun server. It refuses a cross-origin request that names neither the public
 * origin nor a trusted host, refuses an anonymous caller when authentication
 * is required, and hands everything else to the SDK with the caller's
 * principal.
 *
 * @example
 * ```ts
 * import { createMcpEndpoint, handleMcpHttpRequest } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using endpoint = createMcpEndpoint(engine);
 *
 * Bun.serve({
 *   fetch(request) {
 *     return handleMcpHttpRequest({ request, endpoint, authRequired: false });
 *   },
 * });
 * ```
 */
export async function handleMcpHttpRequest(options: McpHttpRequestOptions): Promise<Response> {
  const originFailure = validateOrigin(options.request, options.publicOrigin, options.trustedHosts);
  if (originFailure !== null) return originFailure;

  const principal = options.principal ?? anonymousPrincipal();
  if (options.authRequired && !isAuthenticated(principal)) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32011, message: 'MCP request requires authentication' },
      },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  return options.endpoint.serve(options.request, principal, options.authRequired);
}

/** The key under `AuthInfo.extra` that carries the caller to the server factory. */
const ACCESS_KEY = 'weft';

type CarriedAccess = { readonly principal: Principal; readonly authRequired: boolean };

function accessAuthInfo(principal: Principal, authRequired: boolean): AuthInfo {
  const access: CarriedAccess = { principal, authRequired };
  return {
    token: '',
    clientId: isAuthenticated(principal) ? (principal.subject ?? principal.method) : 'anonymous',
    scopes: isAuthenticated(principal) ? [...principal.scopes] : [],
    extra: { [ACCESS_KEY]: access },
  };
}

/**
 * Read back the caller {@link handleMcpHttpRequest} attached. A request that
 * reached the SDK some other way carries none and is served as an anonymous
 * caller on an endpoint that requires authentication.
 */
function accessFromRequestContext(request: McpRequestContext): CarriedAccess {
  const carried = request.authInfo?.extra?.[ACCESS_KEY] as CarriedAccess | undefined;
  return carried ?? { principal: anonymousPrincipal(), authRequired: true };
}

function registrarList(
  registrars: McpServerRegistrar | ReadonlyArray<McpServerRegistrar> | undefined,
): ReadonlyArray<McpServerRegistrar> {
  if (registrars === undefined) return [];
  return typeof registrars === 'function' ? [registrars] : registrars;
}

function validateOrigin(
  request: Request,
  publicOrigin?: string,
  trustedHosts?: ReadonlyArray<string>,
): Response | null {
  const origin = request.headers.get('origin');
  if (origin === null) return null;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  if (publicOrigin !== undefined && origin === publicOrigin) return null;
  if (trustedHosts?.includes(originUrl.host)) return null;
  return new Response('Forbidden', { status: 403 });
}

async function refuseUnreadableSubscriptions(
  request: Request,
  maxBodyBytes: number,
  context: McpAccessContext,
): Promise<Response | undefined> {
  const listen = await readListenRequest(request, maxBodyBytes);
  if (listen === undefined) return undefined;
  try {
    for (const uri of listen.resourceSubscriptions) assertResourceSubscriptionAllowed(uri, context);
    return undefined;
  } catch (error) {
    if (!(error instanceof McpToolExecutionError)) throw error;
    return Response.json(
      {
        jsonrpc: '2.0',
        id: listen.id,
        error: { code: -32011, message: error.message, data: { reason: error.message } },
      },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  }
}
