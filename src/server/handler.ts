/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * Every route delegates to an {@link Engine} method — the handler is a
 * thin translation layer between HTTP and the Engine public API.
 *
 * @module server/handler
 */

import { encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import type {
  AttributeFilter,
  ListFilter,
  ReviewDecision,
  SearchAttributeValue,
  WorkflowStatus,
} from '../core/types.ts';
import { UpdateTimeoutError } from '../core/updates.ts';
import { METRICS } from '../observability/metrics.ts';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface RouteMatch {
  handler: string;
  params: Record<string, string>;
}

const ROUTE_PATTERNS: Array<{
  method: string;
  pattern: RegExp;
  handler: string;
  paramNames: string[];
}> = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    handler: 'healthCheck',
    paramNames: [],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows$/,
    handler: 'startWorkflow',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows$/,
    handler: 'listWorkflows',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/result$/,
    handler: 'getWorkflowResult',
    paramNames: ['id'],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/([^/]+)\/signal\/([^/]+)$/,
    handler: 'signalWorkflow',
    paramNames: ['id', 'name'],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/([^/]+)\/update\/([^/]+)$/,
    handler: 'updateWorkflow',
    paramNames: ['id', 'name'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/updates\/([^/]+)$/,
    handler: 'getUpdateResult',
    paramNames: ['updateId'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/attributes$/,
    handler: 'getAttributes',
    paramNames: ['id'],
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/workflows\/([^/]+)\/attributes$/,
    handler: 'setAttributes',
    paramNames: ['id'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/metrics$/,
    handler: 'getMetrics',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/events$/,
    handler: 'getWorkflowEvents',
    paramNames: ['id'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reviews$/,
    handler: 'listReviews',
    paramNames: [],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/reviews\/([^/]+)\/decision$/,
    handler: 'submitReviewDecision',
    paramNames: ['reviewId'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)$/,
    handler: 'getWorkflow',
    paramNames: ['id'],
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/workflows\/([^/]+)$/,
    handler: 'cancelWorkflow',
    paramNames: ['id'],
  },
];

function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of ROUTE_PATTERNS) {
    if (route.method !== method) continue;

    const match = route.pattern.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      const name = route.paramNames[i];
      const value = match[i + 1];
      if (name !== undefined && value !== undefined) {
        params[name] = decodeURIComponent(value);
      }
    }

    return { handler: route.handler, params };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function msgpackResponse(body: unknown, status: number = 200): Response {
  return new Response(encode(body), {
    status,
    headers: { 'Content-Type': 'application/msgpack' },
  });
}

function negotiatedResponse(request: Request, body: unknown, status: number = 200): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('application/msgpack')) {
    return msgpackResponse(body, status);
  }
  return jsonResponse(body, status);
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Route handlers — each delegates to an Engine method
// ---------------------------------------------------------------------------

async function handleStartWorkflow(request: Request, engine: Engine): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  const { type, input, id, executionTimeout } = body as Record<string, unknown>;

  if (typeof type !== 'string' || type.length === 0) {
    return errorResponse('Missing required field: type', 400);
  }

  try {
    const options: Record<string, unknown> = {};
    if (id !== undefined) {
      options['id'] = id;
    }
    if (executionTimeout !== undefined) {
      options['executionTimeout'] = executionTimeout;
    }

    const handle = await engine.start(type, input, options);
    return jsonResponse({ id: handle.id }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('No workflow registered')) {
      return errorResponse(message, 400);
    }
    if (message.includes('already exists')) {
      return errorResponse(message, 409);
    }

    return errorResponse(message, 500);
  }
}

function parseAttributeFilters(params: URLSearchParams): AttributeFilter[] {
  const filterMap = new Map<string, AttributeFilter>();

  for (const [key, value] of params) {
    if (!key.startsWith('attr.')) continue;

    const rest = key.slice(5); // strip "attr."
    const dotIndex = rest.indexOf('.');

    if (dotIndex === -1) {
      // Exact match: attr.{name}={value}
      const name = rest;
      const existing = filterMap.get(name) ?? { key: name };
      existing.value = inferAttributeValue(value);
      filterMap.set(name, existing);
    } else {
      // Range: attr.{name}.gte={value} or attr.{name}.lte={value}
      const name = rest.slice(0, dotIndex);
      const operator = rest.slice(dotIndex + 1);
      const existing = filterMap.get(name) ?? { key: name };

      if (operator === 'gte') {
        existing.gte = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lte') {
        existing.lte = inferAttributeValue(value);
        filterMap.set(name, existing);
      }
      // Unknown operators are silently skipped to avoid unconstrained range scans.
    }
  }

  return [...filterMap.values()];
}

