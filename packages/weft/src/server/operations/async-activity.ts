import { z } from 'zod';

import { AsyncActivityTokenNotFoundError, type Engine } from '../../core/engine.ts';
import {
  DEFAULT_PENDING_ASYNC_ACTIVITY_LIMIT,
  isPendingAsyncActivityCursor,
  isPendingAsyncActivityCursorForWorkflow,
  MAX_PENDING_ASYNC_ACTIVITY_CURSOR_LENGTH,
  MAX_PENDING_ASYNC_ACTIVITY_LIMIT,
} from '../../core/engine/async-activity-records.ts';
import { PayloadSizeExceededError } from '../../core/payload-size.ts';
import type { PendingAsyncActivityPage } from '../../core/types.ts';
import type { AccessPolicy } from '../authorization.ts';
import { raiseFault } from '../operation-catalog.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { invalidParamsFault, isOperationFault } from './operation-helpers.ts';

/**
 * Async ("out-of-band") activity completion, exposed across every transport.
 *
 * An activity that called `ActivityContext.completeAsync()` parks its workflow
 * until an external system resolves it by durable task token. The two operations
 * here surface that resolution over the operation catalog (REST + JSON-RPC), so
 * a webhook handler or callback dispatcher can complete the activity without an
 * in-process {@link Engine} reference.
 *
 * Security posture: listing requires `workflows:read`; completion and failure
 * require `workflows:write`. The task token is a deterministic identifier
 * (`async-act:v1:<workflowId>:<step>:<attempt>`), not a secret capability — it
 * is intentionally derivable so a recovered workflow re-mints the same token.
 *
 * Because the token is guessable, a caller who can infer a workflow id can forge
 * the *result* or *error* of a parked activity step. This is a sharper trust
 * issue than `signal`: a signal is an external message a workflow author already
 * treats as untrusted input, whereas an activity result is the private
 * continuation of the author's own `ctx.run(...)` and may be trusted blindly.
 * Workflow authors who use `completeAsync()` MUST validate completion payloads
 * as hostile external input — exactly as they would a signal — even after the
 * caller passes the operation's scope check.
 *
 * The token travels in the request body, never the URL path: tokens embed the
 * workflow id and `:` separators, which have no business in a route.
 *
 * Not MCP-exposed (`mcpExposable: false`): an MCP client holds no durable
 * reference to a workflow's async task tokens, so a token-keyed completion tool
 * would be unreachable and confusing in that surface.
 *
 * @module server/operations/async-activity
 */

const asyncActivityReadAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['workflows:read'] },
};
const asyncActivityWriteAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['workflows:write'] },
};

const httpAndJsonRpcTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcStdio: true,
  jsonRpcWebSocket: true,
} as const;

const completeAsyncActivityInput = z.object({
  token: z.string().min(1),
  result: z.unknown().optional(),
});

const pendingAsyncActivityItemSchema = z
  .object({
    token: z.string(),
    operationId: z.string(),
    activityName: z.string(),
    step: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    createdAt: z.number(),
  })
  .strict();

const listPendingAsyncActivitiesInput = z.object({
  workflowId: z.string().min(1),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PENDING_ASYNC_ACTIVITY_LIMIT)
    .default(DEFAULT_PENDING_ASYNC_ACTIVITY_LIMIT),
  cursor: z
    .string()
    .max(MAX_PENDING_ASYNC_ACTIVITY_CURSOR_LENGTH)
    .refine(isPendingAsyncActivityCursor, { message: 'Invalid cursor' })
    .optional(),
});

