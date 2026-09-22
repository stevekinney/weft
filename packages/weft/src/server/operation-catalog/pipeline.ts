import {
  dispatchFailure,
  lookupOperation,
  validateOutputAgainstSchema,
} from './dispatch-preparation.ts';
import { tracePipeline } from './pipeline-stages.ts';
import { type DispatchContext, type DispatchResult } from './types.ts';

/**
 * Single request/response dispatch pipeline. Every request/response transport
 * call goes through the same transport, access, input validation,
 * authorization, invocation, and output-validation stages.
 */
export async function executeOperation(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<unknown>> {
  const lookup = lookupOperation(operationName, context);
  if (!lookup.ok) return lookup;
  const operation = lookup.value;
  const operationKind = operation.kind ?? 'unary';
  // REST streaming bindings use this pipeline so shapeSuccess can emit SSE.
  // Request/response JSON-RPC transports must reject stream operations before invoke.
  if (
    operationKind === 'subscription' ||
    (operationKind === 'stream' && context.transport !== 'http-rest')
  ) {
    return dispatchFailure({
      code: 'Unprocessable',
      message: `operation "${operation.name}" is not unary`,
      data: { reason: `operation kind is "${operationKind}"` },
    });
  }

  const dispatched = await operation.dispatch(rawInput, context);
  if (!dispatched.ok) return dispatched;
  const output = dispatched.value;

  const outputResult = validateOutputAgainstSchema(operation.outputSchema, output);
  if (outputResult.ok) tracePipeline(context.pipelineTrace, 'output-validated');
  return outputResult;
}
