/**
 * Bounded range delete: the `deleteRange` contract, its option types, the
 * validating normalizer, and the public dispatcher. Split out from
 * `interface.ts` to keep that module focused; this imports the `Storage` type
 * (type-only) from there and the derived fallback (value) from
 * `derived-operations.ts`, so there is no runtime import cycle.
 *
 * @module storage/delete-range
 */

import { storageDeleteRangeCore } from './derived-operations.ts';
import { resolvePrefixRangeEnd, type Storage } from './interface.ts';

/**
 * Bounds for a bounded range delete ({@link Storage.deleteRange}).
 *
 * A deliberate subset of `ScanOptions`: `reverse` is intentionally absent so a
 * delete can never run high-to-low. At least one of `gt`/`gte`/`lt`/`lte` must
 * be present — see {@link normalizeDeleteRangeOptions}, which rejects an
 * unbounded request so the operation can never silently degrade into a
 * whole-prefix wipe (use {@link Storage.deletePrefix} for that).
 *
 * @example
 * ```ts
 * import type { DeleteRangeOptions } from '@lostgradient/weft';
 *
 * // Delete events strictly below a sequence watermark.
 * const options: DeleteRangeOptions = { lt: 'ev:wf:0000000003' };
 * ```
 */
export type DeleteRangeOptions = {
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
  limit?: number;
};

declare const normalizedDeleteRangeBrand: unique symbol;

/**
 * A {@link DeleteRangeOptions} that has passed {@link normalizeDeleteRangeOptions}.
 *
 * The brand lives strictly below the public boundary: every public surface
 * accepts raw `DeleteRangeOptions`, but internal SQL builders that would emit a
 * destructive statement require this type, so an unvalidated or unbounded object
 * cannot reach them — that is a compile error, not a runtime check. The only way
 * to obtain a value of this type is to call {@link normalizeDeleteRangeOptions}.
 */
export type NormalizedDeleteRangeOptions = DeleteRangeOptions & {
  readonly [normalizedDeleteRangeBrand]: true;
};

function normalizeDeleteRangeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    throw new Error('deleteRange limit must be a finite non-negative integer');
  }
  // Normalize -0 to 0 so downstream comparisons and SQL parameters are clean.
  return limit === 0 ? 0 : limit;
}

/**
 * Validate and canonicalize {@link DeleteRangeOptions} into a branded
 * {@link NormalizedDeleteRangeOptions}.
 *
 * This is the only door to the branded type, and the single source of truth for
 * the `deleteRange` contract:
 * - At least one of `gt`/`gte`/`lt`/`lte` must be present; an unbounded request
 *   throws rather than degrading into a whole-prefix delete.
 * - Each bound, when present, must be a string.
 * - `limit`, when present, must be a finite non-negative integer (a negative
 *   `LIMIT` silently means "no limit" in SQLite — catastrophic for a delete).
 * - Only `gt`/`gte`/`lt`/`lte`/`limit` are copied; `reverse` and any other
 *   field on a wider object are dropped, so a delete can never run high-to-low.
 *
 * Idempotent: re-normalizing an already-normalized value returns an equivalent
 * one, so passing the dispatcher's result into a native adapter method is safe.
 *
 * @throws {Error} When no bound is present, a bound is not a string, or `limit`
 * is not a finite non-negative integer.
 *
 * Internal helper: not exported from any package subpath. Callers reach it
 * transitively through {@link storageDeleteRange} (which is public). No `@example`
 * here for that reason — it has no public import path, like the derived `*Core`
 * helpers in `./derived-operations.ts`.
 */
export function normalizeDeleteRangeOptions(
  options: DeleteRangeOptions,
): NormalizedDeleteRangeOptions {
  const normalized: DeleteRangeOptions = {};
  let hasBound = false;

  for (const bound of ['gt', 'gte', 'lt', 'lte'] as const) {
    const value = options[bound];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error('deleteRange bounds must be strings');
    }
    normalized[bound] = value;
    hasBound = true;
  }

  if (!hasBound) {
    throw new Error(
      'deleteRange requires at least one of gt/gte/lt/lte; use deletePrefix to delete a whole prefix',
    );
  }

  const limit = normalizeDeleteRangeLimit(options.limit);
  if (limit !== undefined) {
    normalized.limit = limit;
  }

  // Safe: `normalized` was built by copying only validated fields from `options`
  // and has passed the bound-presence, bound-type, and limit checks above. The
  // brand marks it as having cleared every deleteRange invariant.
  return normalized as NormalizedDeleteRangeOptions;
}

