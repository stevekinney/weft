import { z } from 'zod';

import { WeftError } from '../../core/weft-error.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  dispatchFailure,
  lookupOperation,
  prepareAuthorizedInput,
  validateOutputAgainstSchema,
} from './dispatch-preparation.ts';
import { classifyEngineError } from './pipeline-helpers.ts';
import { tracePipeline } from './pipeline-stages.ts';
import {
  type DispatchContext,
  type DispatchResult,
  type ErasedOperation,
  type SubscriptionOperationInvocation,
} from './types.ts';

/**
 * Error thrown when an element emitted by a subscription or stream fails
 * per-element schema validation.
 */
export class SubscriptionElementValidationError extends WeftError<'SubscriptionElementValidationError'> {
  constructor(public readonly fault: OperationFault) {
    super('SubscriptionElementValidationError', 'subscription element failed schema validation');
  }
}

/**
 * Execute a `kind: 'stream'` operation and return a schema-validating
 * async iterable for its emitted elements.
 */
export async function executeStream<Element>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<AsyncIterable<Element>>> {
  const prepared = await prepareLongLivedOperation(operationName, rawInput, context, 'stream');
  if (!prepared.ok) return prepared;
  const { operation, input, eventSchema } = prepared.value;

  let invocation: unknown;
  try {
    invocation = await operation.invoke({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return dispatchFailure(classifyEngineError(error, operation));
  }
  tracePipeline(context.pipelineTrace, 'invoked');

  if (!isAsyncIterable(invocation)) {
    return dispatchFailure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }

  tracePipeline(context.pipelineTrace, 'output-validated');
  return {
    ok: true,
    value: validateElements<Element>(invocation, eventSchema),
  };
}

/**
 * Execute a `kind: 'subscription'` operation and return its validated
 * subscribe envelope, schema-validating element iterable, and close hook.
 */
export async function executeSubscription<Element, Envelope>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<
  DispatchResult<{
    envelope: Envelope;
    iterable: AsyncIterable<Element>;
    close: () => Promise<void>;
  }>
> {
  const prepared = await prepareLongLivedOperation(
    operationName,
    rawInput,
    context,
    'subscription',
  );
  if (!prepared.ok) return prepared;
  const { operation, input, eventSchema } = prepared.value;

  let invocation: unknown;
  try {
    invocation = await operation.invoke({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return dispatchFailure(classifyEngineError(error, operation));
  }
  tracePipeline(context.pipelineTrace, 'invoked');

  if (!isSubscriptionInvocation(invocation)) {
    return dispatchFailure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }

  const envelope = validateOutputAgainstSchema<Envelope>(
    operation.outputSchema,
    invocation.envelope,
  );
  if (!envelope.ok) return envelope;
  tracePipeline(context.pipelineTrace, 'output-validated');

  return {
    ok: true,
    value: {
      envelope: envelope.value,
      iterable: validateElements<Element>(invocation.iterable, eventSchema),
      close: invocation.close,
    },
  };
}

/**
 * Result of preparing a long-lived (stream or subscription) operation for
 * dispatch. The discriminated union on `OperationDefinition` guarantees
 * `eventSchema` is present on stream/subscription operations, but
 * `ErasedOperation` (the union of all three kinds) erases that proof at
 * the function boundary. Returning `eventSchema` directly here carries
 * the narrowed schema through to the caller without a runtime guard.
 */
type PreparedLongLivedOperation = {
  readonly operation: ErasedOperation;
  readonly input: unknown;
  readonly eventSchema: z.ZodType;
};

async function prepareLongLivedOperation(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
  expectedKind: 'stream' | 'subscription',
): Promise<DispatchResult<PreparedLongLivedOperation>> {
  const lookup = lookupOperation(operationName, context);
  if (!lookup.ok) return lookup;
  const operation = lookup.value;

  if ((operation.kind ?? 'unary') !== expectedKind) {
    return dispatchFailure({
      code: 'Unprocessable',
      message: `operation "${operation.name}" is not ${expectedKind}`,
      data: { reason: `operation kind is "${operation.kind ?? 'unary'}"` },
    });
  }

  // The discriminated union guarantees `eventSchema` is non-undefined on
  // any operation whose kind is 'stream' or 'subscription'. The kind check
  // above narrows to one of those two variants; if `eventSchema` is
  // somehow still missing we fail loudly because that would mean the
  // registry was assembled from a non-conforming source. A `defineOperation`
  // caller cannot reach this branch — TypeScript rejects the literal.
  if (operation.eventSchema === undefined) {
    return dispatchFailure({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });
  }
  const eventSchema = operation.eventSchema;

  const prepared = await prepareAuthorizedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;

  return { ok: true, value: { operation, input: prepared.value.input, eventSchema } };
}

async function* validateElements<Element>(
  iterable: AsyncIterable<unknown>,
  eventSchema: z.ZodType,
): AsyncIterable<Element> {
  for await (const element of iterable) {
    let parsed: ReturnType<typeof eventSchema.safeParse>;
    try {
      parsed = eventSchema.safeParse(element);
    } catch {
      throw new SubscriptionElementValidationError(elementValidationFault());
    }
    if (!parsed.success) {
      throw new SubscriptionElementValidationError(elementValidationFault());
    }
    yield parsed.data as Element;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function isSubscriptionInvocation(
  value: unknown,
): value is SubscriptionOperationInvocation<unknown, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.hasOwn(record, 'envelope') &&
    isAsyncIterable(record['iterable']) &&
    typeof record['close'] === 'function'
  );
}

function elementValidationFault(): OperationFault {
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}
