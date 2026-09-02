/**
 * Content-derived workflow revision identity.
 *
 * `revision` is the broader identity companion to `contractHash`: it hashes
 * the *entire* normalized contract — `name`, `workflowVersion`,
 * `description`, and `tags` included — so it changes whenever anything
 * about the definition changes, including documentation. This is the same
 * formula the (now-refactored) `buildWorkerManifestFromRegistry()` used for
 * its `workflowRevision` field before this module existed.
 *
 * @module core/contract/revision
 */

import { digestCanonicalWorkflowContract } from './hash.ts';
import { canonicalWorkflowContractJson } from './normalize.ts';
import type { WorkflowContract } from './types.ts';

/**
 * Derive a content-addressed revision identity for a workflow contract.
 *
 * Two calls on an equivalent contract (regardless of source key order)
 * produce the same revision, and any field the full canonical serialization
 * carries — including `description` and `tags` — changes it.
 *
 * @example
 * ```ts
 * import { deriveWorkflowRevision } from '@lostgradient/weft';
 *
 * const revision = await deriveWorkflowRevision({ name: 'checkout', workflowVersion: '2.1.0' });
 * console.log(revision.startsWith('sha256:')); // true
 * ```
 */
export async function deriveWorkflowRevision(contract: WorkflowContract): Promise<string> {
  return digestCanonicalWorkflowContract(canonicalWorkflowContractJson(contract));
}