/**
 * Delete the keys under `prefix` that fall within the given bounds, using the
 * adapter's native `deleteRange` when available or a batched scan-and-delete
 * fallback otherwise. Returns the number of keys deleted.
 *
 * Options are validated and canonicalized once here (see
 * {@link normalizeDeleteRangeOptions}): an unbounded request throws rather than
 * wiping the whole prefix, and `reverse` can never take effect. When `limit` is
 * set, the lowest (ascending) keys in range are deleted first.
 *
 * @throws {Error} When `options` has no bound, a non-string bound, or an invalid `limit`.
 *
 * @example
 * ```ts
 * import { MemoryStorage, storageDeleteRange } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await storage.put('ev:wf:0000000001', new Uint8Array([1]));
 * await storage.put('ev:wf:0000000002', new Uint8Array([2]));
 * await storage.put('ev:wf:0000000003', new Uint8Array([3]));
 * // Delete events strictly below sequence 3.
 * const deleted = await storageDeleteRange(storage, 'ev:wf:', { lt: 'ev:wf:0000000003' });
 * console.log(deleted); // 2
 * ```
 */
export async function storageDeleteRange(
  storage: Storage,
  prefix: string,
  options: DeleteRangeOptions,
): Promise<number> {
  const normalized = normalizeDeleteRangeOptions(options);

  if (storage.deleteRange) {
    return storage.deleteRange(prefix, normalized);
  }

  return storageDeleteRangeCore(storage, prefix, normalized);
}

/** One side of a resolved lexicographic delete range. `open` means exclusive. */
export type DeleteRangeBound = { key: string; open: boolean };

/**
 * Intersect the prefix range `[prefix, prefixEnd)` with the normalized
 * `gt`/`gte`/`lt`/`lte` bounds into effective lower/upper bounds, or `null` when
 * the intersection is empty (an impossible range). Adapters that build a native
 * range object (e.g. IndexedDB's `IDBKeyRange`) use this to short-circuit an
 * inverted range to a zero-delete instead of constructing an invalid range.
 *
 * Tie rules: when both `gt` and `gte` (or both `lt` and `lte`) push to the same
 * key, the stricter/open side wins. The prefix exclusive end stays exclusive
 * even if an inclusive `lte` equals it.
 */
/** Lower bound: inclusive at prefix, tightened by gt (exclusive) / gte (inclusive). */
function resolveLowerBound(
  prefix: string,
  options: NormalizedDeleteRangeOptions,
): DeleteRangeBound {
  const bound: DeleteRangeBound = { key: prefix, open: false };
  if (options.gte !== undefined && options.gte > bound.key) {
    bound.key = options.gte;
    bound.open = false;
  }
  if (options.gt !== undefined && options.gt >= bound.key) {
    bound.key = options.gt;
    bound.open = true;
  }
  return bound;
}

/** Upper bound: prefix exclusive end, tightened by lt (exclusive) / lte (inclusive). */
function resolveUpperBound(
  prefix: string,
  options: NormalizedDeleteRangeOptions,
): DeleteRangeBound {
  const bound: DeleteRangeBound = { key: resolvePrefixRangeEnd(prefix), open: true };
  if (options.lt !== undefined && options.lt <= bound.key) {
    bound.key = options.lt;
    bound.open = true;
  }
  if (options.lte !== undefined && options.lte < bound.key) {
    bound.key = options.lte;
    bound.open = false;
  }
  return bound;
}

export function resolveDeleteRangeBounds(
  prefix: string,
  options: NormalizedDeleteRangeOptions,
): { lower: DeleteRangeBound; upper: DeleteRangeBound } | null {
  const lower = resolveLowerBound(prefix, options);
  const upper = resolveUpperBound(prefix, options);

  if (lower.key > upper.key || (lower.key === upper.key && (lower.open || upper.open))) {
    return null;
  }

  return { lower, upper };
}
