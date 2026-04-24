/**
 * Shared route definitions for the workflow REST API.
 *
 * Both `handleRequest()` and the OpenAPI generator consume this model,
 * ensuring the handler and the API documentation always agree.
 *
 * @module server/route-model
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HTTP method for a route. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A single REST API route definition. */
export type RouteDefinition = {
  /** HTTP method. */
  method: HttpMethod;
  /**
   * Express-style path pattern (e.g. `/v1/workflows/:id/signal/:name`).
   * Used to generate OpenAPI path items and regex patterns.
   */
  path: string;
  /** Internal handler function name. */
  handler: string;
  /** Ordered list of path parameter names. */
  paramNames: string[];
  /** Human-readable summary for OpenAPI. */
  summary: string;
  /** OpenAPI tags for grouping. */
  tags: string[];
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * All REST API routes. Each entry is the single source of truth for the
 * route's method, path, parameters, and documentation.
 *
 * `as const` preserves the literal types of `handler` so consumers can
 * derive a string-literal union (see `HandlerName` in handler.ts) for
 * compile-time exhaustiveness on route executors.
 */
export const ROUTES = [
  {
    method: 'GET',
    path: '/v1/health',
    handler: 'healthCheck',
    paramNames: [],
    summary: 'Health check',
    tags: ['System'],
  },
  {
    method: 'POST',
    path: '/v1/workflows',
    handler: 'startWorkflow',
    paramNames: [],
    summary: 'Start a new workflow',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/purge',
    handler: 'purgeWorkflows',
    paramNames: [],
    summary: 'Purge terminal workflows',
    tags: ['Workflows'],
  },
  {
    method: 'GET',
    path: '/v1/workflows',
    handler: 'listWorkflows',
    paramNames: [],
    summary: 'List workflows',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/bulk/cancel',
    handler: 'bulkCancelWorkflows',
    paramNames: [],
    summary: 'Cancel workflows in bulk',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/bulk/signal',
    handler: 'bulkSignalWorkflows',
    paramNames: [],
    summary: 'Signal workflows in bulk',
    tags: ['Workflows'],
  },
  {
    method: 'DELETE',
    path: '/v1/workflows/bulk',
    handler: 'bulkDeleteWorkflows',
    paramNames: [],
    summary: 'Delete terminal workflows in bulk',
    tags: ['Workflows'],
  },
  {
    method: 'PATCH',
    path: '/v1/workflows/bulk/tags',
    handler: 'bulkMutateWorkflowTags',
    paramNames: [],
    summary: 'Add or remove workflow tags in bulk',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/recover',
    handler: 'recoverAll',
    paramNames: [],
    summary: 'Recover all interrupted workflows',
    tags: ['System'],
  },
  {
    method: 'GET',
    path: '/v1/retention',
    handler: 'getRetentionOverview',
    paramNames: [],
    summary: 'Get retention policy overview',
    tags: ['System'],
  },
  {
    method: 'GET',
    path: '/v1/schedules',
    handler: 'listSchedules',
    paramNames: [],
    summary: 'List recurring schedules',
    tags: ['Schedules'],
  },
  {
    method: 'POST',
    path: '/v1/schedules',
    handler: 'createSchedule',
    paramNames: [],
    summary: 'Create a recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'GET',
    path: '/v1/schedules/:id',
    handler: 'getSchedule',
    paramNames: ['id'],
    summary: 'Get one recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'PATCH',
    path: '/v1/schedules/:id',
    handler: 'updateSchedule',
    paramNames: ['id'],
    summary: 'Update a recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'DELETE',
    path: '/v1/schedules/:id',
    handler: 'cancelSchedule',
    paramNames: ['id'],
    summary: 'Cancel a recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'POST',
    path: '/v1/schedules/:id/pause',
    handler: 'pauseSchedule',
    paramNames: ['id'],
    summary: 'Pause a recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'POST',
    path: '/v1/schedules/:id/resume',
    handler: 'resumeSchedule',
    paramNames: ['id'],
    summary: 'Resume a recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'PUT',
    path: '/v1/budget-policy',
    handler: 'setBudgetPolicy',
    paramNames: [],
    summary: 'Set organization-level budget policy',
    tags: ['Budget'],
  },
  {
    method: 'GET',
    path: '/v1/budget-policy/:namespace',
    handler: 'getBudgetPolicy',
    paramNames: ['namespace'],
    summary: 'Get budget policy for a namespace',
    tags: ['Budget'],
  },
  {
    method: 'GET',
    path: '/v1/tenants/:id/quota',
    handler: 'getTenantQuota',
    paramNames: ['id'],
    summary: 'Get quota usage for a tenant',
    tags: ['Budget'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/streams/:key',
    handler: 'getStreamChunks',
    paramNames: ['id', 'key'],
    summary: 'Get stream chunks for a workflow',
    tags: ['Streams'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/query/:name',
    handler: 'queryWorkflow',
    paramNames: ['id', 'name'],
    summary: 'Query a workflow',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/:id/resume',
    handler: 'resumeWorkflow',
    paramNames: ['id'],
    summary: 'Resume a suspended workflow',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/:id/fork',
    handler: 'forkWorkflow',
    paramNames: ['id'],
    summary: 'Fork a workflow from its latest or a historical checkpoint',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/:id/timeout',
    handler: 'timeoutWorkflow',
    paramNames: ['id'],
    summary: 'Force-timeout a workflow',
    tags: ['Workflows'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/result',
    handler: 'getWorkflowResult',
    paramNames: ['id'],
    summary: 'Get the result of a completed workflow',
    tags: ['Workflows'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/:id/signal/:name',
    handler: 'signalWorkflow',
    paramNames: ['id', 'name'],
    summary: 'Send a signal to a workflow',
    tags: ['Signals'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/:id/update/:name',
    handler: 'updateWorkflow',
    paramNames: ['id', 'name'],
    summary: 'Send a synchronous update to a workflow',
    tags: ['Updates'],
  },
  {
    method: 'GET',
    path: '/v1/updates/:updateId',
    handler: 'getUpdateResult',
    paramNames: ['updateId'],
    summary: 'Get the result of an update request',
    tags: ['Updates'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/attributes',
    handler: 'getAttributes',
    paramNames: ['id'],
    summary: 'Get search attributes for a workflow',
    tags: ['Attributes'],
  },
  {
    method: 'PATCH',
    path: '/v1/workflows/:id/attributes',
    handler: 'setAttributes',
    paramNames: ['id'],
    summary: 'Update search attributes for a workflow',
    tags: ['Attributes'],
  },
  {
    method: 'POST',
    path: '/v1/workflows/:id/tags',
    handler: 'addWorkflowTags',
    paramNames: ['id'],
    summary: 'Add workflow tags',
    tags: ['Tags'],
  },
  {
    method: 'DELETE',
    path: '/v1/workflows/:id/tags',
    handler: 'removeWorkflowTags',
    paramNames: ['id'],
    summary: 'Remove workflow tags',
    tags: ['Tags'],
  },
  {
    method: 'GET',
    path: '/v1/metrics',
    handler: 'getMetrics',
    paramNames: [],
    summary: 'Prometheus metrics export',
    tags: ['Observability'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/events',
    handler: 'getWorkflowEvents',
    paramNames: ['id'],
    summary: 'Get event log for a workflow',
    tags: ['Events'],
  },
  {
    method: 'GET',
    path: '/v1/reviews',
    handler: 'listReviews',
    paramNames: [],
    summary: 'List pending human review requests',
    tags: ['Reviews'],
  },
  {
    method: 'POST',
    path: '/v1/reviews/:reviewId/decision',
    handler: 'submitReviewDecision',
    paramNames: ['reviewId'],
    summary: 'Submit a decision for a human review',
    tags: ['Reviews'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/review/:reviewId',
    handler: 'getReview',
    paramNames: ['id', 'reviewId'],
    summary: 'Get a specific review for a workflow',
    tags: ['Reviews'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/sse',
    handler: 'streamSSE',
    paramNames: ['id'],
    summary: 'Stream workflow events via Server-Sent Events',
    tags: ['Streams'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/checkpoints',
    handler: 'listCheckpoints',
    paramNames: ['id'],
    summary: 'List checkpoint history for a workflow',
    tags: ['Checkpoints'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/checkpoints/:step',
    handler: 'getCheckpointAt',
    paramNames: ['id', 'step'],
    summary: 'Get a specific checkpoint by step number',
    tags: ['Checkpoints'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/timeline',
    handler: 'getTimeline',
    paramNames: ['id'],
    summary: 'Get the structured execution timeline for a workflow',
    tags: ['Checkpoints'],
  },
  {
    method: 'GET',
    path: '/v1/workflows/:id/replay/:step',
    handler: 'replayWorkflowToStep',
    paramNames: ['id', 'step'],
    summary: 'Replay a workflow to a historical checkpoint step',
    tags: ['Checkpoints'],
  },
  {
    method: 'DELETE',
    path: '/v1/workflows/:id',
    handler: 'cancelWorkflow',
    paramNames: ['id'],
    summary: 'Cancel a running workflow',
    tags: ['Workflows'],
  },
  {
    method: 'GET',
    path: '/openapi.json',
    handler: 'openApiDocument',
    paramNames: [],
    summary: 'OpenAPI 3.1 specification',
    tags: ['System'],
  },
] as const satisfies readonly RouteDefinition[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an Express-style path to an OpenAPI path template.
 * `/v1/workflows/:id/signal/:name` → `/v1/workflows/{id}/signal/{name}`
 */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/** Escape regex metacharacters in a literal path segment. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert an Express-style path to a regex pattern for route matching.
 *
 * Each segment is either a literal (with regex metacharacters escaped) or a
 * parameter placeholder:
 * - `:step` becomes `(\\d+)` for numeric-only matching (checkpoint routes)
 * - `:name` becomes `([^/]+)` for any non-slash token
 *
 * Escaping the literal segments prevents characters like `.` in paths such as
 * `/openapi.json` from being treated as wildcards (which would match
 * `/openapiXjson`).
 */
export function toRegex(path: string): RegExp {
  const regexStr = path
    .split('/')
    .map((segment) => {
      if (segment === ':step') return '(\\d+)';
      if (segment.startsWith(':')) return '([^/]+)';
      return escapeRegexLiteral(segment);
    })
    .join('/');
  return new RegExp(`^${regexStr}$`);
}
