import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { ListFilter } from '../../core/types.ts';
import {
  faultMessage,
  listFilterFromBulkInput,
  type BulkListFilterInput,
} from './bulk-filter-helpers.ts';
import { invalidParamsFault } from './operation-helpers.ts';

/**
 * Coerces filter tags (label `Field "filter.tags"`), builds a `ListFilter`
 * via `listFilterFromBulkInput`, and asserts the result satisfies the
 * scoped-bulk constraints. Tag-coercion and scoped-assertion failures
 * surface as `invalidParamsFault(faultMessage)` to match the per-file
 * behavior across bulk delete / cancel / signal and the filter portion of
 * bulk mutate-tags. `listFilterFromBulkInput` itself is unguarded because
 * its only documented throw paths (malformed time-range bounds) are
 * rejected upstream — by Zod for JSON-RPC callers and by
 * `parseBulkListFilterFromBody` for REST callers — before this helper
 * runs.
 *
 * Not used by `purge-workflows.ts`: purge allows empty/unscoped filters and
 * uses the canonical REST fault fallback (sanitized) rather than passing
 * raw engine messages through unmasked.
 */
export function validatedListFilterFromBulkInput(input: BulkListFilterInput): ListFilter {
  let tags: string[] | undefined;
  if (input.tags !== undefined) {
    try {
      tags = coerceStartWorkflowTags(input.tags, 'Field "filter.tags"');
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  }

  const filter = listFilterFromBulkInput(tags === undefined ? input : { ...input, tags });

  try {
    assertScopedBulkWorkflowFilter(filter);
  } catch (error) {
    throw invalidParamsFault(faultMessage(error));
  }

  return filter;
}
