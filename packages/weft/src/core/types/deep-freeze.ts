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
 * Functions and class instances are intentionally not frozen. Schema instances
 * can memoize metadata in getters; freezing them breaks validation and schema
 * conversion. `Object.freeze` on a function does
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

function isPlainContainer(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  // Match clonePlain: only containers owned by the workflow are copied/frozen.
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeChildren(value: object, seen: WeakSet<object>): void {
  const entries: unknown[] = Array.isArray(value) ? value : Object.values(value);
  for (const child of entries) {
    if (child !== null && typeof child === 'object') freezeWithSeen(child, seen);
  }
}

function freezeWithSeen<T>(value: T, seen: WeakSet<object>): T {
  if (!isPlainContainer(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Object.isFrozen(value)) return value;
  freezeChildren(value, seen);
  Object.freeze(value);
  return value;
}

export function deepFreeze<T>(value: T): T {
  return freezeWithSeen(value, new WeakSet<object>());
}
