/**
 * The errors a workflow document's validation and its runs raise, apart from the document's
 * shape in `document.ts`.
 *
 * @module document-workflow/document-errors
 */

/** One reason a document was rejected, located by a path such as `steps[2].handler`. */
export type WorkflowDocumentIssue = Readonly<{ path: string; message: string }>;

/** Thrown when a branch has no matching case and no `otherwise` steps. */
export class WorkflowDocumentBranchError extends Error {
  constructor(field: string, value: unknown) {
    super(`Branch has no matching case for field "${field}" with value ${JSON.stringify(value)}`);
    this.name = 'WorkflowDocumentBranchError';
  }
}

/** Thrown when a map step cannot iterate its previous result. */
export class WorkflowDocumentMapError extends Error {
  /** Why the map source could not be iterated. */
  readonly code: 'not-array' | 'too-many';

  constructor(code: 'not-array' | 'too-many', message: string) {
    super(message);
    this.name = 'WorkflowDocumentMapError';
    this.code = code;
  }
}

/**
 * A run ended because its input or output did not satisfy the document's schema. The message
 * begins with `code`, then `: `, then each issue as `path: message` joined by `; `, so a host that
 * reads only a failed run's `error` text can tell the two apart.
 */
export class WorkflowDocumentSchemaError extends Error {
  /** Which schema the value broke. */
  readonly code: 'input-invalid' | 'output-invalid';
  /** Every way the value failed the schema. */
  readonly issues: readonly WorkflowDocumentIssue[];

  constructor(code: 'input-invalid' | 'output-invalid', issues: readonly WorkflowDocumentIssue[]) {
    const summary = issues
      .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
      .join('; ');
    super(`${code}: ${summary}`);
    this.name = 'WorkflowDocumentSchemaError';
    this.code = code;
    this.issues = issues;
  }
}

/**
 * A run ended because a person rejected the review it waited at (COR-2238). The message is `code`,
 * and the run's stored `errorStack` begins with this class's name, so a host that keeps only a
 * failed run's `error` and stack can tell a rejected review from any other failure. The reviewer's
 * reason is not here: Weft never reads a signal's payload, and the host keeps the reason in its
 * own review record.
 */
export class WorkflowDocumentReviewRejectedError extends Error {
  /** Why the run ended. */
  readonly code = 'review-rejected';

  constructor() {
    super('review-rejected');
    this.name = 'WorkflowDocumentReviewRejectedError';
  }
}
