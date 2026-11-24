import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import {
  type UnknownRestBinding,
  isOperationFault,
  readRestJsonBody,
} from "../../embedded/backchannel/src/internals.ts";
import {
  UpdateTimeoutError,
  UpdateValidationError,
  WorkflowTerminalError,
} from '../../core/updates.ts';
import { standardSchemaValidationFault } from '../standard-schema-validation-fault.ts';
import { assertOperationEngineMethods, undeclaredMessageFault } from './operation-helpers.ts';

const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

// `timeout` and `idempotencyKey` are intentionally `unknown` at the schema
// boundary. REST silently ignores non-number `timeout` and non-string
// `idempotencyKey`, falling back to defaults — Zod cannot reproduce that
// "ignore-and-default" semantic. The same typeof checks live in `invoke()` so
// REST and JSON-RPC callers share one contract.
const updateWorkflowInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow to send the update to.'),
  updateName: z.string().min(1).describe('Name of the update handler to invoke.'),
  payload: z.unknown().optional().describe('Payload passed to the update handler.'),
  timeout: z
    .unknown()
    .optional()
    .describe('Milliseconds to wait for the update to be answered; defaults to 30000.'),
  idempotencyKey: z
    .unknown()
    .optional()
    .describe(
      "At-most-once key: a repeated key returns the first update's outcome instead of applying the update again.",
    ),
});

const updateWorkflowOutput = z.object({
  updateId: z.string(),
  result: z.unknown(),
});

export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInput>;
export type UpdateWorkflowOutput = z.infer<typeof updateWorkflowOutput>;

/** Map an error from `submitCoordinatedUpdate` to the operation fault the update surfaces. */
function toUpdateWorkflowFault(error: unknown): OperationFault {
  if (isOperationFault(error)) return error;
  const undeclared = undeclaredMessageFault(error);
  if (undeclared !== undefined) return undeclared;
  const schemaFault = standardSchemaValidationFault(error);
  if (schemaFault !== undefined) return schemaFault;
  if (error instanceof UpdateValidationError) {
    const fault: OperationFault = {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.message },
    };
    return fault;
  }
  if (error instanceof WorkflowTerminalError) {
    const fault: OperationFault = {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.message },
    };
    return fault;
  }
  if (error instanceof UpdateTimeoutError) {
    const fault: OperationFault = {
      code: 'Timeout',
      message: error.message,
      data: { updateId: error.updateId },
    };
    return fault;
  }

  const message = error instanceof Error ? error.message : String(error);
  const fault: OperationFault = {
    code: 'EngineFailure',
    message,
    data: {},
  };
  return fault;
}

export const updateWorkflowOperation = defineOperation({
  name: 'weft.workflows.update',
  mcpExposable: false,
  summary: 'Send a synchronous update to a workflow',
  description:
    'Invoke a named update handler on a workflow and wait for its result. Requires the ' +
    'workflow `id` and the update `name`; `payload` is optional. Unlike signals, updates ' +
    'return the handler result synchronously. Faults with NotFound when the workflow is not ' +
    'visible, InvalidParams when the payload exceeds the size limit, and Unprocessable when ' +
    'the workflow declares its updates and this name is not one of them. A Timeout fault carries ' +
    'the `updateId` in its `data`: the update stays queued, and its answer is read later with ' +
    '`weft.updates.result.get` or listed by `weft.workflows.updates.list`.',
  destructive: true,
  tags: ['Updates'],
  inputSchema: updateWorkflowInput,
  outputSchema: updateWorkflowOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['updates:write'] } },
  discoverable: true,
  producibleFaults: ['Unprocessable', 'Timeout'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<UpdateWorkflowOutput> => {
    assertOperationEngineMethods(engine, ['submitCoordinatedUpdate']);
    const typedEngine = engine;

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
      throw toUpdateWorkflowFault(error);
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
  extractInput: async (request, pathParams, context) => {
    // invalid or absent JSON body is ignored, defaults apply.
    // Field-level typeof checks live in `invoke()` (the single cross-transport
    // validator) — extractInput just reads through.
    let payload: unknown;
    let timeout: unknown;
    let idempotencyKey: unknown;

    try {
      const body = await readRestJsonBody(request, context);
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        payload = record['payload'];
        timeout = record['timeout'];
        idempotencyKey = record['idempotencyKey'];
      }
    } catch (error) {
      if (isOperationFault(error)) throw error;
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
};
