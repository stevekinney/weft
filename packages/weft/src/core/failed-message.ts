/**
 * The `failed` outbound message for a workflow body that threw: the message, the stack, the failure
 * category, and the code of a Weft error (COR-2529), which the message alone would lose.
 *
 * @module core/failed-message
 */
import { errorCodeOf } from './error-code-of.ts';
import { classifyErrorAsFailureCategory } from './failure-categories.ts';
import type { FailureCategory, WorkerOutboundMessage } from './types.ts';

export function failedMessageForError(
  workflowId: string,
  error: unknown,
  fallbackFailureCategory: FailureCategory | undefined,
): WorkerOutboundMessage {
  const failedMessage: WorkerOutboundMessage = {
    type: 'failed',
    workflowId,
    error: error instanceof Error ? error.message : String(error),
    failureCategory:
      fallbackFailureCategory ??
      classifyErrorAsFailureCategory(error, { defaultErrorCategory: 'application' }),
  };
  if (error instanceof Error && error.stack !== undefined) {
    failedMessage.errorStack = error.stack;
  }
  const errorCode = errorCodeOf(error);
  if (errorCode !== undefined) failedMessage.errorCode = errorCode;
  return failedMessage;
}
