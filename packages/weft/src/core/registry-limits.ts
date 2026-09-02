/**
 * Aggregate registry-snapshot limits shared between the producer
 * (`buildRegistrySnapshot`) and the codegen consumer
 * (`cli/codegen-validate.ts`). Split into its own leaf module — rather than
 * living in `registry-snapshot.ts` — so `codegen-validate.ts` can import the
 * constant and error type without pulling in the rest of the (non-public)
 * snapshot-building surface, and so `registry-snapshot.ts` stays under the
 * repository's implementation-file-size ceiling.
 *
 * Deliberately not re-exported from `core/contract/limits.ts` or any other
 * public-surface module: `registry-snapshot.ts` and this module are internal
 * to the package (never re-exported from the package root), so this constant
 * and error class are not part of the public API and carry no `@example`/
 * jsdoc-audit obligations.
 *
 * @module core/registry-limits
 */
import { WeftError } from './weft-error.ts';

/**
 * Ceiling on the number of workflows one registry snapshot may report,
 * enforced at snapshot-build time in `buildRegistrySnapshot` (the producer)
 * and, independently, on the raw wire payload in `codegen-validate.ts` (the
 * consumer) before that payload is parsed. The two call sites deliberately
 * share this one constant rather than each defining its own: a consumer
 * ceiling looser than the producer's would be dead code, and a consumer
 * ceiling tighter than the producer's would make `weft codegen --server`
 * reject a legitimately-generated snapshot from a same-release server.
 *
 * 512 matches `worker/manifest/limits.ts`'s `MAX_MANIFEST_WORKFLOW_COUNT` —
 * the analogous ceiling an advertised worker manifest's `workflows` array is
 * held to — without importing across the `core`/`worker` boundary; the two
 * numbers are intentionally kept in sync by convention, not by a shared
 * import, since `core/` does not depend on `worker/`.
 */
export const MAX_REGISTRY_WORKFLOW_COUNT = 512;

/**
 * Thrown when `buildRegistrySnapshot` would otherwise publish more than
 * {@link MAX_REGISTRY_WORKFLOW_COUNT} workflows in one snapshot. Unlike
 * {@link RegistryManifestLimitError}, this is an aggregate violation with no
 * single offending workflow to name. Mirrors
 * `RegistrySchemaConversionError`/`RegistryManifestLimitError`'s masked-500
 * handling in `server/operations/get-registry.ts`: the wire response stays a
 * generic `500 / Internal server error`, and the actual count reaches
 * server-side logs only.
 */
export class RegistryWorkflowCountLimitError extends WeftError<'RegistryWorkflowCountLimitError'> {
  readonly count: number;

  constructor(count: number) {
    super(
      'RegistryWorkflowCountLimitError',
      `Registry snapshot would report ${count} workflows, exceeding the maximum of ${MAX_REGISTRY_WORKFLOW_COUNT}`,
    );
    this.count = count;
  }
}
