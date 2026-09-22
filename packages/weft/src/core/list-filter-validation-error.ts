import type { ValidationIssue } from './validation-issues.ts';
import { WeftError } from './weft-error.ts';

/** Error raised when a list filter fails schema or semantic validation. */
export class ListFilterValidationError extends WeftError<'ListFilterValidationError'> {
  readonly issues: ReadonlyArray<ValidationIssue>;

  constructor(issues: ReadonlyArray<ValidationIssue>) {
    const summary = issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    super('ListFilterValidationError', summary.length > 0 ? summary : 'Invalid list filter');
    this.issues = issues;
  }
}
