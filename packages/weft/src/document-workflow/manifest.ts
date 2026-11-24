/**
 * The contract manifest of a workflow document, for a host that compares revisions of the same
 * document without registering them.
 *
 * @module document-workflow/manifest
 */

import type { WorkflowRevisionManifest } from '../core/contract/types.ts';
import { deriveWorkflowDefinitionManifest } from '../core/engine/definition-revision.ts';
import { validateWorkflowDocument, type DocumentWorkflowHost } from './document.ts';
import { buildDocumentWorkflowDefinition } from './interpreter.ts';

/**
 * Build the {@link WorkflowRevisionManifest} a document would have if it were registered with
 * `host`, without registering it. It runs the pipeline `registerWorkflowDocuments` runs, so the
 * manifest's `revision` equals the revision a registration of the same document installs, and two
 * manifests compare with `checkWorkflowCompatibility`.
 *
 * A document that does not validate against `host` throws {@link WorkflowDocumentValidationError};
 * the host's activity handlers are never called.
 *
 * @example
 * ```ts
 * import { buildWorkflowDocumentManifest, checkWorkflowCompatibility } from '@lostgradient/weft';
 * import type { DocumentWorkflowHost, WorkflowDocument } from '@lostgradient/weft';
 *
 * declare const host: DocumentWorkflowHost;
 * declare const current: WorkflowDocument;
 * declare const earlier: WorkflowDocument;
 *
 * const verdict = checkWorkflowCompatibility(
 *   await buildWorkflowDocumentManifest(current, host),
 *   await buildWorkflowDocumentManifest(earlier, host),
 * );
 * console.log(verdict.compatible);
 * ```
 */
export async function buildWorkflowDocumentManifest(
  document: unknown,
  host: DocumentWorkflowHost,
): Promise<WorkflowRevisionManifest> {
  // A manifest compares revisions, including ones registered before `compensate` was refused.
  const validated = validateWorkflowDocument(document, host, { allowCompensate: true });
  return deriveWorkflowDefinitionManifest(await buildDocumentWorkflowDefinition(validated, host));
}
