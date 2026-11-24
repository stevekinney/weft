/**
 * What a host is told when it is asked whether an `await-signal` payload is a rejection.
 *
 * @module document-workflow/document-rejection
 */

/** The `await-signal` step `DocumentWorkflowHost.isRejection` is asked about. */
export type DocumentRejectionStep = Readonly<{
  /** The document's `name`. */
  name: string;
  /** The version of the document the run is pinned to. */
  workflowVersion: string;
  /** The step's canonical preorder index in the document. */
  step: number;
}>;
