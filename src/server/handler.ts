/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * Every route delegates to an {@link Engine} method — the handler is a
 * thin translation layer between HTTP and the Engine public API.
 *
 * @module server/handler
 */

import type { BudgetPolicyOptions } from '../ai/budget-policy.ts';
import { formatSSE } from '../ai/streaming-agent.ts';
import { assertScopedBulkWorkflowFilter } from '../core/bulk-workflow-filter.ts';
import { encode } from '../core/codec.ts';
import type { StoredStreamChunk } from '../core/context.ts';
import { BulkDeleteRequiresTerminalWorkflowsError, type Engine } from '../core/engine.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
} from '../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../core/tenant-quotas.ts';
import type {
  AttributeFilter,
  ForkOptions,
  ListFilter,
  ReviewDecision,
  ScheduleAccessOptions,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleStatus,
  SearchAttributeValue,
  StartOptions,
  WorkflowStatus,
} from '../core/types.ts';
import { UpdateTimeoutError, WorkflowTerminalError } from '../core/updates.ts';
import {
  createMetricsCollectorExporter,
  type MetricsCollector,
  type PrometheusExporter,
} from '../observability/metrics.ts';
import type { AuthContext, JWTPayload } from './authentication.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { generateOpenApiDocument } from './openapi.ts';
import { executeOperation, type OperationRegistry } from './operation-catalog.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  type Principal,
} from './principal.ts';
import { bindingPathMatches } from './rest-binding.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { resolveRestDispatchMode, type RestDispatchModeConfig } from './rest-dispatch-mode.ts';
import { ROUTES, toRegex } from './route-model.ts';
import { parseOptionalSequenceCursor } from './sequence-cursor.ts';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/** Union of all handler names derived from the shared route model. */
type HandlerName = (typeof ROUTES)[number]['handler'];

interface RouteMatch {
  handler: HandlerName;
  params: Record<string, string>;
}

/** Alias for `AuthContext` — kept local so handler-internal code reads naturally. */
type AuthenticatedRequestContext = AuthContext;

class MalformedRouteParameterError extends Error {
  constructor() {
    super('Malformed route parameter encoding');
    this.name = 'MalformedRouteParameterError';
  }
}

/**
 * Route patterns derived from the shared route model. The regex is computed
 * once at module load time for the hot path.
 */
const ROUTE_PATTERNS: Array<{
  method: (typeof ROUTES)[number]['method'];
  pattern: RegExp;
  handler: HandlerName;
  paramNames: readonly string[];
}> = [];
const textEncoder = new TextEncoder();

for (const route of ROUTES) {
  ROUTE_PATTERNS.push({
    method: route.method,
    pattern: toRegex(route.path),
    handler: route.handler,
    paramNames: route.paramNames,
  });
}

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
        try {
          params[name] = decodeURIComponent(value);
        } catch {
          throw new MalformedRouteParameterError();
        }
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

function getAuthenticatedTenantId(claims: JWTPayload | undefined): string | null {
  if (!claims) {
    return null;
  }

  for (const key of ['tenantId', 'tenant_id', 'tenant'] as const) {
    const value = claims[key];
    if (typeof value === 'string') {
      const normalizedTenantId = value.trim();
      if (normalizedTenantId.length > 0) {
        return normalizedTenantId;
      }
    }
  }

  return null;
}

function parseAfterQueryParameter(request: Request): number | Response | undefined {
  const result = parseOptionalSequenceCursor(
    new URL(request.url).searchParams.get('after'),
    'after query parameter',
  );
  if (result.error) {
    return errorResponse(result.error, 400);
  }

  return result.value;
}

function parseLastEventIdHeader(request: Request): number | Response | undefined {
  const result = parseOptionalSequenceCursor(
    request.headers.get('Last-Event-ID'),
    'Last-Event-ID header',
  );
  if (result.error) {
    return errorResponse(result.error, 400);
  }

  return result.value;
}

function createStoredChunkSSEStream(
  chunks: StoredStreamChunk[],
  mapChunkToText: (chunk: StoredStreamChunk) => string | null,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        const text = mapChunkToText(chunk);
        if (text === null) {
          continue;
        }

        controller.enqueue(
          textEncoder.encode(
            formatSSE({
              id: String(chunk.sequence),
              event: 'token',
              data: text,
            }),
          ),
        );
      }

      controller.enqueue(
        textEncoder.encode(
          formatSSE({
            event: 'done',
            data: '',
          }),
        ),
      );
      controller.close();
    },
  });
}

export function getRequiredRouteParameter(
  params: Record<string, string>,
  name: string,
  routeDescription: string,
): string {
  const value = params[name];
  if (value === undefined) {
    throw new Error(`Missing route parameter "${name}" for ${routeDescription}`);
  }
  return value;
}

