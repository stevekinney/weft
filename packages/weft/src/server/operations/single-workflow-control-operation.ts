import type { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { FaultCode } from '../../core/fault-code.ts';
import type { OperationFault } from '../operation-fault.ts';
import type { SchemaOperationDefinition } from '../operation-registry.ts';
import { defineOperation } from '../operation-registry.ts';
import {
  assertOperationEngineMethods,
  type OperationEngineMethodName,
} from './operation-helpers.ts';

type SingleWorkflowControlErrorMapper = (context: {
  readonly error: unknown;
  readonly message: string;
  readonly workflowId: string;
}) => OperationFault | undefined;

type SingleWorkflowControlOperationConfiguration<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
> = {
  readonly name: string;
  readonly summary: string;
  /** Optional longer-form prose surfaced in discovery documents and the CLI. */
  readonly description?: string;
  readonly tags: ReadonlyArray<string>;
  /** Whether this control operation irreversibly mutates state. Required. */
  readonly destructive: boolean;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly producibleFaults: ReadonlyArray<FaultCode>;
  readonly requiredEngineMethods: readonly OperationEngineMethodName[];
  readonly invoke: (context: {
    readonly engine: Pick<Engine, OperationEngineMethodName>;
    readonly input: z.output<InputSchema>;
  }) => Promise<z.input<OutputSchema>>;
  readonly mapErrorToFault?: SingleWorkflowControlErrorMapper;
};

export function createSingleWorkflowControlOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
>(
  configuration: SingleWorkflowControlOperationConfiguration<InputSchema, OutputSchema>,
): SchemaOperationDefinition<InputSchema, OutputSchema> {
  return defineOperation({
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
    invoke: async ({ input, engine }): Promise<z.input<OutputSchema>> => {
      try {
        assertOperationEngineMethods(engine, configuration.requiredEngineMethods);
        return await configuration.invoke({ engine, input });
      } catch (error) {
        throw mapSingleWorkflowControlErrorToFault(
          error,
          readWorkflowId(input),
          configuration.mapErrorToFault,
        );
      }
    },
  });
}

function readWorkflowId(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const workflowId = Reflect.get(input, 'workflowId');
  return typeof workflowId === 'string' ? workflowId : '';
}

export function extractWorkflowIdFromPath(
  pathParams: Readonly<Record<string, string | undefined>>,
): { readonly workflowId: string } {
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
