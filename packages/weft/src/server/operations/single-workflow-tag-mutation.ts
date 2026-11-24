import { z } from 'zod';

import {
  defineOperation,
  type AuthorizationScope,
  type OperationFault,
  type SchemaOperationDefinition,
} from "../../embedded/backchannel/src/index.ts";
import {
  isOperationFault,
  readRestJsonBody,
  type RestBinding,
} from "../../embedded/backchannel/src/internals.ts";
import type { Engine } from '../../core/engine.ts';
import { WorkflowNotFoundError } from '../../core/engine/errors.ts';
import {
  coerceStartWorkflowTags,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import {
  assertOperationEngineMethods,
  shapeRestFault,
  type OperationEngineMethodName,
} from './operation-helpers.ts';

const singleWorkflowTagMutationInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose tags change.'),
  tags: z
    .unknown()
    .optional()
    .describe('Tags the call acts on, as an array of non-empty strings (at most 32 per request).'),
});

const singleWorkflowTagMutationOutput = z.object({
  ok: z.literal(true),
});

export type SingleWorkflowTagMutationInput = z.infer<typeof singleWorkflowTagMutationInput>;
export type SingleWorkflowTagMutationOutput = z.infer<typeof singleWorkflowTagMutationOutput>;

type SingleWorkflowTagMutationOperationConfiguration = {
  readonly name: string;
  readonly summary: string;
  /** Longer-form prose for discovery documents. */
  readonly description: string;
  /** Whether this tag mutation irreversibly mutates state. Required. */
  readonly destructive: boolean;
  /** The scope a caller must hold to run this operation. Required: no tag mutation is public. */
  readonly scope: AuthorizationScope;
  readonly requiredEngineMethods: readonly OperationEngineMethodName[];
  readonly mutateTags: (
    engine: Pick<Engine, OperationEngineMethodName>,
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
): SchemaOperationDefinition<
  typeof singleWorkflowTagMutationInput,
  typeof singleWorkflowTagMutationOutput
> {
  return defineOperation({
    name: configuration.name,
    mcpExposable: false,
    summary: configuration.summary,
    description: configuration.description,
    tags: ['Tags'],
    destructive: configuration.destructive,
    inputSchema: singleWorkflowTagMutationInput,
    outputSchema: singleWorkflowTagMutationOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: [configuration.scope] } },
    discoverable: true,
    producibleFaults: ['Unprocessable', 'NotFound'],
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input, host: engine }): Promise<SingleWorkflowTagMutationOutput> => {
      let tags: string[];
      try {
        tags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
      } catch (error) {
        throw unprocessableFault(faultMessage(error));
      }

      try {
        assertOperationEngineMethods(engine, configuration.requiredEngineMethods);
        await configuration.mutateTags(engine, input.workflowId, tags);
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
    shapeFault: shapeSingleWorkflowTagMutationFault,
  };
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
