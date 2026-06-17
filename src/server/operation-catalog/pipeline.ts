import {
  dispatchFailure,
  lookupOperation,
  prepareAuthorizedInput,
  validateOutputAgainstSchema,
} from './dispatch-preparation.ts';
import { classifyEngineError } from './pipeline-helpers.ts';
import { tracePipeline } from './pipeline-stages.ts';
import { type DispatchContext, type DispatchResult } from './types.ts';

/**
 * Single request/response dispatch pipeline. Every request/response transport
 * call goes through the same transport, access, input validation,
 * authorization, invocation, and output-validation stages.
 */
export async function executeOperation<Output>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<Output>> {
  const lookup = lookupOperation(operationName, context);
  if (!lookup.ok) return lookup;
  const operation = lookup.value;
  const operationKind = operation.kind ?? 'unary';
  if (operationKind === 'subscription') {
    return dispatchFailure({
      code: 'Unprocessable',
      message: `operation "${operation.name}" is not unary`,
      data: { reason: `operation kind is "${operationKind}"` },
    });
  }

  const prepared = await prepareAuthorizedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;

  let output: unknown;
  try {
    output = await operation.invoke({
      input: prepared.value.input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return dispatchFailure(classifyEngineError(error, operation));
  }
  tracePipeline(context.pipelineTrace, 'invoked');

  const outputResult = validateOutputAgainstSchema<Output>(operation.outputSchema, output);
  if (outputResult.ok) tracePipeline(context.pipelineTrace, 'output-validated');
  return outputResult;
}