/** Infer the type of an attribute value from its string representation. */
function inferAttributeValue(raw: string): SearchAttributeValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && raw.trim() !== '') return asNumber;

  return raw;
}

async function handleListWorkflows(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const filter: ListFilter = {};

  const status = url.searchParams.get('status');
  if (status !== null) {
    filter.status = status as WorkflowStatus;
  }

  const type = url.searchParams.get('type');
  if (type !== null) {
    filter.type = type;
  }

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (Number.isFinite(parsed) && parsed >= 1) {
      filter.limit = Math.min(Math.floor(parsed), 1000);
    }
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    const parsed = Number(offset);
    if (Number.isFinite(parsed) && parsed >= 0) {
      filter.offset = Math.floor(parsed);
    }
  }

  // Parse attribute filters: attr.{name}={value}, attr.{name}.gte={value}, attr.{name}.lte={value}
  const attributeFilters = parseAttributeFilters(url.searchParams);
  if (attributeFilters.length > 0) {
    filter.attributes = attributeFilters;
  }

  const result = await engine.list(filter);
  return jsonResponse(result);
}

async function handleGetWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  return jsonResponse(state);
}

async function handleCancelWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    await engine.cancel(workflowId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    return errorResponse(message, 500);
  }
}

async function handleSignalWorkflow(
  request: Request,
  engine: Engine,
  workflowId: string,
  signalName: string,
): Promise<Response> {
  let payload: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    payload = body['payload'];
  } catch {
    // No body or invalid JSON is fine for signals -- payload is optional
  }

  try {
    await engine.signal(workflowId, signalName, payload);
    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }

    return errorResponse(message, 500);
  }
}

