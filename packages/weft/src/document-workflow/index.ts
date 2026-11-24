/**
 * Declarative workflow documents: agent-authored JSON that Weft registers as
 * its own workflow type and runs through one interpreter, with no
 * agent-written code involved.
 *
 * @module document-workflow
 */

export { normalizeScheduleSpec } from '../core/engine/validation/schedule.ts';
export type { NormalizedScheduleSpec } from '../core/engine/validation/schedule.ts';
export {
  WorkflowDocumentBranchError,
  WorkflowDocumentMapError,
  WorkflowDocumentReviewRejectedError,
  WorkflowDocumentSchemaError,
} from './document-errors.ts';
export type { WorkflowDocumentIssue } from './document-errors.ts';
export type { DocumentRejectionStep } from './document-rejection.ts';
export {
  WorkflowDocumentValidationError,
  canonicalWorkflowDocumentJson,
  documentStepAddress,
  validateWorkflowDocument,
  workflowDocumentSchema,
  workflowDocumentStepSchema,
  workflowDocumentVersion,
} from './document.ts';
export type {
  DocumentActivity,
  DocumentActivityArgument,
  DocumentActivityDefinition,
  DocumentActivityHandler,
  DocumentChildWorkflowArgument,
  DocumentSchemaChecker,
  DocumentSchemaPoint,
  DocumentTriggerValidator,
  DocumentWorkflowHost,
  WorkflowDocument,
  WorkflowDocumentStep,
  WorkflowDocumentValidationOptions,
} from './document.ts';
export { buildWorkflowDocumentManifest } from './manifest.ts';
export { registerWorkflowDocuments } from './register.ts';
export type { RegisteredWorkflowDocument, WorkflowDocumentSet } from './register.ts';
