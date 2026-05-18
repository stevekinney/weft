import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

// `fromStep` is intentionally `unknown` at the schema boundary. The exact
// legacy "Field 'fromStep' must be a non-negative safe integer" error path
// lives in `invoke()` so REST and JSON-RPC callers share one contract.
const forkWorkflowInput = z.object({
  workflowId: z.string().min(1),
  fromStep: z.unknown().optional(),
});

const forkWorkflowOutput = z.object({
  id: z.string(),
});

export type ForkWorkflowInput = z.infer<typeof forkWorkflowInput>;
export type ForkWorkflowOutput = z.infer<typeof forkWorkflowOutput>;

/**
 * Validate the `fromStep` field of a fork request.
 *
 * Returns the resolved fork options when `fromStep` is present and valid, or
 * `undefined` when `fromStep` was not provided. Throws an `InvalidParams` fault
 * if `fromStep` is present but not a non-negative safe integer.
 */
function validateForkInput(input: ForkWorkflowInput): { fromStep: number } | undefined {
  if (input.fromStep === undefined) {
    return undefined;
  }
  if (
    typeof input.fromStep !== 'number' ||
    !Number.isSafeInteger(input.fromStep) ||
    input.fromStep < 0
  ) {
    throw invalidParamsFault('Field "fromStep" must be a non-negative safe integer');
  }
  return { fromStep: input.fromStep };
}

/**
 * Map an engine error thrown by `engine.fork` to the canonical operation fault.
 *
 * Routing order (precedence preserved from legacy implementation):
 *   1. 'fromStep' / 'Checkpoint not found at step' → InvalidParams (400)
 *   2. 'Checkpoint not found'                       → NotFound, resource: 'checkpoint'
 *   3. 'not found'                                  → NotFound, resource: 'workflow'
 *   4. otherwise                                    → EngineFailure
 */
function resolveForkAccess(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('fromStep') || message.includes('Checkpoint not found at step')) {
    throw invalidParamsFault(message);
  }
  if (message.includes('Checkpoint not found')) {
    const fault: OperationFault = {
      code: 'NotFound',
      message,
      data: { resource: 'checkpoint' },
    };
    throw fault;
  }
  if (message.includes('not found')) {
    const fault: OperationFault = {
      code: 'NotFound',
      message,
      data: { resource: 'workflow' },
    };
    throw fault;
  }

  const fault: OperationFault = {
    code: 'EngineFailure',
    message,
    data: {},
  };
  throw fault;
}

export const forkWorkflowOperation = defineOperation<ForkWorkflowInput, ForkWorkflowOutput>({
  name: 'weft.workflows.fork',
  mcpExposable: false,
  summary: 'Fork a workflow from a checkpoint',
  tags: ['Workflows'],
  inputSchema: forkWorkflowInput,
  outputSchema: forkWorkflowOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ForkWorkflowOutput> => {
    const typedEngine = engine as Engine;
    const options = validateForkInput(input);

    try {
      const handle = await typedEngine.fork(input.workflowId, options);
      return { id: handle.id };
    } catch (error) {
      resolveForkAccess(error);
    }
  },
});

export const forkWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/fork',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.fork',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    fromStep: { kind: 'body-field', bodyField: 'fromStep' },
  },
  extractInput: async (request, pathParams) => {
    const rawBody = await request.text();
    if (rawBody.trim().length === 0) {
      return { workflowId: pathParams['id'] ?? '' };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // Legacy parity: arrays are explicitly rejected here (handleForkWorkflow
    // uses the same `Array.isArray(body)` guard); `fromStep` validation lives
    // in `invoke` so REST and JSON-RPC share one error path.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    return {
      workflowId: pathParams['id'] ?? '',
      fromStep: record['fromStep'],
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeRestFault,
};
