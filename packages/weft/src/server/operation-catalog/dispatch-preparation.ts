import { z } from 'zod';

import type { OperationFault } from '../operation-fault.ts';
import { tracePipeline } from './pipeline-stages.ts';
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
 * Safely run `schema.safeParse(value)`. Maps any thrown exception or
 * failed parse to `{ code: 'EngineFailure', message: 'internal error', data: {} }`.
 * On success returns the parsed data so Zod transforms, defaults, and
 * refinements are honored.
 *
 * The registry intentionally erases operation-specific output types. A
 * name-only dispatch cannot prove a domain result to its caller, so the
 * parsed value remains unknown at this boundary. Zod's parser is still the
 * source of truth for transforms, defaults, and refinements.
 */
export function validateOutputAgainstSchema(
  schema: z.ZodType,
  value: unknown,
): DispatchResult<unknown> {
  let parseResult: ReturnType<typeof schema.safeParse>;
  try {
    parseResult = schema.safeParse(value);
  } catch {
    return dispatchFailure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!parseResult.success) {
    return dispatchFailure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  return { ok: true, value: parseResult.data };
}

/** Wrap an `OperationFault` in the standard `DispatchResult` failure shape. */
export function dispatchFailure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
