import type { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationDefinition } from '../operation-catalog.ts';
import type { FaultCode, OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';

type SingleWorkflowControlInput = {
  readonly workflowId: string;
};

type SingleWorkflowControlErrorMapper = (context: {
  readonly error: unknown;
  readonly message: string;
  readonly workflowId: string;
}) => OperationFault | undefined;

type SingleWorkflowControlOperationConfiguration<
  Input extends SingleWorkflowControlInput,
  Output,
> = {
  readonly name: string;
  readonly summary: string;
  /** Optional longer-form prose surfaced in discovery documents and the CLI. */
  readonly description?: string;
  readonly tags: ReadonlyArray<string>;
  /** Whether this control operation irreversibly mutates state. Required. */
  readonly destructive: boolean;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly producibleFaults: ReadonlyArray<FaultCode>;
  readonly invoke: (context: { readonly engine: Engine; readonly input: Input }) => Promise<Output>;
  readonly mapErrorToFault?: SingleWorkflowControlErrorMapper;
};

export function createSingleWorkflowControlOperation<
  Input extends SingleWorkflowControlInput,
  Output,
>(
  configuration: SingleWorkflowControlOperationConfiguration<Input, Output>,
): OperationDefinition<Input, Output> {
  return defineOperation<Input, Output>({
    name: configuration.name,
    mcpExposable: false,
    summary: configuration.summary,
    ...(configuration.description === undefined ? {} : { description: configuration.description }),
    tags: configuration.tags,
    destructive: configuration.destructive,
    inputSchema: configuration.inputSchema,
    outputSchema: configuration.outputSchema,
    access: { kind: 'public' },
    producibleFaults: configuration.producibleFaults,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input, engine }): Promise<Output> => {
      try {
        // OperationContext erases the engine so transport adapters can share the registry.
        return await configuration.invoke({ engine: engine as Engine, input });
      } catch (error) {
        throw mapSingleWorkflowControlErrorToFault(
          error,
          input.workflowId,
          configuration.mapErrorToFault,
        );
      }
    },
  });
}

export function extractWorkflowIdFromPath(
  pathParams: Readonly<Record<string, string | undefined>>,
): SingleWorkflowControlInput {
  return { workflowId: pathParams['id'] ?? '' };
}

function mapSingleWorkflowControlErrorToFault(
  error: unknown,
  workflowId: string,
  mapErrorToFault: SingleWorkflowControlErrorMapper | undefined,
): OperationFault {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('not found')) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'workflow', identifier: workflowId },
    };
  }

  const operationSpecificFault = mapErrorToFault?.({ error, message, workflowId });
  if (operationSpecificFault !== undefined) {
    return operationSpecificFault;
  }

  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}
