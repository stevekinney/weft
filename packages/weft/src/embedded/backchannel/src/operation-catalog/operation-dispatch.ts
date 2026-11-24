import type { OperationHostFactory, OperationInterceptor } from './operation-interceptors.ts';
import { classifyEngineError } from './pipeline-helpers.ts';
import {
  checkAccess,
  checkAuthorization,
  checkTransport,
  parseAndApplyUnknownKeyPolicy,
  tracePipeline,
} from './pipeline-stages.ts';
import { closeAbandonedSubscription, isSubscriptionInvocation } from './subscription-lifecycle.ts';
import type {
  DispatchContext,
  DispatchResult,
  OperationContext,
  OperationKind,
  OperationMetadata,
  SubscriptionOperationInvocation,
} from './types.ts';

type DispatchableOperation<Host> = {
  readonly rawInput: unknown;
  readonly context: DispatchContext<Host>;
};

type InvokableOperation<Input, SchemaOutput, Host> = OperationMetadata<
  Input,
  SchemaOutput,
  Host
> & {
  readonly kind?: OperationKind;
  readonly invoke: (context: OperationContext<Input, Host>) => Promise<unknown>;
};

/** Run the common pipeline before any unary, stream, or subscription invocation. */
export async function dispatchOperation<Input, SchemaOutput, Host>(
  operation: InvokableOperation<Input, SchemaOutput, Host>,
  { rawInput, context }: DispatchableOperation<Host>,
): Promise<DispatchResult<unknown>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    return await invokeWithInterceptors(operation, prepared.value, context);
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation, context.faultPolicy) };
  }
}

async function invokeWithInterceptors<Input, SchemaOutput, Host>(
  operation: InvokableOperation<Input, SchemaOutput, Host>,
  invocation: OperationContext<Input, Host>,
  context: DispatchContext<Host>,
): Promise<DispatchResult<unknown>> {
  let settled = false;
  let started: SubscriptionOperationInvocation<unknown, unknown> | undefined;
  const invoke = async (): Promise<DispatchResult<unknown>> => {
    if (settled)
      return { ok: false, fault: { code: 'EngineFailure', message: 'internal error', data: {} } };
    const value = await operation.invoke(invocation);
    tracePipeline(context.pipelineTrace, 'invoked');
    if (operation.kind === 'subscription' && isSubscriptionInvocation(value)) {
      if (settled) await closeAbandonedSubscription(value);
      else started = value;
    }
    return { ok: true, value };
  };
  if (context.interceptors === undefined || context.interceptors.length === 0) return invoke();
  let result: DispatchResult<unknown> | undefined;
  try {
    result = await callInterceptors(operation, invocation, context.interceptors, invoke);
    return result;
  } finally {
    settled = true;
    if (started !== undefined && !retainsSubscription(result, started)) {
      await closeAbandonedSubscription(started);
    }
  }
}

function callInterceptors<Input, SchemaOutput, Host>(
  operation: InvokableOperation<Input, SchemaOutput, Host>,
  invocation: OperationContext<Input, Host>,
  interceptors: readonly OperationInterceptor[],
  invoke: () => Promise<DispatchResult<unknown>>,
): Promise<DispatchResult<unknown>> {
  const { kind, summary, tags, destructive, access } = operation;
  const { input, principal, transport, signal } = invocation;
  const interception = {
    name: operation.name,
    metadata: { ...(kind === undefined ? {} : { kind }), summary, tags, destructive, access },
    input,
    principal,
    transport,
    ...(signal === undefined ? {} : { signal }),
  };
  const chain = interceptors.reduceRight<typeof invoke>((next, interceptor) => {
    let called: ReturnType<typeof invoke> | undefined;
    return () => interceptor(interception, () => (called ??= next()));
  }, invoke);
  return chain();
}

function retainsSubscription(
  result: DispatchResult<unknown> | undefined,
  started: SubscriptionOperationInvocation<unknown, unknown>,
): boolean {
  return (
    result?.ok === true &&
    isSubscriptionInvocation(result.value) &&
    (result.value.close === started.close ||
      (result.value.subscriptionId === started.subscriptionId &&
        result.value.iterable === started.iterable))
  );
}

async function prepareTypedInput<Input, SchemaOutput, Host>(
  operation: OperationMetadata<Input, SchemaOutput, Host>,
  rawInput: unknown,
  context: DispatchContext<Host>,
): Promise<DispatchResult<OperationContext<Input, Host>>> {
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

  const { principal, transport, signal } = context;
  const source = context.host;
  let host: Host;
  try {
    host =
      typeof source === 'function'
        ? await (source as OperationHostFactory<Host>)({ principal, transport })
        : source;
  } catch {
    return { ok: false, fault: { code: 'EngineFailure', message: 'internal error', data: {} } };
  }
  const invocation = {
    input: parseOutcome.input,
    principal,
    host,
    transport,
    ...(signal === undefined ? {} : { signal }),
  };
  const authorizationFailure = await checkAuthorization(operation, { ...invocation });
  if (authorizationFailure !== null) return authorizationFailure;
  tracePipeline(context.pipelineTrace, 'authorized');
  return { ok: true, value: invocation };
}