function validateStartWorkflowOptions(body: Record<string, unknown>): StartOptions {
  const options: StartOptions = {};

  const id = body['id'];
  if (id !== undefined) {
    options.id = coerceStartWorkflowId(id, 'Field "id"');
  }

  const executionTimeout = body['executionTimeout'];
  if (executionTimeout !== undefined) {
    options.executionTimeout = coerceStartWorkflowDuration(
      executionTimeout,
      'Field "executionTimeout"',
    );
  }

  const startAt = body['startAt'];
  if (startAt !== undefined) {
    options.startAt = coerceStartWorkflowTimestamp(startAt, 'Field "startAt"');
  }

  const startAfter = body['startAfter'];
  if (startAfter !== undefined) {
    options.startAfter = coerceStartWorkflowDuration(startAfter, 'Field "startAfter"');
  }

  const tags = body['tags'];
  if (tags !== undefined) {
    options.tags = coerceStartWorkflowTags(tags, 'Field "tags"');
  }

  assertExclusiveStartWorkflowOptions(options.startAt, options.startAfter);

  return options;
}

const VALID_SCHEDULE_OVERLAP_POLICIES = new Set<NonNullable<ScheduleOptions['overlap']>>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);
const VALID_SCHEDULE_STATUSES = new Set<ScheduleStatus>(['active', 'paused', 'cancelled']);

function validateScheduleOptions(body: Record<string, unknown>): {
  type: string;
  input: unknown;
  cronExpression: string;
  options: ScheduleOptions;
} {
  const type = body['type'];
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('Missing required field: type');
  }

  const cronExpression = body['cronExpression'];
  if (typeof cronExpression !== 'string' || cronExpression.length === 0) {
    throw new Error('Missing required field: cronExpression');
  }

  const options: ScheduleOptions = {};

  const id = body['id'];
  if (id !== undefined) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Field "id" must be a non-empty string');
    }
    options.id = id;
  }

  const overlap = body['overlap'];
  if (overlap !== undefined) {
    if (
      typeof overlap !== 'string' ||
      !VALID_SCHEDULE_OVERLAP_POLICIES.has(overlap as NonNullable<ScheduleOptions['overlap']>)
    ) {
      throw new Error('Field "overlap" must be one of skip, queue, cancel-running, allow');
    }
    options.overlap = overlap as NonNullable<ScheduleOptions['overlap']>;
  }

  const backfill = body['backfill'];
  if (backfill !== undefined) {
    if (typeof backfill !== 'boolean') {
      throw new Error('Field "backfill" must be a boolean');
    }
    options.backfill = backfill;
  }

  return {
    type,
    input: body['input'],
    cronExpression,
    options,
  };
}

function parseScheduleListFilter(request: Request): ScheduleFilter {
  const url = new URL(request.url);
  const filter: ScheduleFilter = {};

  const statuses = url.searchParams.getAll('status');
  if (statuses.length > 0) {
    const normalizedStatuses: ScheduleStatus[] = [];
    for (const status of statuses) {
      if (!VALID_SCHEDULE_STATUSES.has(status as ScheduleStatus)) {
        throw new Error('Query parameter "status" must be one of active, paused, cancelled');
      }
      normalizedStatuses.push(status as ScheduleStatus);
    }

    const [firstStatus] = normalizedStatuses;
    if (normalizedStatuses.length === 1 && firstStatus !== undefined) {
      filter.status = firstStatus;
    } else {
      filter.status = normalizedStatuses;
    }
  }

  const workflowType = url.searchParams.get('workflowType');
  if (workflowType !== null) {
    filter.workflowType = workflowType;
  }

  const tenantId = url.searchParams.get('tenantId');
  if (tenantId !== null) {
    filter.tenantId = tenantId;
  }

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('Query parameter "limit" must be a positive integer');
    }
    filter.limit = Math.min(parsed, 1000);
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    const parsed = Number(offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('Query parameter "offset" must be a non-negative integer');
    }
    filter.offset = parsed;
  }

  return filter;
}

function scheduleErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('not found')) {
    return errorResponse(message, 404);
  }

  if (normalizedMessage.includes('already exists')) {
    return errorResponse(message, 409);
  }

  if (normalizedMessage.includes('cannot be resumed')) {
    return errorResponse(message, 409);
  }

  if (normalizedMessage.includes('authenticated tenant')) {
    return errorResponse(message, 403);
  }

  if (
    message.includes('Missing required field') ||
    normalizedMessage.includes('must be') ||
    normalizedMessage.includes('no workflow registered') ||
    normalizedMessage.includes('cron')
  ) {
    return errorResponse(message, 400);
  }

  return errorResponse(message, 500);
}

function getAuthenticatedScheduleTenantId(
  authContext: AuthenticatedRequestContext | undefined,
): string | Response | undefined {
  if (authContext?.method !== 'jwt') {
    return undefined;
  }

  const authenticatedTenantId = getAuthenticatedTenantId(authContext.claims);
  if (authenticatedTenantId === null) {
    return errorResponse(
      'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim',
      403,
    );
  }

  return authenticatedTenantId;
}

function applyAuthenticatedScheduleTenantScope(
  filter: ScheduleFilter,
  authContext: AuthenticatedRequestContext | undefined,
): Response | undefined {
  const authenticatedTenantId = getAuthenticatedScheduleTenantId(authContext);
  if (authenticatedTenantId instanceof Response) {
    return authenticatedTenantId;
  }

  if (authenticatedTenantId === undefined) {
    return undefined;
  }

  if (filter.tenantId !== undefined && filter.tenantId !== authenticatedTenantId) {
    return errorResponse('Schedule access is limited to the authenticated tenant', 403);
  }

  filter.tenantId = authenticatedTenantId;
  return undefined;
}

