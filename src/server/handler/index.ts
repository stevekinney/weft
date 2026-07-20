/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * Dispatch model: REST-only meta and discovery endpoints are reserved direct
 * routes, using the table shared with the OpenAPI generator. Every other
 * operation-backed REST route is resolved through `RestBinding` entries and
 * the `dispatchViaExecuteOperation` pipeline.
 *
 * @module server/handler
 */

import type { Engine, RegistryAgnosticEngine } from '../../core/engine.ts';
import { MalformedRouteParameterError } from '../rest-binding.ts';
import { authContextToPrincipal } from './auth-context-principal.ts';
import { matchRestBinding } from './binding-dispatch.ts';
import { errorResponse } from './response-helpers.ts';
import {
  defaultOperationRegistry,
  defaultRestBindings,
  DIRECT_ROUTE_EXECUTORS,
  dispatchViaExecuteOperation,
  type HandlerOptions,
} from './route-dispatch.ts';
import { matchDirectRoute } from './route-matching.ts';
import type { LiveEventStreamContext } from './sse-route-dispatch.ts';

export { authContextToPrincipal } from './auth-context-principal.ts';
export { isOperationFaultLike, type HandlerOptions } from './route-dispatch.ts';
export { extractRouteParameters, getRequiredRouteParameter } from './route-matching.ts';

type RouteLookup<T> = { kind: 'matched'; value: T } | { kind: 'malformed'; response: Response };

function matchRouteBoundary<T>(matcher: () => T): RouteLookup<T> {
  try {
    return { kind: 'matched', value: matcher() };
  } catch (error) {
    // Only malformed route parameters are a client error (400). Any other
    // throw is an unexpected bug in route matching; re-throw it so the caller
    // logs it and returns 500 instead of silently masking it as a 400.
    if (error instanceof MalformedRouteParameterError) {
      return { kind: 'malformed', response: errorResponse(error.message, 400) };
    }
    throw error;
  }
}

function validateHandlerOptions(options: HandlerOptions | undefined): Response | null {
  if ((options?.restBindings === undefined) === (options?.operationRegistry === undefined)) {
    return null;
  }
  return errorResponse(
    '`restBindings` and `operationRegistry` must be supplied together (or both omitted).',
    500,
  );
}

function liveEventStreamContextFromOptions(
  options: HandlerOptions | undefined,
): LiveEventStreamContext {
  const context: LiveEventStreamContext = {};
  if (options?.workflowEventFeed !== undefined)
    context.workflowEventFeed = options.workflowEventFeed;
  if (options?.fleetEventFeed !== undefined) context.fleetEventFeed = options.fleetEventFeed;
  if (options?.acquireWorkflowStreamConnection !== undefined) {
    context.acquireWorkflowStreamConnection = options.acquireWorkflowStreamConnection;
  }
  return context;
}

async function dispatchRestBinding(
  request: Request,
  engine: Engine,
  bindingMatch: NonNullable<ReturnType<typeof matchRestBinding>>,
  operationRegistry: ReturnType<typeof defaultOperationRegistry>,
  options: HandlerOptions | undefined,
  url: URL,
): Promise<Response> {
  try {
    const principal = authContextToPrincipal(options?.authContext);
    return await dispatchViaExecuteOperation(
      request,
      engine,
      bindingMatch.binding,
      bindingMatch.pathParams,
      operationRegistry,
      principal,
      options?.pipelineTrace,
      options?.maxRequestBodyBytes,
      options?.supportedAuthenticationSchemes,
      liveEventStreamContextFromOptions(options),
    );
  } catch (error) {
    console.error('Unhandled error in dispatchViaExecuteOperation', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}

async function dispatchDirectRoute(
  request: Request,
  engine: Engine,
  route: NonNullable<ReturnType<typeof matchDirectRoute>>,
  options: HandlerOptions | undefined,
  url: URL,
): Promise<Response> {
  try {
    const executor = DIRECT_ROUTE_EXECUTORS[route.handler];
    return await executor({ request, engine, options });
  } catch (error) {
    console.error('Unhandled error in handleRequest', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}

async function dispatchMatchedRoute(
  request: Request,
  engine: Engine,
  options: HandlerOptions | undefined,
  url: URL,
): Promise<Response> {
  const directRouteLookup = matchRouteBoundary(() =>
    matchDirectRoute(request.method, url.pathname),
  );
  if (directRouteLookup.kind === 'malformed') return directRouteLookup.response;

  if (directRouteLookup.value !== null) {
    return dispatchDirectRoute(request, engine, directRouteLookup.value, options, url);
  }

  const restBindings = options?.restBindings ?? defaultRestBindings();
  const operationRegistry = options?.operationRegistry ?? defaultOperationRegistry();
  const bindingLookup = matchRouteBoundary(() =>
    matchRestBinding(request.method, url.pathname, restBindings),
  );
  if (bindingLookup.kind === 'malformed') return bindingLookup.response;

  if (bindingLookup.value !== null) {
    return dispatchRestBinding(
      request,
      engine,
      bindingLookup.value,
      operationRegistry,
      options,
      url,
    );
  }

  return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
}

async function dispatchMatchedRouteBoundary(
  request: Request,
  engine: Engine,
  options: HandlerOptions | undefined,
  url: URL,
): Promise<Response> {
  try {
    return await dispatchMatchedRoute(request, engine, options, url);
  } catch (error) {
    // Unexpected route-matching failure (not a MalformedRouteParameterError,
    // which `matchRouteBoundary` already turns into a 400). Surface it as a
    // logged 500 rather than letting it escape uncaught.
    console.error('Unhandled error in handleRequest route matching', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}

/**
 * Pure HTTP request handler. Maps Request to Response.
 *
 * `engine` is typed as {@link RegistryAgnosticEngine} (see its JSDoc) rather
 * than the plain default `Engine`, so both `new Engine({ storage })` and
 * `Engine.create({ workflows })` type-check here directly. This module's
 * dispatch chain only calls registry-erased `Engine` methods, so the value is
 * registry-erased back to the plain `Engine` once, internally.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, handleRequest } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 *
 * const request = new Request('http://localhost/v1/health');
 * const response = await handleRequest(request, engine);
 * console.log(response.status); // 200
 * ```
 */
export async function handleRequest(
  request: Request,
  engine: RegistryAgnosticEngine,
  options?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);

  const optionError = validateHandlerOptions(options);
  if (optionError !== null) return optionError;

  // Registry-erase back to the plain default `Engine` that the rest of this
  // module's dispatch chain is typed against — see this function's JSDoc.
  return dispatchMatchedRouteBoundary(request, engine as Engine, options, url);
}
