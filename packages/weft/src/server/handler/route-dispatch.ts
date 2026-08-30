import type { Engine } from '../../core/engine.ts';
import { listMcpTools } from '../../mcp/tools.ts';
import {
  createMetricsCollectorExporter,
  type PrometheusExporter,
} from '../../observability/metrics.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import { generateApiCatalog, originFromRequest, warnIfPublicOriginUnset } from '../api-catalog.ts';
import { generateAsyncApiDocument } from '../asyncapi.ts';
import type { AuthContext } from '../authentication.ts';
import type { DiscoveryInfo } from '../discovery-info.ts';
import { faultToHttpResponse } from '../fault-to-http.ts';
import type { FleetEventFeed } from '../fleet-event-feed.ts';
import { generateMcpDiscovery } from '../mcp-discovery.ts';
import { generateOpenApiDocument, type OpenApiSecuritySchemeName } from '../openapi.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import {
  executeOperation,
  type OperationRegistry,
  type PipelineTrace,
} from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { FAULT_CODE_TO_HTTP_STATUS } from '../operation-fault.ts';
import type { WorkflowStreamConnectionAcquirer } from '../operations/workflow-events-sse.ts';
import type { Principal } from '../principal.ts';
import {
  createLiveOperationRegistry,
  createLiveRestBindings,
  type UnknownRestBinding,
} from '../rest-bindings.ts';
import type { TaskQueue } from '../task-queue.ts';
import type { WorkflowEventFeed } from '../workflow-event-feed.ts';
import {
  defaultShapeSuccess,
  errorResponse,
  jsonResponse,
  negotiatedResponse,
} from './response-helpers.ts';
import type { DirectRouteHandlerName } from './route-matching.ts';
import {
  dispatchServerSentEventsBinding,
  isDirectServerSentEventsOperation,
  type LiveEventStreamContext,
} from './sse-route-dispatch.ts';

/**
 * Options bag passed to `handleRequest` by the HTTP server wrapper.
 *
 * Injects the resolved authentication context, custom metrics exporters, and
 * an optional override for the operation registry and REST bindings. Omit
 * `operationRegistry` and `restBindings` together to use the live defaults,
 * optionally bound to the supplied worker registry and task queue.
 *
 * @example
 * ```ts
 * import { type HandlerOptions } from '@lostgradient/weft/server/handler';
 *
 * const options: HandlerOptions = {
 *   authContext: { method: 'public' },
 * };
 * void options;
 * ```
 */
export interface HandlerOptions {
  /**
   * Optional authenticated caller context injected by the HTTP server
   * wrapper. See `AuthContext` in `authentication.ts` for field documentation.
   */
  authContext?: AuthContext;
  /**
   * Optional {@link PrometheusExporter} used to produce the body of
   * `/v1/metrics`. This is the plug point for projects that source metrics
   * from the OpenTelemetry SDK (e.g. via `@opentelemetry/exporter-prometheus`).
   */
  prometheusExporter?: PrometheusExporter;
  /** Live worker state used by worker and task-diagnostics operations. */
  workerRegistry?: WorkerRegistry;
  /** Live task-queue state used by queue and task-diagnostics operations. */
  taskQueue?: TaskQueue;
  /**
   * Operation registry for pipeline dispatch. Must be supplied together
   * with `restBindings` — a caller that overrides one but not the other
   * gets a mismatched configuration (custom bindings referencing a live
   * registry they weren't built against), which `handleRequest` rejects
   * at request time. Omit both to use the live defaults.
   */
  operationRegistry?: OperationRegistry;
  /**
   * REST bindings. A request whose method+path matches a binding routes
   * through the `executeOperation` pipeline. Must be supplied together
   * with `operationRegistry`. Omit both to use the live defaults.
   */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
  /** OpenAPI security schemes supported by the live server configuration. */
  supportedAuthenticationSchemes?: ReadonlySet<OpenApiSecuritySchemeName>;
  /**
   * Operator-supplied metadata applied uniformly to all three discovery
   * documents (`/openapi.json`, `/openrpc.json`, `/asyncapi.json`).
   */
  discoveryInfo?: DiscoveryInfo;
  /**
   * Optional explicit public origin used when emitting absolute URLs in
   * discovery routes such as `/.well-known/api-catalog` and
   * `/.well-known/mcp.json`. Recommended in production to avoid trusting
   * attacker-controlled `Host` / `X-Forwarded-Proto` headers. Takes precedence
   * over `trustedHosts`.
   */
  publicOrigin?: string;
  /**
   * Optional allowlist of `Host` values that are trusted as the source of
   * absolute service-desc URLs in discovery routes such as
   * `/.well-known/api-catalog` and `/.well-known/mcp.json`. The route derives
   * the origin from the incoming request and rejects (421
   * Misdirected Request) if the resolved Host is not in this list.
   *
   * Either `publicOrigin` OR `trustedHosts` must be configured in
   * production deployments — without one, the route returns 503 because
   * `Bun.serve()` trusts the Host header in `request.url` and an attacker
   * can otherwise poison the discovery URLs.
   */
  trustedHosts?: ReadonlyArray<string>;
  /** Maximum REST operation request body size in bytes. Defaults to 1 MB. */
  maxRequestBodyBytes?: number;
  /** Event feed used by live workflow SSE routes. */
  workflowEventFeed?: WorkflowEventFeed;
  /** Fleet feed used by live fleet SSE routes. */
  fleetEventFeed?: Pick<FleetEventFeed, 'subscribe'>;
  /** Shared per-workflow long-lived stream connection limiter. */
  acquireWorkflowStreamConnection?: WorkflowStreamConnectionAcquirer;
  /**
   * Optional pipeline-trace observer. **Internal test seam** used by the
   * dispatch-audit suite to prove every transport drives the full
   * `executeOperation` pipeline. Production callers should not set this
   * — the parameter has no other effect on dispatch behavior.
   *
   * @internal
   */
  pipelineTrace?: PipelineTrace;
}

