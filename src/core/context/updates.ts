import { isAsyncGeneratorFunction, isGeneratorFunction } from '../step-context.ts';
import type { ContextInternals } from './internals.ts';

/**
 * Options for `ctx.onUpdate`. Currently supports an optional pre-acceptance
 * validator that runs before the update payload is durably written.
 *
 * @example
 * ```ts
 * import { workflow, Engine, update } from 'weft';
 * import type { UpdateHandlerOptions } from 'weft';
 *
 * const setAge = update<{ age: number }, void>('setAge');
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'demo' }).execute(async function* (ctx) {
 *     const options: UpdateHandlerOptions = {
 *       validator: (v): unknown => {
 *         const age = (v as Record<string, unknown>)['age'];
 *         if (typeof age !== 'number' || age < 0) {
 *           return { issues: [{ message: 'age must be non-negative' }] };
 *         }
 *         return undefined;
 *       },
 *     };
 *     ctx.onUpdate(setAge, () => undefined, options);
 *     await new Promise(() => {});
 *   }),
 * );
 * void engine;
 * ```
 */
export type UpdateHandlerOptions = {
  /**
   * Pre-acceptance validator. Runs at the engine boundary before the payload
   * is durably written or the workflow observes it.
   *
   * - **Throw** to reject: the thrown error message is wrapped into an
   *   `UpdateValidationError`.
   * - **Return `{ issues: [...] }`** (Standard Schema v1 failure result) to
   *   reject with structured messages.
   * - **Return anything else** (including `undefined`) to accept.
   */
  readonly validator?: (payload: unknown) => unknown;
};

export function onUpdate(
  internals: ContextInternals,
  name: string,
  handler: (payload: unknown) => unknown,
  options?: UpdateHandlerOptions,
): void {
  if (isGeneratorFunction(handler) || isAsyncGeneratorFunction(handler)) {
    throw new TypeError(
      `Update handler "${name}" cannot be a generator function. ` +
        `Use a plain function — update handlers run synchronously at checkpoint boundaries and cannot yield.`,
    );
  }
  internals.updateHandlers ??= new Map();
  internals.updateHandlers.set(name, handler);
  if (options?.validator !== undefined) {
    internals.updateValidators ??= new Map();
    internals.updateValidators.set(name, options.validator);
  } else {
    // Clear any stale validator from a previous registration for this name —
    // if the caller re-registers without a validator, the old validator must
    // not silently continue to gate the new handler.
    internals.updateValidators?.delete(name);
  }
}

export function onQuery(
  internals: ContextInternals,
  name: string,
  handler: (input: unknown) => unknown,
): void {
  internals.queryHandlers ??= new Map();
  internals.queryHandlers.set(name, handler);
}

export function expose(
  internals: ContextInternals,
  accessors: Record<string, () => unknown>,
): void {
  internals.exposedValues ??= new Map();
  for (const [key, accessor] of Object.entries(accessors)) {
    internals.exposedValues.set(key, accessor);
  }
}
