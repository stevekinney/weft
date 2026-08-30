/**
 * Invoking an `ctx.onUpdate()` handler, and the type of the handler itself.
 *
 * Separate from `updates.ts` because both the inline dispatch path and
 * `pending-updates.ts`'s replay path call it, and because it is pure handler
 * invocation with no coupling to the in-memory waiter maps or the durable
 * coordinated-update protocol that make up the rest of update delivery.
 *
 * @module core/engine/invoke-update-handler
 */

import { isGeneratorResult } from '../step-context.ts';
import type { EngineInternals } from './internals.ts';

/** An `ctx.onUpdate()` handler as stored on a live workflow context. */
export type InlineUpdateHandler = (payload: unknown) => unknown;

/**
 * Invoke an update handler, checking that it does not return a generator.
 * Centralises the runtime generator guard for both the inline-handler path
 * in `update()` and the pending-drain path on resume.
 */
export async function invokeUpdateHandler(
  _internals: EngineInternals,
  name: string,
  handler: (payload: unknown) => unknown,
  payload: unknown,
): Promise<unknown> {
  const result = handler(payload);
  if (isGeneratorResult(result)) {
    throw new TypeError(
      `Update handler "${name}" returned a generator. ` +
        'Update handlers must return a plain value or a Promise, not a generator.',
    );
  }
  return await result;
}
