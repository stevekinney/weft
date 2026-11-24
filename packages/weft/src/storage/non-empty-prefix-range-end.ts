import { resolvePrefixRangeEnd } from "../embedded/storage/src/index.ts";

/**
 * {@link resolvePrefixRangeEnd} for a prefix known to be non-empty, such as a
 * `KEYS.*` timer prefix. Throws on an empty prefix, which has no finite end.
 *
 * @example
 * ```ts
 * import { resolveNonEmptyPrefixRangeEnd } from './non-empty-prefix-range-end.ts';
 *
 * console.log(resolveNonEmptyPrefixRangeEnd('wf:')); // 'wf;'
 * ```
 */
export function resolveNonEmptyPrefixRangeEnd(prefix: string): string {
  const end = resolvePrefixRangeEnd(prefix);
  if (end === undefined) {
    throw new Error('An empty prefix has no upper bound.');
  }
  return end;
}