const defaultPrometheusExporter = createMetricsCollectorExporter(undefined);

type DiscoveryOriginResolution =
  | {
      readonly origin: string;
      readonly response?: never;
    }
  | {
      readonly origin?: never;
      readonly response: Response;
    };

type DiscoveryOriginOptions = {
  readonly absoluteUrlDescription: string;
  readonly path: string;
  readonly request: Request;
  readonly serverOptions: HandlerOptions | undefined;
};

function resolveDiscoveryOrigin(options: DiscoveryOriginOptions): DiscoveryOriginResolution {
  const { absoluteUrlDescription, path, request, serverOptions } = options;
  // Three-tier origin resolution:
  //   1. publicOrigin explicit -> use verbatim (safe, operator-controlled).
  //   2. trustedHosts allowlist -> derive from request, validate Host.
  //   3. Neither set -> 503 in production-like environments. Bun.serve
  //      trusts the Host header in request.url, so header poisoning is real.
  //      Development and explicit testbed overrides warn once, then fall back.
  if (serverOptions?.publicOrigin !== undefined) {
    return { origin: serverOptions.publicOrigin };
  }

  const requestOrigin = originFromRequest(request);
  if (serverOptions?.trustedHosts !== undefined) {
    const requestHost = new URL(requestOrigin).host;
    if (!serverOptions.trustedHosts.includes(requestHost)) {
      return {
        response: errorResponse(
          'request Host is not in the configured trustedHosts allowlist',
          421,
        ),
      };
    }
    return { origin: requestOrigin };
  }

  const isDevelopment = Bun.env['NODE_ENV'] === 'development';
  const operatorOverride = Bun.env['WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN'] === '1';
  if (!isDevelopment && !operatorOverride) {
    return {
      response: errorResponse(
        `${path} refuses to emit ${absoluteUrlDescription} without one of ` +
          '`publicOrigin` or `trustedHosts` configured. Set `serve({ publicOrigin: ' +
          "'https://api.example.com' })` or `serve({ trustedHosts: ['api.example.com'] })`. " +
          'For local development, set NODE_ENV=development; for CI/test overrides set ' +
          'WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN=1.',
        503,
      ),
    };
  }

  warnIfPublicOriginUnset();
  return { origin: requestOrigin };
}

