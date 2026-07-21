import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { WorkflowNotFoundError } from '../../core/engine/errors.ts';
import {
  coerceStartWorkflowTags,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import type { OperationDefinition } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { RestBinding } from '../rest-binding.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { isOperationFault, shapeRestFault } from './operation-helpers.ts';

const singleWorkflowTagMutationInput = z.object({
  workflowId: z.string().min(1),
  tags: z.unknown().optional(),
});

const singleWorkflowTagMutationOutput = z.object({
  ok: z.literal(true),
});

export type SingleWorkflowTagMutationInput = z.infer<typeof singleWorkflowTagMutationInput>;
export type SingleWorkflowTagMutationOutput = z.infer<typeof singleWorkflowTagMutationOutput>;

type SingleWorkflowTagMutationOperationConfiguration = {
  readonly name: string;
  readonly summary: string;
  /** Whether this tag mutation irreversibly mutates state. Required. */
  readonly destructive: boolean;
  readonly mutateTags: (
    engine: Engine,
    workflowId: string,
    tags: readonly string[],
  ) => Promise<void>;
};

type SingleWorkflowTagMutationRestBindingConfiguration = {
  readonly method: 'POST' | 'DELETE';
  readonly operationName: string;
};

export function createSingleWorkflowTagMutationOperation(
  configuration: SingleWorkflowTagMutationOperationConfiguration,
): OperationDefinition<SingleWorkflowTagMutationInput, SingleWorkflowTagMutationOutput> {
  return defineOperation<SingleWorkflowTagMutationInput, SingleWorkflowTagMutationOutput>({
    name: configuration.name,
    mcpExposable: false,
    summary: configuration.summary,
    tags: ['Tags'],
    destructive: configuration.destructive,
    inputSchema: singleWorkflowTagMutationInput,
    outputSchema: singleWorkflowTagMutationOutput,
    access: { kind: 'public' },
    producibleFaults: ['Unprocessable', 'NotFound'],
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input, engine }): Promise<SingleWorkflowTagMutationOutput> => {
      let tags: string[];
      try {
        tags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
      } catch (error) {
        throw unprocessableFault(faultMessage(error));
      }

      try {
        // OperationContext keeps the engine erased because the registry is transport-generic.
        await configuration.mutateTags(engine as Engine, input.workflowId, tags);
        return { ok: true };
      } catch (error) {
        throw mapTagMutationErrorToFault(error, input.workflowId);
      }
    },
  });
}

export function createSingleWorkflowTagMutationRestBinding(
  configuration: SingleWorkflowTagMutationRestBindingConfiguration,
): RestBinding<SingleWorkflowTagMutationInput, SingleWorkflowTagMutationOutput> {
  return {
    method: configuration.method,
    path: '/v1/workflows/:id/tags',
    pathParamNames: ['id'],
    operationName: configuration.operationName,
    inputSources: {
      workflowId: { kind: 'path', pathParam: 'id' },
      tags: { kind: 'body-field', bodyField: 'tags' },
    },
    extractInput: async (request, pathParams, context) => {
      const body: unknown = await readRestJsonBody(request, context).catch((error) => {
        if (isOperationFault(error)) throw error;
        throw new Error('Invalid JSON body');
      });

      if (!isJsonObject(body)) {
        throw new Error('Invalid JSON body');
      }

      return {
        workflowId: pathParams['id'] ?? '',
        tags: body['tags'],
      };
    },
    success: { kind: 'json', status: 200 },
    shapeSuccess: shapeSingleWorkflowTagMutationSuccess,
    shapeFault: shapeSingleWorkflowTagMutationFault,
  };
}

function shapeSingleWorkflowTagMutationSuccess(output: SingleWorkflowTagMutationOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeSingleWorkflowTagMutationFault(fault: OperationFault): Response {
  // Tag routes report validation failures as 400 rather than the
  // transport-neutral Unprocessable status — a REST-only mapping kept
  // explicit here. Every other fault, including the masked EngineFailure
  // 500, goes through the canonical `shapeRestFault`.
  if (fault.code === 'Unprocessable') {
    return shapeRestFault(fault, { status: 400 });
  }

  return shapeRestFault(fault);
}

function mapTagMutationErrorToFault(error: unknown, workflowId: string): OperationFault {
  const message = faultMessage(error);

  // Prefer the typed error so the fault carries `weftCode: 'WorkflowNotFoundError'`
  // for transport-uniform `isWeftFault` branching; fall back to the string match
  // for any non-typed "not found" surfaced by an adjacent path.
  if (error instanceof WorkflowNotFoundError) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'workflow', identifier: workflowId, weftCode: error.code },
    };
  }

  if (message.includes('not found')) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'workflow', identifier: workflowId },
    };
  }

  if (error instanceof StartWorkflowValidationError) {
    return unprocessableFault(message);
  }

  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}

function unprocessableFault(message: string): OperationFault {
  return {
    code: 'Unprocessable',
    message,
    data: { reason: message },
  };
}

function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
