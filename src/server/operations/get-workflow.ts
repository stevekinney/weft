/**
 * Phase 15c — `weft.workflows.get` operation + REST binding.
 *
 * First REST operation migrated to the transport-neutral
 * `OperationDefinition` / `RestBinding` pair. Dispatch through
 * `executeOperation` is selected per request by the per-operation
 * `restDispatchMode` flag in `ServeOptions`.
 *
 * Legacy behavior — the `handleGetWorkflow` executor in `handler.ts` —
 * is preserved byte-for-byte while this operation runs behind a flag.
 * The legacy error body is `{ "error": "Workflow \"X\" not found" }`
 * (a bare string), different from the canonical fault shape
 * `{ error: { code, message, data? } }`. `shapeFault` below
 * reconstructs the legacy shape so the parity diff test passes.
 *
 * Milestone 2 will drop the `shapeFault` override and align this
 * endpoint to the canonical shape alongside the rest of Track 8.
 *
 * @module server/operations/get-workflow
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowState } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getWorkflowInput = z.object({
  workflowId: z.string().min(1),
});

/**
 * Output schema is the `WorkflowState` shape (kept loose as
 * `z.unknown()` — the state comes from the engine and is already
 * typed there, so we don't re-validate structure at the operation
 * boundary).
 */
const getWorkflowOutput = z.unknown();

export type GetWorkflowInput = z.infer<typeof getWorkflowInput>;
export type GetWorkflowOutput = WorkflowState;

export const getWorkflowOperation = defineOperation<GetWorkflowInput, GetWorkflowOutput>({
  name: 'weft.workflows.get',
  summary: 'Get workflow state by id',
  tags: ['Workflows'],
  inputSchema: getWorkflowInput,
  outputSchema: getWorkflowOutput as z.ZodType<GetWorkflowOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  // REST mirrors legacy behavior (legacy silently tolerates extra top-
  // level keys on GET — there's no body to reject). Top-level strip
  // applies to the path-param + query-string derived input.
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<WorkflowState> => {
    const e = engine as Engine;
    const state = await e.get(input.workflowId);
    if (state === null) {
      // Throw a fully-shaped `OperationFault` — `classifyEngineError`
      // recognizes it via `isOperationFault` and passes it through
      // untouched, preserving the legacy error message verbatim.
      const notFoundFault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw notFoundFault;
    }
    return state;
  },
});

/**
 * Shape a successful `weft.workflows.get` result as a 200 with the
 * serialized state. Content-Type matches legacy exactly:
 * `application/json` (no charset parameter).
 */
function shapeGetWorkflowSuccess(state: WorkflowState): Response {
  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Legacy-matching fault mapper. The only fault this operation emits
 * under normal conditions is `NotFound`; other codes fall through
 * to a generic `{ error: <message> }` shape at the matching HTTP
 * status.
 */
function shapeGetWorkflowFault(fault: OperationFault): Response {
  if (fault.code === 'EngineFailure') {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: fault.message }), {
    status: faultStatusForLegacy(fault.code),
    headers: { 'Content-Type': 'application/json' },
  });
}

function faultStatusForLegacy(code: OperationFault['code']): number {
  switch (code) {
    case 'NotFound':
      return 404;
    case 'Unauthorized':
      return 401;
    case 'Forbidden':
      return 403;
    case 'InvalidParams':
      return 400;
    case 'Conflict':
      return 409;
    case 'Unprocessable':
      return 422;
    case 'Timeout':
      return 408;
    case 'RateLimited':
      return 429;
    case 'NotImplemented':
      return 501;
    case 'UnsupportedTransport':
      return 501;
    case 'SubscriptionOverflow':
      return 500;
    case 'MethodNotFound':
      return 404;
    case 'EngineFailure':
      return 500;
  }
}

/**
 * RestBinding for `GET /v1/workflows/:id`. Pulls the workflow id from
 * the path param, invokes the operation, maps success/fault to the
 * legacy REST response shape.
 *
 * Typed as `UnknownRestBinding` at the module boundary so the router's
 * heterogeneous `ReadonlyArray<UnknownRestBinding>` storage doesn't
 * run into `exactOptionalPropertyTypes` contravariance on
 * `shapeSuccess`. The concrete `GetWorkflowOutput` typing remains at
 * the `shapeGetWorkflowSuccess` function signature above — that's
 * where real type checking matters (did the output come out wrong?).
 * The router itself only sees a shape-uniform `RestBinding<any, any>`.
 */
export const getWorkflowRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output) => shapeGetWorkflowSuccess(output as WorkflowState),
  shapeFault: shapeGetWorkflowFault,
};
