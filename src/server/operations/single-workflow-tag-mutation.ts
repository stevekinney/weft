import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import {
  coerceStartWorkflowTags,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import type { OperationDefinition } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { RestBinding } from '../rest-binding.ts';
import {
  jsonErrorResponse,
  shapeLegacyRestFaultWithRawEngineFailureMessage,
} from './operation-helpers.ts';

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
  readonly mutateTags: (
    engine: Engine,
    workflowId: string,
    tags: readonly string[],
  ) => Promise<void>;
};

type SingleWorkflowTagMutationRestBindingConfiguration = {
  readonly method: 'POST' | 'DELETE';
  readonly operationName: string;
  readonly path?: string;
};

export function createSingleWorkflowTagMutationOperation(
  configuration: SingleWorkflowTagMutationOperationConfiguration,
): OperationDefinition<SingleWorkflowTagMutationInput, SingleWorkflowTagMutationOutput> {
  return defineOperation<SingleWorkflowTagMutationInput, SingleWorkflowTagMutationOutput>({
    name: configuration.name,
    mcpExposable: false,
    summary: configuration.summary,
    tags: ['Tags'],
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
    path: configuration.path ?? '/v1/workflows/:id/tags',
    pathParamNames: ['id'],
    operationName: configuration.operationName,
    inputSources: {
      workflowId: { kind: 'path', pathParam: 'id' },
      tags: { kind: 'body-field', bodyField: 'tags' },
    },
    extractInput: async (request, pathParams) => {
      const body: unknown = await request.json().catch(() => {
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
  // Legacy tag routes report validation failures as 400 instead of the
  // transport-neutral Unprocessable status, and they expose raw engine
  // failure messages. Keep those REST-only differences explicit.
  if (fault.code === 'Unprocessable') {
    return jsonErrorResponse(fault.message, 400);
  }

  return shapeLegacyRestFaultWithRawEngineFailureMessage(fault);
}

function mapTagMutationErrorToFault(error: unknown, workflowId: string): OperationFault {
  const message = faultMessage(error);

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
