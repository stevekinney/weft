import type { OperationFault } from "../../embedded/backchannel/src/index.ts";
import { invalidParamsFault, withRemediation } from "../../embedded/backchannel/src/internals.ts";
import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import type { BulkOperationConfirmationError } from '../../core/engine/errors.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { ListFilter } from '../../core/types.ts';
import { listFilterFromBulkInput, type BulkListFilterInput } from './bulk-filter-input.ts';
import { faultMessage } from './operation-helpers.ts';

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

/** `data.reason` of the `Conflict` a bulk commit answers when its confirmation token no longer matches. */
const STALE_PREVIEW_REASON = 'confirmation-token-stale';

/** Ends the stale-token message, so a caller that shows only the message still says what to do. */
const STALE_PREVIEW_REMEDIATION =
  'The workflows that match the filter changed after the preview. Run the preview again with ' +
  '`dryRun: true`, then commit with its new `confirmationToken`.';

/**
 * The fault every bulk operation answers when a commit's confirmation token no longer matches the
 * workflows its filter selects. The input was well formed; the matching workflows moved after the
 * preview. That is a conflict with the state the preview described, which a caller answers by
 * previewing again, so it must not share a code with input the caller got wrong. A commit that
 * carries no token never reaches this: `bulkOperationOptionsFromInput` answers it `InvalidParams`.
 * The token is checked before any workflow is touched, so nothing has changed when this is thrown.
 */
export function staleConfirmationFault(error: BulkOperationConfirmationError): OperationFault {
  return withRemediation(
    {
      code: 'Conflict',
      message: `${error.message}. ${STALE_PREVIEW_REMEDIATION}`,
      data: { reason: STALE_PREVIEW_REASON, weftCode: error.code },
    },
    STALE_PREVIEW_REMEDIATION,
  );
}
