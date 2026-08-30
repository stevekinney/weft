/**
 * Recursive `Object.freeze` for plain objects and arrays.
 *
 * The workflow builder calls this from `.execute(fn)` to lock every cloned
 * activity, signal, update, query, and search-attribute definition before
 * handing the built workflow off to the engine. Deep freezing prevents post-
 * definition mutation from invalidating idempotency, replay, or registry
 * invariants — including mutations against nested option subtrees like
 * `activity.retry.backoff.initialInterval`.
 *
 * Functions are intentionally not frozen. `Object.freeze` on a function does
 * not meaningfully prevent reassignment of the calling site, and frozen
 * functions can interact badly with library code that augments them. The outer
 * container that holds the function reference is frozen, so `definition.execute
 * = differentFn` still fails in strict mode.
 *
 * @example
 * ```ts
 * import { deepFreeze } from '@lostgradient/weft';
 *
 * const frozen = deepFreeze({ retry: { backoff: { initialInterval: 100 } } });
 * // In strict mode, the next line throws TypeError; outside strict mode it
 * // silently no-ops.
 * try {
 *   frozen.retry.backoff.initialInterval = 999;
 * } catch (error) {
 *   void error;
 * }
 * ```
 */

function shouldRecurse(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  // Recurse into plain object literals only. Class instances, Map, Set, etc.
  // get the outer-shell freeze but their internals are left alone.
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeChildren(value: object, seen: WeakSet<object>): void {
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of entries) {
    if (child !== null && typeof child === 'object') freezeWithSeen(child, seen);
  }
}

function freezeWithSeen<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as unknown as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  if (Object.isFrozen(value)) return value;
  if (shouldRecurse(value)) freezeChildren(objectValue, seen);
  Object.freeze(value);
  return value;
}

export function deepFreeze<T>(value: T): T {
  return freezeWithSeen(value, new WeakSet<object>());
}