function getScheduleAccessOptions(
  authContext: AuthenticatedRequestContext | undefined,
): ScheduleAccessOptions | Response | undefined {
  const authenticatedTenantId = getAuthenticatedScheduleTenantId(authContext);
  if (authenticatedTenantId instanceof Response) {
    return authenticatedTenantId;
  }

  if (authenticatedTenantId === undefined) {
    return undefined;
  }

  return { tenantId: authenticatedTenantId };
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

  const { type, input, id, executionTimeout, startAt, startAfter, tags } = body as Record<
    string,
    unknown
  >;

  if (typeof type !== 'string' || type.length === 0) {
    return errorResponse('Missing required field: type', 400);
  }

  let options: StartOptions;
  try {
    options = validateStartWorkflowOptions({
      id,
      executionTimeout,
      startAt,
      startAfter,
      tags,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  try {
    const handle = await engine.start(type, input, options);
    return jsonResponse({ id: handle.id }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof StartWorkflowValidationError) {
      return errorResponse(message, 400);
    }
    if (error instanceof QuotaExceededError) {
      return errorResponse(message, 429);
    }
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

      if (operator === 'gt') {
        existing.gt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lt') {
        existing.lt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'gte') {
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

function isJsonSearchAttributeValue(value: unknown): value is SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseAttributeFiltersFromBody(value: unknown): AttributeFilter[] {
  if (!Array.isArray(value)) {
    throw new Error('Field "filter.attributes" must be an array');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Field "filter.attributes[${index}]" must be an object`);
    }

    const record = entry as Record<string, unknown>;
    const key = record['key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Field "filter.attributes[${index}].key" must be a non-empty string`);
    }

    const filter: AttributeFilter = { key };
    for (const property of ['value', 'gt', 'lt', 'gte', 'lte'] as const) {
      const attributeValue = record[property];
      if (attributeValue === undefined) {
        continue;
      }

      if (!isJsonSearchAttributeValue(attributeValue)) {
        throw new Error(
          `Field "filter.attributes[${index}].${property}" must be a string, number, boolean, or string array`,
        );
      }

      filter[property] = attributeValue;
    }

    return filter;
  });
}

function parseFilterStatus(value: unknown): ListFilter['status'] {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value as WorkflowStatus;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as WorkflowStatus[];
  }

  throw new Error('Field "filter.status" must be a string or an array of strings');
}

function parseOptionalFilterType(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error('Field "filter.type" must be a string');
}

function parseOptionalFilterTags(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return coerceStartWorkflowTags(value, 'Field "filter.tags"');
}

function parseOptionalFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Field "filter.${fieldName}" must be a non-negative number`);
  }

  return Math.floor(value);
}

function parseListFilterBody(body: unknown): ListFilter {
  if (body === undefined) {
    return {};
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const rawFilter = record['filter'];
  if (rawFilter === undefined) {
    return {};
  }

  if (typeof rawFilter !== 'object' || rawFilter === null) {
    throw new Error('Field "filter" must be an object');
  }

  const filterRecord = rawFilter as Record<string, unknown>;
  const filter: ListFilter = {};
  const status = parseFilterStatus(filterRecord['status']);
  if (status !== undefined) {
    filter.status = status;
  }

  const type = parseOptionalFilterType(filterRecord['type']);
  if (type !== undefined) {
    filter.type = type;
  }

  const tags = parseOptionalFilterTags(filterRecord['tags']);
  if (tags !== undefined) {
    filter.tags = tags;
  }

  if (filterRecord['attributes'] !== undefined) {
    filter.attributes = parseAttributeFiltersFromBody(filterRecord['attributes']);
  }

  const limit = parseOptionalFilterNumber(filterRecord['limit'], 'limit');
  if (limit !== undefined) {
    filter.limit = limit;
  }

  const offset = parseOptionalFilterNumber(filterRecord['offset'], 'offset');
  if (offset !== undefined) {
    filter.offset = offset;
  }

  return filter;
}

type ParsedJsonBody =
  | undefined
  | null
  | boolean
  | number
  | string
  | Record<string, unknown>
  | unknown[];

async function parseOptionalJsonBody(request: Request): Promise<Response | ParsedJsonBody> {
  try {
    const rawBody = await request.text();
    if (rawBody.trim() === '') {
      return undefined;
    }

    return JSON.parse(rawBody) as ParsedJsonBody;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
}

function parseRequiredBulkWorkflowFilter(body: unknown): ListFilter {
  return assertScopedBulkWorkflowFilter(parseListFilterBody(body));
}

async function handleListWorkflows(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const filter: ListFilter = {};

  const statuses = url.searchParams.getAll('status') as WorkflowStatus[];
  if (statuses.length === 1) {
    filter.status = statuses[0]!;
  } else if (statuses.length > 1) {
    filter.status = statuses;
  }

  const type = url.searchParams.get('type');
  if (type !== null) {
    filter.type = type;
  }

  const tags = url.searchParams.getAll('tag');
  if (tags.length > 0) {
    try {
      filter.tags = coerceStartWorkflowTags(tags, 'Query parameter "tag"');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
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

async function handleGetRetentionOverview(engine: Engine): Promise<Response> {
  return jsonResponse(engine.getRetentionOverview());
}

async function handleListSchedules(
  request: Request,
  engine: Engine,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const filter = parseScheduleListFilter(request);
    const authError = applyAuthenticatedScheduleTenantScope(filter, authContext);
    if (authError !== undefined) {
      return authError;
    }
    return jsonResponse(await engine.listSchedules(filter));
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handleCreateSchedule(
  request: Request,
  engine: Engine,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  try {
    const validated = validateScheduleOptions(body as Record<string, unknown>);
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }
    const handle = await engine.schedule(
      validated.type,
      validated.input,
      validated.cronExpression,
      validated.options,
      accessOptions,
    );
    return jsonResponse({ id: handle.id }, 201);
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handleGetSchedule(
  engine: Engine,
  scheduleId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }

    const schedule = await engine.getSchedule(scheduleId, accessOptions);
    if (schedule === null) {
      return errorResponse(`Schedule "${scheduleId}" not found`, 404);
    }

    return jsonResponse(schedule);
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handlePauseSchedule(
  engine: Engine,
  scheduleId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }

    await engine.pauseSchedule(scheduleId, accessOptions);
    return new Response(null, { status: 204 });
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handleResumeSchedule(
  engine: Engine,
  scheduleId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }

    await engine.resumeSchedule(scheduleId, accessOptions);
    return new Response(null, { status: 204 });
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handleCancelSchedule(
  engine: Engine,
  scheduleId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }

    await engine.cancelSchedule(scheduleId, accessOptions);
    return new Response(null, { status: 204 });
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handleUpdateSchedule(
  request: Request,
  engine: Engine,
  scheduleId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  const cronExpression = (body as Record<string, unknown>)['cronExpression'];
  if (typeof cronExpression !== 'string' || cronExpression.length === 0) {
    return errorResponse('Missing required field: cronExpression', 400);
  }

  try {
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }

    await engine.updateSchedule(scheduleId, cronExpression, accessOptions);
    return new Response(null, { status: 204 });
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handlePurgeWorkflows(request: Request, engine: Engine): Promise<Response> {
  const parsedBody = await parseOptionalJsonBody(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  let filter: ListFilter;
  try {
    filter = parseListFilterBody(parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  const result = await engine.purge(filter);
  return jsonResponse(result);
}

async function handleBulkCancelWorkflows(request: Request, engine: Engine): Promise<Response> {
  const parsedBody = await parseOptionalJsonBody(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  let filter: ListFilter;
  try {
    filter = parseRequiredBulkWorkflowFilter(parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  try {
    return jsonResponse(await engine.cancelAll(filter));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleBulkSignalWorkflows(request: Request, engine: Engine): Promise<Response> {
  const parsedBody = await parseOptionalJsonBody(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  const body = parseJsonRecordBody(parsedBody);
  if (!body) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  let filter: ListFilter;
  try {
    filter = parseRequiredBulkWorkflowFilter(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  const name = body['name'];
  if (typeof name !== 'string' || name.length === 0) {
    return errorResponse('Field "name" must be a non-empty string', 400);
  }

  try {
    return jsonResponse(await engine.signalAll(filter, name, body['payload']));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleBulkDeleteWorkflows(request: Request, engine: Engine): Promise<Response> {
  const parsedBody = await parseOptionalJsonBody(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  let filter: ListFilter;
  try {
    filter = parseRequiredBulkWorkflowFilter(parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  try {
    return jsonResponse(await engine.deleteAll(filter));
  } catch (error) {
    if (error instanceof BulkDeleteRequiresTerminalWorkflowsError) {
      return errorResponse(error.message, 422);
    }

    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleBulkMutateWorkflowTags(request: Request, engine: Engine): Promise<Response> {
  const parsedBody = await parseOptionalJsonBody(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  const body = parseJsonRecordBody(parsedBody);
  if (!body) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  let filter: ListFilter;
  try {
    filter = parseRequiredBulkWorkflowFilter(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  let tags: string[];
  try {
    tags = coerceStartWorkflowTags(body['tags'], 'Field "tags"');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }

  const operation = body['operation'];
  if (operation !== 'add' && operation !== 'remove') {
    return errorResponse('Field "operation" must be "add" or "remove"', 400);
  }

  try {
    const result =
      operation === 'add' ? await engine.tagAll(filter, tags) : await engine.untagAll(filter, tags);
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
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
    if (error instanceof WorkflowTerminalError) {
      return errorResponse(error.message, 422);
    }
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

function getWorkflowTagBodyValue(body: Record<string, unknown>): string[] {
  return coerceStartWorkflowTags(body['tags'], 'Field "tags"');
}

function parseJsonRecordBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  return body as Record<string, unknown>;
}

async function handleAddWorkflowTags(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsedBody = parseJsonRecordBody((await request.json()) as unknown);
    if (!parsedBody) {
      return errorResponse('Invalid JSON body', 400);
    }
    body = parsedBody;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  try {
    await engine.addTags(workflowId, ...getWorkflowTagBodyValue(body));
    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    if (error instanceof StartWorkflowValidationError) {
      return errorResponse(message, 400);
    }
    return errorResponse(message, 500);
  }
}

async function handleRemoveWorkflowTags(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsedBody = parseJsonRecordBody((await request.json()) as unknown);
    if (!parsedBody) {
      return errorResponse('Invalid JSON body', 400);
    }
    body = parsedBody;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  try {
    await engine.removeTags(workflowId, ...getWorkflowTagBodyValue(body));
    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    if (error instanceof StartWorkflowValidationError) {
      return errorResponse(message, 400);
    }
    return errorResponse(message, 500);
  }
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

async function handleGetReview(
  engine: Engine,
  workflowId: string,
  reviewId: string,
): Promise<Response> {
  const review = await engine.getReview(workflowId, reviewId);
  if (review === null) {
    return errorResponse(`Review "${reviewId}" not found for workflow "${workflowId}"`, 404);
  }
  return jsonResponse(review);
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
// Query route — engine.query()
// ---------------------------------------------------------------------------

async function handleQueryWorkflow(
  engine: Engine,
  workflowId: string,
  queryName: string,
): Promise<Response> {
  try {
    const result = await engine.query(workflowId, queryName);
    return jsonResponse({ result: result ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not supported')) {
      return errorResponse(message, 501);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Resume route — engine.resume()
// ---------------------------------------------------------------------------

async function handleResumeWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    const handle = await engine.resume(workflowId);
    return jsonResponse({ id: handle.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    if (message.includes('Cannot resume')) {
      return errorResponse(message, 409);
    }
    return errorResponse(message, 500);
  }
}

async function handleForkWorkflow(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  let options: ForkOptions | undefined;
  const rawBody = await request.text();

  if (rawBody.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse('Request body must be a JSON object', 400);
    }

    const record = body as Record<string, unknown>;
    if (record['fromStep'] !== undefined) {
      const fromStep = record['fromStep'];
      if (typeof fromStep !== 'number' || !Number.isSafeInteger(fromStep) || fromStep < 0) {
        return errorResponse('Field "fromStep" must be a non-negative safe integer', 400);
      }
      options = { fromStep };
    }
  }

  try {
    const handle = await engine.fork(workflowId, options);
    return jsonResponse({ id: handle.id }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('fromStep') || message.includes('Checkpoint not found at step')) {
      return errorResponse(message, 400);
    }

    if (message.includes('Checkpoint not found')) {
      return errorResponse(message, 404);
    }

    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }

    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Recover all route — engine.recoverAll()
// ---------------------------------------------------------------------------

async function handleRecoverAll(engine: Engine): Promise<Response> {
  const handles = await engine.recoverAll();
  const recovered: string[] = [];
  for (const handle of handles) {
    recovered.push(handle.id);
  }
  return jsonResponse({ recovered });
}

// ---------------------------------------------------------------------------
// Timeout route — engine.timeout()
// ---------------------------------------------------------------------------

async function handleTimeoutWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    await engine.timeout(workflowId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Budget policy route — engine.setBudgetPolicy()
// ---------------------------------------------------------------------------

async function handleSetBudgetPolicy(request: Request, engine: Engine): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  const { namespace, daily, monthly } = body as Record<string, unknown>;

  if (typeof namespace !== 'string' || namespace.length === 0) {
    return errorResponse('Missing required field: namespace', 400);
  }

  const options: BudgetPolicyOptions = { namespace };
  if (daily !== undefined && typeof daily === 'object' && daily !== null) {
    options.daily = daily as { maxCost: number };
  }
  if (monthly !== undefined && typeof monthly === 'object' && monthly !== null) {
    options.monthly = monthly as { maxCost: number };
  }

  try {
    await engine.setBudgetPolicy(options);
    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Budget policy read route — engine.getBudgetPolicy()
// ---------------------------------------------------------------------------

async function handleGetBudgetPolicy(engine: Engine, namespace: string): Promise<Response> {
  const policy = await engine.getBudgetPolicy(namespace);
  if (policy === null) {
    return errorResponse(`Budget policy for namespace "${namespace}" not found`, 404);
  }
  return jsonResponse(policy);
}

async function handleGetTenantQuota(
  engine: Engine,
  tenantId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  const normalizedTenantId = tenantId.trim();
  if (normalizedTenantId.length === 0) {
    return errorResponse('Tenant id must be a non-empty string', 400);
  }

  if (authContext?.method === 'jwt') {
    const authenticatedTenantId = getAuthenticatedTenantId(authContext.claims);
    if (authenticatedTenantId === null) {
      return errorResponse(
        'JWT-authenticated tenant quota requests require a tenantId, tenant_id, or tenant claim',
        403,
      );
    }
    if (authenticatedTenantId !== normalizedTenantId) {
      return errorResponse('Tenant quota access is limited to the authenticated tenant', 403);
    }
  }

  return jsonResponse(await engine.getQuotaUsage(normalizedTenantId));
}

// ---------------------------------------------------------------------------
// Stream chunks route — engine.getStreamChunks()
// ---------------------------------------------------------------------------

async function handleGetStreamChunks(
  request: Request,
  engine: Engine,
  workflowId: string,
  key: string,
): Promise<Response> {
  const after = parseAfterQueryParameter(request);
  if (after instanceof Response) {
    return after;
  }

  const chunks =
    after !== undefined
      ? await engine.getStreamChunks(workflowId, key, { after })
      : await engine.getStreamChunks(workflowId, key);

  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('text/event-stream')) {
    return new Response(
      createStoredChunkSSEStream(chunks, (chunk) =>
        JSON.stringify({ sequence: chunk.sequence, value: chunk.value }),
      ),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      },
    );
  }

  return jsonResponse({ chunks });
}

// ---------------------------------------------------------------------------
// SSE streaming route
// ---------------------------------------------------------------------------

async function handleStreamSSE(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('text/event-stream')) {
    return errorResponse('Accept header must include text/event-stream', 406);
  }

  // Check workflow exists
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const after = parseLastEventIdHeader(request);
  if (after instanceof Response) {
    return after;
  }

  const chunks =
    after !== undefined
      ? await engine.getStreamChunks(workflowId, 'tokens', { after })
      : await engine.getStreamChunks(workflowId, 'tokens');

  const sseStream = createStoredChunkSSEStream(chunks, (chunk) => {
    if (typeof chunk.value === 'string') {
      return chunk.value;
    }

    if (
      typeof chunk.value === 'object' &&
      chunk.value !== null &&
      'token' in chunk.value &&
      typeof chunk.value['token'] === 'string' &&
      chunk.value['token'].length > 0
    ) {
      return chunk.value['token'];
    }

    return null;
  });

  return new Response(sseStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// ---------------------------------------------------------------------------
// Checkpoint history routes
// ---------------------------------------------------------------------------

async function handleListCheckpoints(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  const summaries = await engine.listCheckpoints(workflowId);
  return negotiatedResponse(request, summaries);
}

async function handleGetCheckpointAt(
  request: Request,
  engine: Engine,
  workflowId: string,
  stepParam: string,
): Promise<Response> {
  const step = Number(stepParam);
  if (!Number.isSafeInteger(step) || step < 0) {
    return errorResponse(`Invalid step: ${stepParam}`, 400);
  }
  const state = await engine.getCheckpointAt(workflowId, step);
  if (!state) {
    return errorResponse(`Checkpoint not found at step ${step} for workflow ${workflowId}`, 404);
  }

  return negotiatedResponse(request, state);
}

async function handleGetTimeline(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const timeline = await engine.getTimeline(workflowId);
  return negotiatedResponse(request, timeline);
}

async function handleReplayWorkflowToStep(
  request: Request,
  engine: Engine,
  workflowId: string,
  stepParam: string,
): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const step = Number(stepParam);
  if (!Number.isSafeInteger(step) || step < 0) {
    return errorResponse(`Invalid step: ${stepParam}`, 400);
  }

  const replay = await engine.replayTo(workflowId, step);
  if (replay === null) {
    return errorResponse(`Replay not found at step ${step} for workflow ${workflowId}`, 404);
  }

  return negotiatedResponse(request, replay);
}

// ---------------------------------------------------------------------------
// Metrics route
// ---------------------------------------------------------------------------

async function handleGetMetrics(
  prometheusExporter: PrometheusExporter | undefined,
  metricsCollector: MetricsCollector | undefined,
): Promise<Response> {
  const exporter = prometheusExporter ?? createMetricsCollectorExporter(metricsCollector);
  let body: string;
  try {
    body = await exporter.serialize();
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

type RouteParameterGetter = (name: string) => string;

type RouteExecutionContext = {
  request: Request;
  engine: Engine;
  options: HandlerOptions | undefined;
  param: RouteParameterGetter;
};

type RouteExecutor = (context: RouteExecutionContext) => Promise<Response>;

const ROUTE_EXECUTORS: Record<HandlerName, RouteExecutor> = {
  healthCheck: async ({ request }) => negotiatedResponse(request, { status: 'ok' }),
  startWorkflow: async ({ request, engine }) => handleStartWorkflow(request, engine),
  purgeWorkflows: async ({ request, engine }) => handlePurgeWorkflows(request, engine),
  listWorkflows: async ({ request, engine }) => handleListWorkflows(request, engine),
  bulkCancelWorkflows: async ({ request, engine }) => handleBulkCancelWorkflows(request, engine),
  bulkSignalWorkflows: async ({ request, engine }) => handleBulkSignalWorkflows(request, engine),
  bulkDeleteWorkflows: async ({ request, engine }) => handleBulkDeleteWorkflows(request, engine),
  bulkMutateWorkflowTags: async ({ request, engine }) =>
    handleBulkMutateWorkflowTags(request, engine),
  recoverAll: async ({ engine }) => handleRecoverAll(engine),
  getRetentionOverview: async ({ engine }) => handleGetRetentionOverview(engine),
  listSchedules: async ({ request, engine, options }) =>
    handleListSchedules(request, engine, options?.authContext),
  createSchedule: async ({ request, engine, options }) =>
    handleCreateSchedule(request, engine, options?.authContext),
  getSchedule: async ({ engine, options, param }) =>
    handleGetSchedule(engine, param('id'), options?.authContext),
  updateSchedule: async ({ request, engine, options, param }) =>
    handleUpdateSchedule(request, engine, param('id'), options?.authContext),
  cancelSchedule: async ({ engine, options, param }) =>
    handleCancelSchedule(engine, param('id'), options?.authContext),
  pauseSchedule: async ({ engine, options, param }) =>
    handlePauseSchedule(engine, param('id'), options?.authContext),
  resumeSchedule: async ({ engine, options, param }) =>
    handleResumeSchedule(engine, param('id'), options?.authContext),
  setBudgetPolicy: async ({ request, engine }) => handleSetBudgetPolicy(request, engine),
  getBudgetPolicy: async ({ engine, param }) => handleGetBudgetPolicy(engine, param('namespace')),
  getTenantQuota: async ({ engine, options, param }) =>
    handleGetTenantQuota(engine, param('id'), options?.authContext),
  getStreamChunks: async ({ request, engine, param }) =>
    handleGetStreamChunks(request, engine, param('id'), param('key')),
  queryWorkflow: async ({ engine, param }) =>
    handleQueryWorkflow(engine, param('id'), param('name')),
  resumeWorkflow: async ({ engine, param }) => handleResumeWorkflow(engine, param('id')),
  forkWorkflow: async ({ request, engine, param }) =>
    handleForkWorkflow(request, engine, param('id')),
  timeoutWorkflow: async ({ engine, param }) => handleTimeoutWorkflow(engine, param('id')),
  getWorkflowResult: async ({ engine, param }) => handleGetWorkflowResult(engine, param('id')),
  signalWorkflow: async ({ request, engine, param }) =>
    handleSignalWorkflow(request, engine, param('id'), param('name')),
  updateWorkflow: async ({ request, engine, param }) =>
    handleUpdateWorkflow(request, engine, param('id'), param('name')),
  getUpdateResult: async ({ engine, param }) => handleGetUpdateResult(engine, param('updateId')),
  getAttributes: async ({ engine, param }) => handleGetAttributes(engine, param('id')),
  setAttributes: async ({ request, engine, param }) =>
    handleSetAttributes(request, engine, param('id')),
  addWorkflowTags: async ({ request, engine, param }) =>
    handleAddWorkflowTags(request, engine, param('id')),
  removeWorkflowTags: async ({ request, engine, param }) =>
    handleRemoveWorkflowTags(request, engine, param('id')),
  getMetrics: async ({ options }) =>
    handleGetMetrics(options?.prometheusExporter, options?.metricsCollector),
  getWorkflowEvents: async ({ engine, param }) => handleGetWorkflowEvents(engine, param('id')),
  listReviews: async ({ engine }) => handleListReviews(engine),
  submitReviewDecision: async ({ request, engine, param }) =>
    handleSubmitReviewDecision(request, engine, param('reviewId')),
  getReview: async ({ engine, param }) => handleGetReview(engine, param('id'), param('reviewId')),
  streamSSE: async ({ request, engine, param }) => handleStreamSSE(request, engine, param('id')),
  listCheckpoints: async ({ request, engine, param }) =>
    handleListCheckpoints(request, engine, param('id')),
  getCheckpointAt: async ({ request, engine, param }) =>
    handleGetCheckpointAt(request, engine, param('id'), param('step')),
  getTimeline: async ({ request, engine, param }) =>
    handleGetTimeline(request, engine, param('id')),
  replayWorkflowToStep: async ({ request, engine, param }) =>
    handleReplayWorkflowToStep(request, engine, param('id'), param('step')),
  getWorkflow: async ({ engine, param }) => handleGetWorkflow(engine, param('id')),
  cancelWorkflow: async ({ engine, param }) => handleCancelWorkflow(engine, param('id')),
  openApiDocument: async () => jsonResponse(generateOpenApiDocument()),
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface HandlerOptions {
  /**
   * Optional authenticated caller context injected by the HTTP server
   * wrapper. See `AuthContext` in `authentication.ts` for field docs.
   */
  authContext?: AuthContext;
  /**
   * Optional {@link PrometheusExporter} used to produce the body of
   * `/v1/metrics`. When set, it takes precedence over `metricsCollector` —
   * this is the recommended plug point for projects that source metrics from
   * the OpenTelemetry SDK (e.g. via `@opentelemetry/exporter-prometheus`).
   */
  prometheusExporter?: PrometheusExporter;
  /**
   * Optional metrics collector for the /v1/metrics endpoint. Used when no
   * `prometheusExporter` is provided.
   *
   * @deprecated Prefer `prometheusExporter` — wrap your metrics source (OTel
   * or otherwise) in a {@link PrometheusExporter} and pass it there. This
   * field remains for projects still using the legacy `MetricsCollector`
   * path and has lower precedence if both are set.
   */
  metricsCollector?: MetricsCollector;
  /**
   * Per-operation REST dispatch-mode config. Controls whether each
   * operation's REST mount runs through the legacy `handleXxx`
   * executor or through the `executeOperation` pipeline.
   */
  restDispatchMode?: RestDispatchModeConfig;
  /** Optional operation registry. Required when `restDispatchMode` resolves to 'via-execute-operation' for any route. */
  operationRegistry?: OperationRegistry;
  /** Optional list of REST bindings. Required when the registry is passed — the router matches against these first. */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
}

/**
 * Find a REST binding that matches the request's method and path.
 * Returns null if no binding matches (caller falls back to legacy
 * dispatch). Delegates path resolution to the canonical
 * `bindingPathMatches` helper — single source of truth for
 * segment-and-param matching across router and OpenAPI generator.
 */
function matchRestBinding(
  method: string,
  pathname: string,
  bindings: ReadonlyArray<UnknownRestBinding> | undefined,
): { readonly binding: UnknownRestBinding; readonly pathParams: Record<string, string> } | null {
  if (bindings === undefined) return null;
  for (const binding of bindings) {
    if (binding.method !== method) continue;
    const params = bindingPathMatches(binding.path, pathname);
    if (params !== null) return { binding, pathParams: params };
  }
  return null;
}

/**
 * Dispatch a request through the `executeOperation` pipeline using a
 * matched `RestBinding`. Returns the shaped response (via
 * `shapeSuccess` / `shapeFault` overrides, or defaults).
 */
async function dispatchViaExecuteOperation(
  request: Request,
  engine: Engine,
  binding: UnknownRestBinding,
  pathParams: Record<string, string>,
  registry: OperationRegistry,
  principal: Principal,
): Promise<Response> {
  let input: unknown;
  try {
    input = await binding.extractInput(request, pathParams);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }
  const result = await executeOperation(binding.operationName, input, {
    principal,
    engine,
    transport: 'http-rest',
    registry,
  });
  if (result.ok) {
    return binding.shapeSuccess
      ? binding.shapeSuccess(result.value)
      : defaultShapeSuccess(result.value, binding.success);
  }
  return binding.shapeFault ? binding.shapeFault(result.fault) : faultToHttpResponse(result.fault);
}

/**
 * Convert the REST transport's `authContext` into a `Principal`. The
 * authenticator (`serve()`) only reports method + optional claims; this
 * shim bridges that into the richer `Principal` the pipeline expects.
 * Returns `anonymousPrincipal()` when no context is provided (public
 * request).
 *
 * JWT: claims → `principalFromJwtClaims` (scope/tenant extraction).
 *   JWT without claims is an authenticator contract violation — the
 *   production authenticator always populates claims, and silently
 *   degrading to anonymous here would let a caller with `authContext:
 *   { method: 'jwt' }` (no claims) bypass `optionalAuth` scope checks
 *   by appearing unauthenticated. We throw instead so the bug surfaces
 *   loudly rather than as a silent security downgrade.
 * API key / mTLS: identity details are not carried on `authContext`
 * yet — this shim produces a minimal authenticated principal with no
 * scopes. Milestone 2 expands authContext to carry full principal info;
 * until then, scope-protected REST ops run on legacy dispatch per the
 * per-operation restDispatchMode flag.
 */
function authContextToPrincipal(authContext: AuthenticatedRequestContext | undefined): Principal {
  if (authContext === undefined) return anonymousPrincipal();
  // Forwarded principal from the authenticator (e.g. from
  // `resolveApiKeyPrincipal` or static api-key admission with
  // `defaultApiKeyScopes`) takes precedence over method-based
  // reconstruction.
  if (authContext.principal !== undefined) return authContext.principal;
  switch (authContext.method) {
    case 'jwt': {
      if (authContext.claims === undefined) {
        throw new Error(
          'authContextToPrincipal: jwt authContext reached the pipeline without claims — ' +
            'authenticator contract violation',
        );
      }
      return principalFromJwtClaims(authContext.claims);
    }
    case 'api-key':
      return principalFromApiKey({ subject: 'api-key-caller', scopes: [] });
    case 'mtls':
      return principalFromMutualTls({ subject: 'mtls-caller', scopes: [] });
    case 'public':
      // serve() short-circuits public requests before reaching here; if
      // a direct caller still passes method: 'public', treat as anonymous.
      return anonymousPrincipal();
  }
}

function defaultShapeSuccess(value: unknown, shape: UnknownRestBinding['success']): Response {
  if (shape.kind === 'empty') return new Response(null, { status: shape.status });
  if (shape.kind === 'streaming') {
    // Streaming responses must supply their own `shapeSuccess` — a
    // default here would bundle the async iterable into a JSON body
    // and silently break SSE/binary output. Fail loudly instead.
    throw new Error('streaming RestBinding must provide shapeSuccess');
  }
  return jsonResponse(value, shape.status);
}

/** Pure HTTP request handler. Maps Request to Response. */
export async function handleRequest(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);

  // Try the `RestBinding` path first when bindings + registry are
  // configured. A binding whose operation resolves to 'legacy' falls
  // through to the legacy route matcher below.
  const bindingMatch = matchRestBinding(request.method, url.pathname, options?.restBindings);
  if (bindingMatch !== null && options?.operationRegistry !== undefined) {
    const mode = resolveRestDispatchMode(
      options.restDispatchMode,
      bindingMatch.binding.operationName,
    );
    if (mode === 'via-execute-operation') {
      try {
        return await dispatchViaExecuteOperation(
          request,
          engine,
          bindingMatch.binding,
          bindingMatch.pathParams,
          options.operationRegistry,
          authContextToPrincipal(options.authContext),
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
  }

  let route: RouteMatch | null;
  try {
    route = matchRoute(request.method, url.pathname);
  } catch (error) {
    if (error instanceof MalformedRouteParameterError) {
      return errorResponse(error.message, 400);
    }
    throw error;
  }

  if (route === null) {
    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }

  const routeDescription = `${request.method} ${url.pathname}`;
  const param = (name: string): string =>
    getRequiredRouteParameter(route.params, name, routeDescription);

  try {
    const executor = ROUTE_EXECUTORS[route.handler];
    return await executor({ request, engine, options, param });
  } catch (error) {
    console.error('Unhandled error in handleRequest', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}