async function handleGetMetrics(
  prometheusExporter: PrometheusExporter = defaultPrometheusExporter,
): Promise<Response> {
  let body: string;
  try {
    body = await prometheusExporter.serialize();
  } catch (error) {
    console.error('PrometheusExporter.serialize() threw', { error });
    return new Response(JSON.stringify({ error: 'metrics exporter failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export type RouteExecutionContext = {
  request: Request;
  engine: Engine;
  options: HandlerOptions | undefined;
};

export type RouteExecutor = (context: RouteExecutionContext) => Promise<Response>;

export const DIRECT_ROUTE_EXECUTORS: Record<DirectRouteHandlerName, RouteExecutor> = {
  healthCheck: async ({ request }) => negotiatedResponse(request, { status: 'ok' }),
  getMetrics: async ({ options }) => handleGetMetrics(options?.prometheusExporter),
  apiCatalog: async ({ request, options }) => {
    const originResolution = resolveDiscoveryOrigin({
      absoluteUrlDescription: 'absolute service-desc URLs',
      path: '/.well-known/api-catalog',
      request,
      serverOptions: options,
    });
    if (originResolution.response !== undefined) return originResolution.response;
    const body = generateApiCatalog({ origin: originResolution.origin });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/linkset+json' },
    });
  },
  mcpDiscovery: async ({ request, options }) => {
    const originResolution = resolveDiscoveryOrigin({
      absoluteUrlDescription: 'absolute MCP endpoint URLs',
      path: '/.well-known/mcp.json',
      request,
      serverOptions: options,
    });
    if (originResolution.response !== undefined) return originResolution.response;
    return jsonResponse(generateMcpDiscovery({ origin: originResolution.origin }));
  },
  openApiDocument: async ({ options }) =>
    jsonResponse(
      generateOpenApiDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(options),
        ...(options?.restBindings !== undefined ? { restBindings: options.restBindings } : {}),
        ...(options?.supportedAuthenticationSchemes !== undefined
          ? { supportedSchemes: options.supportedAuthenticationSchemes }
          : {}),
        ...(options?.discoveryInfo !== undefined ? { discoveryInfo: options.discoveryInfo } : {}),
      }),
    ),
  openRpcDocument: async ({ engine, options }) =>
    jsonResponse(
      generateOpenRpcDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(options),
        transports: ['http', 'websocket'],
        mcpTools: listMcpTools(engine),
        ...(options?.discoveryInfo !== undefined ? { discoveryInfo: options.discoveryInfo } : {}),
      }),
    ),
  asyncApiDocument: async ({ options }) =>
    jsonResponse(
      generateAsyncApiDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(options),
        ...(options?.restBindings !== undefined ? { restBindings: options.restBindings } : {}),
        ...(options?.discoveryInfo !== undefined ? { discoveryInfo: options.discoveryInfo } : {}),
      }),
    ),
};

export async function dispatchViaExecuteOperation(
  request: Request,
  engine: Engine,
  binding: UnknownRestBinding,
  pathParams: Record<string, string>,
  registry: OperationRegistry,
  principal: Principal,
  pipelineTrace?: PipelineTrace,
  maxRequestBodyBytes?: number,
  supportedAuthenticationSchemes?: ReadonlySet<OpenApiSecuritySchemeName>,
  liveEventStreamContext?: LiveEventStreamContext,
): Promise<Response> {
  const extracted = await extractRestBindingInput(
    request,
    binding,
    pathParams,
    maxRequestBodyBytes,
  );
  if (!extracted.ok) return extracted.response;

  if (isDirectServerSentEventsOperation(binding.operationName)) {
    return dispatchServerSentEventsBinding({
      request,
      binding,
      rawInput: extracted.input,
      principal,
      registry,
      ...(pipelineTrace === undefined ? {} : { pipelineTrace }),
      ...(supportedAuthenticationSchemes === undefined ? {} : { supportedAuthenticationSchemes }),
      ...(liveEventStreamContext === undefined ? {} : { liveEventStreamContext }),
    });
  }

  const result = await executeOperation(binding.operationName, extracted.input, {
    principal,
    engine,
    transport: 'http-rest',
    registry,
    ...(pipelineTrace !== undefined ? { pipelineTrace } : {}),
  });
  if (result.ok) {
    return binding.shapeSuccess
      ? binding.shapeSuccess(result.value, request)
      : defaultShapeSuccess(result.value, binding.success);
  }
  return binding.shapeFault ? binding.shapeFault(result.fault) : faultToHttpResponse(result.fault);
}

