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

import type { Engine } from '../../core/engine.ts';
import { MalformedRouteParameterError } from '../rest-binding.ts';
import { matchRestBinding } from './binding-dispatch.ts';
import { errorResponse } from './response-helpers.ts';
import {
  authContextToPrincipal,
  defaultOperationRegistry,
  defaultRestBindings,
  DIRECT_ROUTE_EXECUTORS,
  dispatchViaExecuteOperation,
  type HandlerOptions,
} from './route-dispatch.ts';
import { matchDirectRoute } from './route-matching.ts';

export {
  authContextToPrincipal,
  isOperationFaultLike,
  type HandlerOptions,
} from './route-dispatch.ts';
export { extractRouteParameters, getRequiredRouteParameter } from './route-matching.ts';

type RouteLookup<T> = { kind: 'matched'; value: T } | { kind: 'malformed'; response: Response };

function routeParameterErrorResponse(error: unknown): Response | null {
  if (error instanceof MalformedRouteParameterError) return errorResponse(error.message, 400);
  return null;
}

function matchRouteBoundary<T>(matcher: () => T): RouteLookup<T> {
  try {
    return { kind: 'matched', value: matcher() };
  } catch (error) {
    const response = routeParameterErrorResponse(error);
    if (response !== null) return { kind: 'malformed', response };
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

/**
 * Pure HTTP request handler. Maps Request to Response.
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
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);

  const optionError = validateHandlerOptions(options);
  if (optionError !== null) return optionError;

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
