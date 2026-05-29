import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import {
  UpdateTimeoutError,
  UpdateValidationError,
  WorkflowTerminalError,
} from '../../core/updates.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { isOperationFault, shapeRestFault } from './operation-helpers.ts';

const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

// `timeout` and `idempotencyKey` are intentionally `unknown` at the schema
// boundary. REST silently ignores non-number `timeout` and non-string
// `idempotencyKey`, falling back to defaults — Zod cannot reproduce that
// "ignore-and-default" semantic. The same typeof checks live in `invoke()` so
// REST and JSON-RPC callers share one contract.
const updateWorkflowInput = z.object({
  workflowId: z.string().min(1),
  updateName: z.string().min(1),
  payload: z.unknown().optional(),
  timeout: z.unknown().optional(),
  idempotencyKey: z.unknown().optional(),
});

const updateWorkflowOutput = z.object({
  updateId: z.string(),
  result: z.unknown(),
});

export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInput>;
export type UpdateWorkflowOutput = z.infer<typeof updateWorkflowOutput>;

export const updateWorkflowOperation = defineOperation<UpdateWorkflowInput, UpdateWorkflowOutput>({
  name: 'weft.workflows.update',
  mcpExposable: false,
  summary: 'Send a synchronous update to a workflow',
  description:
    'Invoke a named update handler on a workflow and wait for its result. Requires the ' +
    'workflow `id` and the update `name`; `payload` is optional. Unlike signals, updates ' +
    'return the handler result synchronously. Faults with NotFound when the workflow is not ' +
    'visible and InvalidParams when the payload exceeds the size limit.',
  destructive: true,
  tags: ['Updates'],
  inputSchema: updateWorkflowInput,
  outputSchema: updateWorkflowOutput,
  access: { kind: 'public' },
  producibleFaults: ['Unprocessable', 'Timeout'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<UpdateWorkflowOutput> => {
    const typedEngine = engine as Engine;

    // non-number `timeout` and non-string `idempotencyKey` are
    // silently ignored (defaults apply). Validation happens here, not at the
    // schema boundary, so REST and JSON-RPC callers behave identically.
    const timeout = typeof input.timeout === 'number' ? input.timeout : DEFAULT_UPDATE_TIMEOUT_MS;
    const options: { timeout: number; idempotencyKey?: string } = { timeout };
    if (typeof input.idempotencyKey === 'string') {
      options.idempotencyKey = input.idempotencyKey;
    }

    try {
      const result = await typedEngine.submitCoordinatedUpdate(
        input.workflowId,
        input.updateName,
        input.payload,
        options,
      );

      if (result.error !== undefined) {
        const fault: OperationFault = {
          code: 'Unprocessable',
          message: result.error,
          data: { reason: result.error },
        };
        throw fault;
      }

      return {
        updateId: result.updateId,
        result: result.result,
      };
    } catch (error) {
      if (isOperationFault(error)) {
        throw error;
      }
      if (error instanceof UpdateValidationError) {
        const fault: OperationFault = {
          code: 'Unprocessable',
          message: error.message,
          data: { reason: error.message },
        };
        throw fault;
      }
      if (error instanceof WorkflowTerminalError) {
        const fault: OperationFault = {
          code: 'Unprocessable',
          message: error.message,
          data: { reason: error.message },
        };
        throw fault;
      }
      if (error instanceof UpdateTimeoutError) {
        const fault: OperationFault = {
          code: 'Timeout',
          message: error.message,
          data: {},
        };
        throw fault;
      }

      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

export const updateWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/update/:name',
  pathParamNames: ['id', 'name'],
  operationName: 'weft.workflows.update',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    updateName: { kind: 'path', pathParam: 'name' },
    payload: { kind: 'body-field', bodyField: 'payload' },
    timeout: { kind: 'body-field', bodyField: 'timeout' },
    idempotencyKey: { kind: 'body-field', bodyField: 'idempotencyKey' },
  },
  extractInput: async (request, pathParams) => {
    // invalid or absent JSON body is ignored, defaults apply.
    // Field-level typeof checks live in `invoke()` (the single cross-transport
    // validator) — extractInput just reads through.
    let payload: unknown;
    let timeout: unknown;
    let idempotencyKey: unknown;

    try {
      const body = await request.json();
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        payload = record['payload'];
        timeout = record['timeout'];
        idempotencyKey = record['idempotencyKey'];
      }
    } catch {
      // invalid or absent JSON body is ignored.
    }

    return {
      workflowId: pathParams['id'] ?? '',
      updateName: pathParams['name'] ?? '',
      ...(payload !== undefined ? { payload } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRestFault,
};