const listPendingAsyncActivitiesOutput = z
  .object({
    items: z.array(pendingAsyncActivityItemSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

/**
 * The failure payload is a *serializable* error description, not a live `Error`.
 * The engine already reduces an async-activity failure to `message` + `name`
 * before persisting it (`failAsyncActivity`), so nothing is lost by accepting
 * the reduced shape over the wire — and a live `Error` cannot cross a transport
 * boundary anyway.
 */
const failAsyncActivityInput = z.object({
  token: z.string().min(1),
  error: z.object({
    message: z.string(),
    name: z.string().optional(),
  }),
});

const okOutput = z.object({ ok: z.literal(true) });

export type CompleteAsyncActivityInput = z.infer<typeof completeAsyncActivityInput>;
export type FailAsyncActivityInput = z.infer<typeof failAsyncActivityInput>;
export type AsyncActivityOutput = z.infer<typeof okOutput>;
export type ListPendingAsyncActivitiesInput = z.infer<typeof listPendingAsyncActivitiesInput>;
export type ListPendingAsyncActivitiesOutput = PendingAsyncActivityPage;

export const listPendingAsyncActivitiesOperation = defineOperation<
  ListPendingAsyncActivitiesInput,
  ListPendingAsyncActivitiesOutput
>({
  name: 'weft.workflows.activities.pending.list',
  mcpExposable: false,
  summary: 'List pending async activities for a workflow',
  description:
    'Read a bounded, deterministic page of durable activity task tokens awaiting ' +
    'out-of-band completion. The cursor is opaque and scoped to the selected workflow. ' +
    'A listed token may be consumed concurrently, so a later completion can return NotFound.',
  destructive: false,
  tags: ['Activities'],
  inputSchema: listPendingAsyncActivitiesInput,
  outputSchema: listPendingAsyncActivitiesOutput as z.ZodType<ListPendingAsyncActivitiesOutput>,
  access: asyncActivityReadAccess,
  producibleFaults: ['NotFound', 'InvalidParams'],
  transports: httpAndJsonRpcTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListPendingAsyncActivitiesOutput> => {
    const liveEngine = engine as Engine;
    if (
      input.cursor !== undefined &&
      !isPendingAsyncActivityCursorForWorkflow(input.cursor, input.workflowId)
    ) {
      raiseFault(
        listPendingAsyncActivitiesOperation,
        invalidParamsFault('Cursor does not belong to this workflow.'),
      );
    }
    if ((await liveEngine.get(input.workflowId)) === null) {
      raiseFault(listPendingAsyncActivitiesOperation, {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      });
    }
    return liveEngine.listPendingAsyncActivities(input.workflowId, {
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  },
});

/**
 * Reconstruct an `Error` from the serializable failure payload so the engine
 * receives the same `message`/`name` an inline activity failure would carry.
 */
function errorFromFailInput(input: FailAsyncActivityInput): Error {
  const error = new Error(input.error.message);
  if (input.error.name !== undefined) {
    error.name = input.error.name;
  }
  return error;
}

/**
 * Shape an engine error from `completeAsyncActivity`/`failAsyncActivity` into the
 * operation's fault contract, then rethrow. Single-use token misses become
 * `NotFound`; an oversized result (the engine caps async results like inline
 * activity results and signals) becomes `InvalidParams`. Anything else
 * propagates unchanged for the pipeline to mask as `EngineFailure`.
 */
function raiseAsyncActivityFault(
  operation: Parameters<typeof raiseFault>[0],
  token: string,
  error: unknown,
): never {
  if (error instanceof AsyncActivityTokenNotFoundError) {
    raiseFault(operation, {
      code: 'NotFound',
      message: error.message,
      data: { resource: 'async-activity', identifier: token },
    });
  }
  if (error instanceof PayloadSizeExceededError) {
    raiseFault(operation, invalidParamsFault(error.message));
  }
  throw error;
}

export const completeAsyncActivityOperation = defineOperation<
  CompleteAsyncActivityInput,
  AsyncActivityOutput
>({
  name: 'weft.activities.complete',
  mcpExposable: false,
  summary: 'Complete a deferred activity by task token',
  description:
    'Resolve an out-of-band ("async") activity with a result, resuming its parked ' +
    'workflow as though the activity had returned that result inline. Requires the ' +
    'durable task token announced through the `activity:async-pending` event. Faults ' +
    'with NotFound when the token is unknown or already completed/failed (tokens are ' +
    'single-use), and InvalidParams when the result exceeds the payload size limit. ' +
    'A success response is durable — the completion is persisted before the operation ' +
    'returns, and a crash afterward cannot lose it. A failed call leaves the token ' +
    'completable, so treat storage-side faults as retryable.',
  destructive: true,
  tags: ['Activities'],
  inputSchema: completeAsyncActivityInput,
  outputSchema: okOutput,
  access: asyncActivityWriteAccess,
  producibleFaults: ['NotFound', 'InvalidParams'],
  transports: httpAndJsonRpcTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<AsyncActivityOutput> => {
    // `engine` is erased to the catalog engine type so adapters can share the
    // registry; in a live server it is always the concrete Engine. Cast matches
    // every other operation in this directory.
    const liveEngine = engine as Engine;
    try {
      await liveEngine.completeAsyncActivity(input.token, input.result);
    } catch (error) {
      raiseAsyncActivityFault(completeAsyncActivityOperation, input.token, error);
    }
    return { ok: true };
  },
});

export const failAsyncActivityOperation = defineOperation<
  FailAsyncActivityInput,
  AsyncActivityOutput
>({
  name: 'weft.activities.fail',
  mcpExposable: false,
  summary: 'Fail a deferred activity by task token',
  description:
    'Fail an out-of-band ("async") activity, throwing the supplied error into its ' +
    'parked workflow at the deferred step — identical to an inline activity that threw, ' +
    'so the workflow’s own try/catch and retry policy apply unchanged. Requires the ' +
    'durable task token from the `activity:async-pending` event. Faults with NotFound ' +
    'when the token is unknown or already completed/failed (tokens are single-use), and ' +
    'InvalidParams when the failure message exceeds the payload size limit. ' +
    'A success response is durable — the failure outcome is persisted before the ' +
    'operation returns, and a crash afterward cannot lose it. A failed call leaves the ' +
    'token completable, so treat storage-side faults as retryable.',
  destructive: true,
  tags: ['Activities'],
  inputSchema: failAsyncActivityInput,
  outputSchema: okOutput,
  access: asyncActivityWriteAccess,
  producibleFaults: ['NotFound', 'InvalidParams'],
  transports: httpAndJsonRpcTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<AsyncActivityOutput> => {
    // See completeAsyncActivityOperation: erased catalog engine, concrete at runtime.
    const liveEngine = engine as Engine;
    try {
      await liveEngine.failAsyncActivity(input.token, errorFromFailInput(input));
    } catch (error) {
      raiseAsyncActivityFault(failAsyncActivityOperation, input.token, error);
    }
    return { ok: true };
  },
});

export const listPendingAsyncActivitiesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/pending-async-activities',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.activities.pending.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    limit: { kind: 'query', queryParam: 'limit' },
    cursor: { kind: 'query', queryParam: 'cursor' },
  },
  extractInput: async (request, pathParams) => {
    const search = new URL(request.url).searchParams;
    const limit = search.get('limit');
    const cursor = search.get('cursor');
    return {
      workflowId: pathParams['id'] ?? '',
      ...(limit === null ? {} : { limit: Number(limit) }),
      ...(cursor === null ? {} : { cursor }),
    };
  },
  success: { kind: 'json', status: 200 },
};

async function readJsonObjectBody(
  request: Request,
  context: Parameters<UnknownRestBinding['extractInput']>[2],
): Promise<Record<string, unknown>> {
  const body = await readRestJsonBody(request, context).catch((error) => {
    if (isOperationFault(error)) throw error;
    return null;
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidParamsFault('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export const completeAsyncActivityRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/activities/complete',
  pathParamNames: [],
  operationName: 'weft.activities.complete',
  inputSources: {
    token: { kind: 'body-field', bodyField: 'token' },
    result: { kind: 'body-field', bodyField: 'result' },
  },
  extractInput: async (request, _pathParams, context) => {
    // Pass raw body fields through; the operation's Zod schema is the single
    // validator and rejects a missing/non-string token as InvalidParams. (No
    // empty-string coercion — that would invent a value for a required field.)
    const body = await readJsonObjectBody(request, context);
    return {
      token: body['token'],
      ...('result' in body ? { result: body['result'] } : {}),
    };
  },
  success: { kind: 'json', status: 200 },
};

export const failAsyncActivityRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/activities/fail',
  pathParamNames: [],
  operationName: 'weft.activities.fail',
  inputSources: {
    token: { kind: 'body-field', bodyField: 'token' },
    error: { kind: 'body-field', bodyField: 'error' },
  },
  extractInput: async (request, _pathParams, context) => {
    // Raw pass-through; the Zod schema validates both token and the error shape.
    const body = await readJsonObjectBody(request, context);
    return {
      token: body['token'],
      error: body['error'],
    };
  },
  success: { kind: 'json', status: 200 },
};
