import { WeftError } from '../weft-error.ts';

/**
 * Thrown when a workflow's checkpoint cannot be encoded for storage, for
 * example because a workflow local or memoized result nests deeper than the
 * codec allows. Unlike a storage failure, which recovery can retry, encoding
 * is deterministic: the same state fails the same way on every resume, so the
 * engine fails the workflow with this error rather than leaving it running.
 */
export class CheckpointEncodingError extends WeftError<'CheckpointEncodingError'> {
  readonly workflowId: string;

  constructor(workflowId: string, cause: unknown) {
    super(
      'CheckpointEncodingError',
      `Workflow "${workflowId}" checkpoint cannot be encoded: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.workflowId = workflowId;
  }
}
