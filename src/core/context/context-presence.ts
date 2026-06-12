import type { Context } from './index.ts';
import { getInternals } from './internals.ts';

/**
 * Presence checks over a {@link Context}'s lazily-allocated internal maps. Each
 * returns `true` only when the backing structure exists *and* is non-empty, so
 * the checkpoint-commit and inline-parking paths can decide whether a context
 * carries pending attribute changes, registered update handlers, or exposed
 * accessors without forcing allocation through the public getters.
 *
 * Extracted from the `Context` class (which sits at the module line ceiling) as
 * free functions; behavior is identical to the former `ctx.has*` getters.
 *
 * @module core/context/context-presence
 */

/** True when the context has at least one pending search-attribute change. */
export function hasPendingAttributeChanges(context: Context): boolean {
  const pendingAttributeChanges = getInternals(context).pendingAttributeChanges;
  return pendingAttributeChanges !== undefined && Object.keys(pendingAttributeChanges).length > 0;
}

/** True when the context has at least one registered update handler. */
export function hasUpdateHandlers(context: Context): boolean {
  const updateHandlers = getInternals(context).updateHandlers;
  return updateHandlers !== undefined && updateHandlers.size > 0;
}

/** True when the context has at least one exposed accessor. */
export function hasExposedAccessors(context: Context): boolean {
  const exposedValues = getInternals(context).exposedValues;
  return exposedValues !== undefined && exposedValues.size > 0;
}
