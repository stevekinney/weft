/**
 * `runSharedSourceLoad()`'s own `catalog.install()` call, split out to keep
 * `source-resolution.ts` under the repository's 500-line implementation-file
 * ceiling (WFT-21, item Q7jH).
 *
 * @module core/engine/source-install-fence
 */

import {
  WorkflowRevisionTombstonedError,
  type WorkflowCatalog,
  type WorkflowRevisionRecord,
} from '../catalog/index.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';

/**
 * Install a freshly loaded dynamic-source revision, fenced on the durable
 * removal-generation counter `runSharedSourceLoad()` captured before
 * invoking the host loader — see `KEYS.catalogRemovalGeneration`'s own doc
 * for the full rationale (WFT-21, items 1-3 and Q7jH). Translates the
 * internal `WorkflowRevisionTombstonedError` (either the transient-tombstone
 * form or the durable removal-generation-fence form) to the public
 * `WorkflowRevisionUnavailableError(name, revision, 'not-installed')` —
 * `core/catalog/**` cannot throw that engine-layer error directly.
 */
export async function installFencedSourceRevision(
  catalog: WorkflowCatalog,
  name: string,
  revision: string,
  manifest: WorkflowRevisionManifest,
  definition: RegisteredWorkflowDefinition,
  removalGenerationAtLoadStart: Uint8Array | null,
): Promise<WorkflowRevisionRecord> {
  return catalog
    .install(manifest, definition, { removalGeneration: removalGenerationAtLoadStart })
    .catch((error: unknown) => {
      if (!(error instanceof WorkflowRevisionTombstonedError)) throw error;
      throw new WorkflowRevisionUnavailableError(name, revision, 'not-installed');
    });
}
