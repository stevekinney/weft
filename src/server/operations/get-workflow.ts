/**
 * `weft.workflows.get` operation + REST binding.
 *
 * Returns a workflow's state by id. REST response shape preserves the
 * historical format: 200 with the serialized `WorkflowState`, or a 4xx/5xx
 * with the string `error` plus audited structured `data`, as emitted by
 * `shapeFault` below.
 *
 * @module server/operations/get-workflow
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowState } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const getWorkflowInput = z.object({
  workflowId: z.string().min(1),
});

/**
 * Output schema is intentionally permissive (`z.unknown()`): the state
 * comes from the engine and is already typed at its source via
 * `WorkflowState`. Re-validating the shape here would require mirroring
 * `WorkflowState`'s schema in a second source of truth (drift risk) for
 * no runtime benefit — `invoke` trusts the engine's return value.
 *
 * The cast on `outputSchema` below reattaches the concrete
 * `WorkflowState` type for `defineOperation`'s generic inference.
 */
const getWorkflowOutput = z.unknown();

export type GetWorkflowInput = z.infer<typeof getWorkflowInput>;
export type GetWorkflowOutput = WorkflowState;

export const getWorkflowOperation = defineOperation<GetWorkflowInput, GetWorkflowOutput>({
  name: 'weft.workflows.get',
  mcpExposable: false,
  summary: 'Get workflow state by id',
  description:
    'Read the current state of a single workflow by `id`, including its status, timestamps, ' +
    'tags, and search attributes. Read-only. Faults with NotFound when no workflow with the ' +
    'given id is visible.',
  destructive: false,
  tags: ['Workflows'],
  inputSchema: getWorkflowInput,
  outputSchema: getWorkflowOutput as z.ZodType<GetWorkflowOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  // GET has no body to reject, so REST silently tolerates extra top-
  // level keys. Top-level strip applies to the path-param + query-string
  // derived input.
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<WorkflowState> => {
    // The catalog stores `engine: unknown` so the pipeline is transport-
    // neutral; per `operation-catalog.ts`'s JSDoc the concrete adapter
    // (here: REST via serve()) is responsible for passing an `Engine`.
    const e = engine as Engine;
    const state = await e.get(input.workflowId);
    if (state === null) {
      // Throw a fully-shaped `OperationFault` — `classifyEngineError`
      // recognizes it via `isOperationFault` and passes it through
      // untouched, preserving the error message verbatim.
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
 * serialized state. Content-Type is `application/json` (no charset
 * parameter).
 */
function shapeGetWorkflowSuccess(state: WorkflowState): Response {
  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * RestBinding for `GET /v1/workflows/:id`. Pulls the workflow id from
 * the path param, invokes the operation, maps success/fault to the
 * REST response shape.
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
  // The cast converts the binding-level `any` back to `WorkflowState`
  // for the shaping function below. `UnknownRestBinding` storage is
  // `RestBinding<any, any>`, so `output` here is typed `any`; the cast
  // is a no-op but communicates the concrete shape expected.
  shapeSuccess: (output: WorkflowState) => shapeGetWorkflowSuccess(output),
  // The only fault this operation emits under normal conditions is `NotFound`;
  // the canonical `shapeRestFault` masks `EngineFailure` to a generic 500 and
  // maps other codes to their status via `FAULT_CODE_TO_HTTP_STATUS`.
  shapeFault: shapeRestFault,
};