async function handleGetWorkflowResult(engine: Engine, workflowId: string): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  if (state.status === 'completed') {
    return jsonResponse({ result: state.result });
  }

  if (state.status === 'failed') {
    return errorResponse(state.error ?? 'Workflow failed', 422);
  }

  if (state.status === 'cancelled') {
    return errorResponse('Workflow cancelled', 422);
  }

  // Workflow is still running -- await with a timeout
  const handle = engine.getHandle(workflowId);
  const timeoutMilliseconds = 30_000;

  try {
    const result = await Promise.race([
      handle.result(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('Timeout waiting for workflow result')),
          timeoutMilliseconds,
        );
      }),
    ]);

    return jsonResponse({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('Timeout')) {
      return errorResponse('Timeout waiting for workflow result', 408);
    }

    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Update routes — engine.submitCoordinatedUpdate() / engine.getUpdateResult()
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

async function handleUpdateWorkflow(
  request: Request,
  engine: Engine,
  workflowId: string,
  updateName: string,
): Promise<Response> {
  let payload: unknown;
  let timeout = DEFAULT_UPDATE_TIMEOUT_MS;
  let idempotencyKey: string | undefined;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    payload = body['payload'];
    if (typeof body['timeout'] === 'number') {
      timeout = body['timeout'];
    }
    if (typeof body['idempotencyKey'] === 'string') {
      idempotencyKey = body['idempotencyKey'];
    }
  } catch {
    // No body or invalid JSON — payload stays undefined
  }

  const updateOptions: { timeout?: number; idempotencyKey?: string } = { timeout };
  if (idempotencyKey !== undefined) {
    updateOptions.idempotencyKey = idempotencyKey;
  }

  try {
    const result = await engine.submitCoordinatedUpdate(
      workflowId,
      updateName,
      payload,
      updateOptions,
    );

    if (result.error !== undefined) {
      return errorResponse(result.error, 422);
    }

    return jsonResponse({ updateId: result.updateId, result: result.result });
  } catch (error) {
    if (error instanceof UpdateTimeoutError) {
      return errorResponse(error.message, 408);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleGetUpdateResult(engine: Engine, updateId: string): Promise<Response> {
  const response = await engine.getUpdateResult(updateId);

  if (response === null) {
    return jsonResponse({ status: 'pending' }, 202);
  }

  return jsonResponse({
    status: 'completed',
    result: response.result,
    ...(response.error !== undefined ? { error: response.error } : {}),
  });
}

// ---------------------------------------------------------------------------
// Attributes routes — engine.getAttributes() / engine.setAttributes()
// ---------------------------------------------------------------------------

async function handleGetAttributes(engine: Engine, workflowId: string): Promise<Response> {
  const attributes = await engine.getAttributes(workflowId);
  if (attributes === null) {
    return errorResponse(`Attributes for workflow "${workflowId}" not found`, 404);
  }

  return jsonResponse(attributes);
}

async function handleSetAttributes(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  let incoming: Record<string, unknown>;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    incoming = (body['attributes'] as Record<string, unknown>) ?? {};
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  await engine.setAttributes(workflowId, incoming as Record<string, SearchAttributeValue>);

  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Events route — engine.getEvents()
// ---------------------------------------------------------------------------

async function handleGetWorkflowEvents(engine: Engine, workflowId: string): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const events = await engine.getEvents(workflowId);
  return jsonResponse({ events });
}

// ---------------------------------------------------------------------------
// Reviews routes — engine.listReviews() / engine.submitReview()
// ---------------------------------------------------------------------------

async function handleListReviews(engine: Engine): Promise<Response> {
  const reviews = await engine.listReviews();
  return jsonResponse({ items: reviews });
}

const VALID_DECISIONS = ['approved', 'rejected', 'needs-changes'] as const;

async function handleSubmitReviewDecision(
  request: Request,
  engine: Engine,
  reviewId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const decision = body['decision'];
  const reviewer = body['reviewer'];
  const feedback = body['feedback'];
  const workflowId = body['workflowId'];

  if (typeof decision !== 'string' || typeof reviewer !== 'string') {
    return errorResponse('Missing required fields: decision, reviewer', 400);
  }

  if (!VALID_DECISIONS.includes(decision as (typeof VALID_DECISIONS)[number])) {
    return errorResponse(
      `Invalid decision "${decision}". Must be one of: ${VALID_DECISIONS.join(', ')}`,
      400,
    );
  }

  if (feedback !== undefined && typeof feedback !== 'string') {
    return errorResponse('Field "feedback" must be a string when provided', 400);
  }

  try {
    const reviewOptions: import('../core/types.ts').SubmitReviewOptions = {
      decision: decision as ReviewDecision,
      reviewer,
    };
    if (typeof feedback === 'string') {
      reviewOptions.feedback = feedback;
    }
    if (typeof workflowId === 'string') {
      reviewOptions.workflowId = workflowId;
    }

    await engine.submitReview(reviewId, reviewOptions);

    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Metrics route
// ---------------------------------------------------------------------------

function handleGetMetrics(): Response {
  const lines: string[] = [];

  for (const metric of Object.values(METRICS)) {
    const safeName = metric.name.replace(/\./g, '_');
    lines.push(`# HELP ${safeName} ${metric.description}`);
    lines.push(`# TYPE ${safeName} ${metric.type === 'counter' ? 'counter' : 'gauge'}`);
    lines.push(`${safeName}${metric.type === 'counter' ? '_total' : ''} 0`);
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/** Pure HTTP request handler. Maps Request to Response. */
export async function handleRequest(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(request.method, url.pathname);

  if (route === null) {
    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }

  const param = (name: string): string => {
    const value = route.params[name];
    if (value === undefined) {
      throw new Error(`Missing route parameter: ${name}`);
    }
    return value;
  };

  try {
    switch (route.handler) {
      case 'healthCheck':
        return negotiatedResponse(request, { status: 'ok' });

      case 'startWorkflow':
        return handleStartWorkflow(request, engine);

      case 'listWorkflows':
        return handleListWorkflows(request, engine);

      case 'getWorkflow':
        return handleGetWorkflow(engine, param('id'));

      case 'cancelWorkflow':
        return handleCancelWorkflow(engine, param('id'));

      case 'signalWorkflow':
        return handleSignalWorkflow(request, engine, param('id'), param('name'));

      case 'getWorkflowResult':
        return handleGetWorkflowResult(engine, param('id'));

      case 'updateWorkflow':
        return handleUpdateWorkflow(request, engine, param('id'), param('name'));

      case 'getUpdateResult':
        return handleGetUpdateResult(engine, param('updateId'));

      case 'getAttributes':
        return handleGetAttributes(engine, param('id'));

      case 'setAttributes':
        return handleSetAttributes(request, engine, param('id'));

      case 'getMetrics':
        return handleGetMetrics();

      case 'getWorkflowEvents':
        return handleGetWorkflowEvents(engine, param('id'));

      case 'listReviews':
        return handleListReviews(engine);

      case 'submitReviewDecision':
        return handleSubmitReviewDecision(request, engine, param('reviewId'));

      default:
        return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
    }
  } catch (error) {
    console.error('Unhandled error in handleRequest', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}