type RestBindingInputResult =
  | {
      readonly ok: true;
      readonly input: unknown;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

async function extractRestBindingInput(
  request: Request,
  binding: UnknownRestBinding,
  pathParams: Record<string, string>,
  maxRequestBodyBytes: number | undefined,
): Promise<RestBindingInputResult> {
  try {
    const input = await binding.extractInput(
      request,
      pathParams,
      maxRequestBodyBytes !== undefined ? { maxBodyBytes: maxRequestBodyBytes } : {},
    );
    return { ok: true, input };
  } catch (error) {
    if (isOperationFaultLike(error)) {
      const response = binding.shapeFault ? binding.shapeFault(error) : faultToHttpResponse(error);
      return { ok: false, response };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, response: errorResponse(message, 400) };
  }
}

function hasRequiredFaultProperties(candidate: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(candidate, 'code') &&
    Object.hasOwn(candidate, 'message') &&
    Object.hasOwn(candidate, 'data')
  );
}

function readFaultProperties(
  candidate: Record<string, unknown>,
): { code: unknown; message: unknown; data: unknown } | null {
  try {
    return {
      code: candidate['code'],
      message: candidate['message'],
      data: candidate['data'],
    };
  } catch {
    return null;
  }
}

/**
 * Type guard that returns true if the value structurally resembles an
 * {@link OperationFault} (carries `code`, `message`, and `data` properties).
 *
 * Used by error handlers to decide whether a thrown value can be mapped to a
 * structured operation fault response, vs. needing to be wrapped in a generic
 * 500.
 *
 * @example Catch an unknown error and surface as a fault when it qualifies
 * ```ts
 * import { isOperationFaultLike } from '@lostgradient/weft/server/handler';
 *
 * try {
 *   // operation handler runs here
 * } catch (error) {
 *   if (isOperationFaultLike(error)) {
 *     // structured fault — pass through
 *   } else {
 *     // unknown — wrap as 500
 *   }
 * }
 * ```
 */
export function isOperationFaultLike(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!hasRequiredFaultProperties(candidate)) {
    return false;
  }

  const fields = readFaultProperties(candidate);
  if (fields === null) return false;

  // `Object.hasOwn` (not `in`) so we don't accidentally promote a
  // foreign object whose `code` is `'__proto__'`, `'constructor'`,
  // or any other inherited property of `FAULT_CODE_TO_HTTP_STATUS`.
  return (
    typeof fields.code === 'string' &&
    Object.hasOwn(FAULT_CODE_TO_HTTP_STATUS, fields.code) &&
    typeof fields.message === 'string' &&
    typeof fields.data === 'object' &&
    fields.data !== null &&
    !Array.isArray(fields.data)
  );
}

/**
 * Lazily initialized discovery registry used when callers supply neither a
 * custom registry nor live worker infrastructure. The discovery registry is
 * stateless and shared; injected worker state gets a live registry cached for
 * the supplied worker-registry/task-queue pair.
 */
let defaultOperationRegistryCache: OperationRegistry | undefined;
const missingWorkerRegistryCacheKey = {};
const missingTaskQueueCacheKey = {};
const liveOperationRegistryCache = new WeakMap<object, WeakMap<object, OperationRegistry>>();

export function defaultOperationRegistry(
  options?: Pick<HandlerOptions, 'workerRegistry' | 'taskQueue'>,
): OperationRegistry {
  if (options?.workerRegistry !== undefined || options?.taskQueue !== undefined) {
    const workerRegistryCacheKey = options.workerRegistry ?? missingWorkerRegistryCacheKey;
    const taskQueueCacheKey = options.taskQueue ?? missingTaskQueueCacheKey;
    let registriesByTaskQueue = liveOperationRegistryCache.get(workerRegistryCacheKey);
    if (registriesByTaskQueue === undefined) {
      registriesByTaskQueue = new WeakMap<object, OperationRegistry>();
      liveOperationRegistryCache.set(workerRegistryCacheKey, registriesByTaskQueue);
    }

    let registry = registriesByTaskQueue.get(taskQueueCacheKey);
    if (registry === undefined) {
      registry = createLiveOperationRegistry(options);
      registriesByTaskQueue.set(taskQueueCacheKey, registry);
    }
    return registry;
  }
  if (defaultOperationRegistryCache === undefined) {
    defaultOperationRegistryCache = createLiveOperationRegistry();
  }
  return defaultOperationRegistryCache;
}

let defaultRestBindingsCache: ReadonlyArray<UnknownRestBinding> | undefined;

export function defaultRestBindings(): ReadonlyArray<UnknownRestBinding> {
  if (defaultRestBindingsCache === undefined) {
    defaultRestBindingsCache = createLiveRestBindings();
  }
  return defaultRestBindingsCache;
}
