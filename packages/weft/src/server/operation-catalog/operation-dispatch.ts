import { classifyEngineError } from './pipeline-helpers.ts';
import {
  checkAccess,
  checkAuthorization,
  checkTransport,
  parseAndApplyUnknownKeyPolicy,
  tracePipeline,
} from './pipeline-stages.ts';
import type {
  DispatchContext,
  DispatchResult,
  OperationContext,
  OperationMetadata,
  StreamOperationDefinition,
  StreamOperationInvocation,
  SubscriptionOperationDefinition,
  SubscriptionOperationInvocation,
  UnaryOperationDefinition,
} from './types.ts';

type DispatchableOperation = {
  readonly rawInput: unknown;
  readonly context: DispatchContext;
};

export async function dispatchUnary<Input, InvokeOutput, SchemaOutput>(
  operation: UnaryOperationDefinition<Input, InvokeOutput, SchemaOutput>,
  { rawInput, context }: DispatchableOperation,
): Promise<DispatchResult<InvokeOutput>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    const output = await operation.invoke(operationContext(prepared.value.input, context));
    tracePipeline(context.pipelineTrace, 'invoked');
    return { ok: true, value: output };
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation) };
  }
}

export async function dispatchStream<Input, InvokeOutput, SchemaOutput, InvokeElement, Element>(
  operation: StreamOperationDefinition<Input, InvokeOutput, SchemaOutput, InvokeElement, Element>,
  { rawInput, context }: DispatchableOperation,
): Promise<DispatchResult<InvokeOutput | StreamOperationInvocation<InvokeElement>>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    const output = await operation.invoke(operationContext(prepared.value.input, context));
    tracePipeline(context.pipelineTrace, 'invoked');
    return { ok: true, value: output };
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation) };
  }
}

export async function dispatchSubscription<
  Input,
  InvokeOutput,
  SchemaOutput,
  InvokeElement,
  Element,
>(
  operation: SubscriptionOperationDefinition<
    Input,
    InvokeOutput,
    SchemaOutput,
    InvokeElement,
    Element
  >,
  { rawInput, context }: DispatchableOperation,
): Promise<DispatchResult<SubscriptionOperationInvocation<InvokeElement, InvokeOutput>>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    const output = await operation.invoke(operationContext(prepared.value.input, context));
    tracePipeline(context.pipelineTrace, 'invoked');
    return { ok: true, value: output };
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation) };
  }
}

async function prepareTypedInput<Input, SchemaOutput>(
  operation: OperationMetadata<Input, SchemaOutput>,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<{ input: Input }>> {
  const transportFailure = checkTransport(operation, context);
  if (transportFailure !== null) return transportFailure;
  tracePipeline(context.pipelineTrace, 'transport-checked');

  const accessFailure = checkAccess(operation, context);
  if (accessFailure !== null) return accessFailure;
  tracePipeline(context.pipelineTrace, 'access-checked');

  const parseOutcome = parseAndApplyUnknownKeyPolicy(
    operation,
    rawInput,
    context.transport === 'http-rest' ? 'http' : 'jsonRpc',
    context.pipelineTrace,
  );
  if (parseOutcome.kind === 'failure') return { ok: false, fault: parseOutcome.fault };

  const authorizationFailure = await checkAuthorization(operation, parseOutcome.input, context);
  if (authorizationFailure !== null) return authorizationFailure;
  tracePipeline(context.pipelineTrace, 'authorized');
  return { ok: true, value: { input: parseOutcome.input } };
}

function operationContext<Input>(input: Input, context: DispatchContext): OperationContext<Input> {
  return {
    input,
    principal: context.principal,
    engine: context.engine,
    transport: context.transport,
  };
}
