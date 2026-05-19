import { z } from 'zod';

import type { OperationFault } from '../operation-fault.ts';
import { transportToPolicyKey } from './pipeline-helpers.ts';
import {
  checkAccess,
  checkAuthorization,
  checkTransport,
  parseAndApplyUnknownKeyPolicy,
  tracePipeline,
} from './pipeline-stages.ts';
import { type DispatchContext, type DispatchResult, type ErasedOperation } from './types.ts';

/**
 * Look up an operation by name. Emits the `looked-up` trace marker on
 * success. On failure (unknown operation) emits no marker, matching the
 * existing dispatch behavior where `MethodNotFound` ends the pipeline
 * before any marker is recorded.
 */
export function lookupOperation(
  operationName: string,
  context: DispatchContext,
): DispatchResult<ErasedOperation> {
  const operation = context.registry.get(operationName);
  if (operation === undefined) {
    return dispatchFailure({
      code: 'MethodNotFound',
      message: `unknown operation: ${operationName}`,
      data: { method: operationName },
    });
  }
  tracePipeline(context.pipelineTrace, 'looked-up');
  return { ok: true, value: operation };
}

/**
 * Take an already-looked-up operation and run transport, access, input
 * parsing with unknown-key policy, and authorization. Emits markers
 * `transport-checked`, `access-checked`, the parse markers emitted from
 * inside `parseAndApplyUnknownKeyPolicy`, then `authorized`.
 *
 * Authorization is part of this helper's contract; callers must not
 * re-authorize the same input.
 */
export async function prepareAuthorizedInput(
  operation: ErasedOperation,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<{ input: unknown }>> {
  const pipelineTrace = context.pipelineTrace;

  const transportFailure = checkTransport(operation, context);
  if (transportFailure !== null) return transportFailure;
  tracePipeline(pipelineTrace, 'transport-checked');

  const accessFailure = checkAccess(operation, context);
  if (accessFailure !== null) return accessFailure;
  tracePipeline(pipelineTrace, 'access-checked');

  const parseOutcome = parseAndApplyUnknownKeyPolicy(
    operation,
    rawInput,
    transportToPolicyKey(context.transport),
    pipelineTrace,
  );
  if (parseOutcome.kind === 'failure') return dispatchFailure(parseOutcome.fault);

  const authorizationFailure = await checkAuthorization(operation, parseOutcome.input, context);
  if (authorizationFailure !== null) return authorizationFailure;
  tracePipeline(pipelineTrace, 'authorized');

  return { ok: true, value: { input: parseOutcome.input } };
}

/**
 * Safely run `schema.safeParse(value)`. Maps any thrown exception or
 * failed parse to `{ code: 'EngineFailure', message: 'internal error', data: {} }`.
 * On success returns the parsed data so Zod transforms, defaults, and
 * refinements are honored.
 *
 * The `Output` generic is the caller's declared output type for the
 * operation. The schema is erased to `z.ZodType` on `ErasedOperation`,
 * so we cast `parseResult.data` to `Output` at the validated boundary —
 * the same single-level cast the previous private helpers performed
 * (`validateAndReturnOutput` and `validateOutput`). The cast is safe
 * because the success branch is only reachable after `schema.safeParse`
 * succeeded.
 */
export function validateOutputAgainstSchema<Output>(
  schema: z.ZodType,
  value: unknown,
): DispatchResult<Output> {
  let parseResult: ReturnType<typeof schema.safeParse>;
  try {
    parseResult = schema.safeParse(value);
  } catch {
    return dispatchFailure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!parseResult.success) {
    return dispatchFailure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  return { ok: true, value: parseResult.data as Output };
}

/** Wrap an `OperationFault` in the standard `DispatchResult` failure shape. */
export function dispatchFailure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
