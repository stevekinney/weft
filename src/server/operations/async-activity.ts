import { z } from 'zod';

import { AsyncActivityTokenNotFoundError, type Engine } from '../../core/engine.ts';
import { PayloadSizeExceededError } from '../../core/payload-size.ts';
import type { AccessPolicy } from '../authorization.ts';
import { raiseFault } from '../operation-catalog.ts';
import type { FaultCode } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

/**
 * Async ("out-of-band") activity completion, exposed across every transport.
 *
 * An activity that called `ActivityContext.completeAsync()` parks its workflow
 * until an external system resolves it by durable task token. The two operations
 * here surface that resolution over the operation catalog (REST + JSON-RPC), so
 * a webhook handler or callback dispatcher can complete the activity without an
 * in-process {@link Engine} reference.
 *
 * Security posture: the access policy is `public`, identical to and no broader
 * than the already-shipped `weft.workflows.signal` operation. The task token is
 * a *deterministic identifier* (`async-act:v1:<workflowId>:<step>:<attempt>`),
 * not a secret capability — it is intentionally derivable so a crashed-and-
 * recovered workflow re-mints the same token. Exposure therefore matches the
 * existing signal/cancel/update endpoints and is gated by the same auth layer
 * (`evaluateAccess`), not by token entropy. See `.audit/pr4-design-decision.md`.
 *
 * The token travels in the request body, never the URL path: tokens embed the
 * workflow id and `:` separators, which have no business in a route.
 *
 * @module server/operations/async-activity
 */

const asyncActivityAccess: AccessPolicy = { kind: 'public' };

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
  operation: { readonly name: string; readonly producibleFaults?: readonly FaultCode[] },
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
    'single-use).',
  destructive: true,
  tags: ['Activities'],
  inputSchema: completeAsyncActivityInput,
  outputSchema: okOutput,
  access: asyncActivityAccess,
  producibleFaults: ['NotFound'],
  transports: httpAndJsonRpcTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<AsyncActivityOutput> => {
    try {
      await (engine as Engine).completeAsyncActivity(input.token, input.result);
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
    'when the token is unknown or already completed/failed (tokens are single-use).',
  destructive: true,
  tags: ['Activities'],
  inputSchema: failAsyncActivityInput,
  outputSchema: okOutput,
  access: asyncActivityAccess,
  producibleFaults: ['NotFound'],
  transports: httpAndJsonRpcTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<AsyncActivityOutput> => {
    try {
      await (engine as Engine).failAsyncActivity(input.token, errorFromFailInput(input));
    } catch (error) {
      raiseAsyncActivityFault(failAsyncActivityOperation, input.token, error);
    }
    return { ok: true };
  },
});

function shapeAsyncActivitySuccess(output: AsyncActivityOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
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
  extractInput: async (request) => {
    const body = await readJsonObjectBody(request);
    return {
      token: typeof body['token'] === 'string' ? body['token'] : '',
      ...('result' in body ? { result: body['result'] } : {}),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: AsyncActivityOutput) => shapeAsyncActivitySuccess(output),
  shapeFault: shapeRestFault,
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
  extractInput: async (request) => {
    const body = await readJsonObjectBody(request);
    return {
      token: typeof body['token'] === 'string' ? body['token'] : '',
      error: body['error'],
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: AsyncActivityOutput) => shapeAsyncActivitySuccess(output),
  shapeFault: shapeRestFault,
};
