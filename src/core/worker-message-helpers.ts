import { logRecordToConsole } from './context/workflow-logger.ts';
import type { WorkerOutboundMessage } from './types.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import { isValidWorkerLogRecord, type WorkerLogMessageCandidate } from './worker-protocol-log.ts';
import { assertWorkerProtocolMessageWithinLimit } from './worker-protocol.ts';

export function emitWorkerMessageToEngine(
  handler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null,
  message: WorkerOutboundMessage,
): boolean | Promise<boolean> {
  try {
    const emitResult = handler?.(message);
    if (emitResult instanceof Promise) {
      return emitResult.then(
        () => false,
        () => true,
      );
    }
    return false;
  } catch {
    return true;
  }
}

export function isParkableWaitSignalCheckpoint(
  message: Extract<WorkerOutboundMessage, { type: 'checkpoint' }>,
): boolean {
  const operationRequest = message.operationRequest as Record<string, unknown>;
  return operationRequest['type'] === 'wait-signal' || operationRequest['kind'] === 'signal-wait';
}

/**
 * Deliver a forwarded worker `ctx.log` to the host `onLog` sink (#529), AFTER the
 * caller has verified the sending worker owns `message.workflowId` (the trust-boundary
 * ownership gate stays inline in the strategy). This is the mechanical tail: DROP unless
 * the record is a structurally valid {@link WorkflowLogRecord} whose `workflowId`
 * matches the envelope and the message is within the size cap; then deliver to `onLog`.
 * The log lane is non-fatal in every dimension — malformed, identity-mismatched,
 * oversize, throwing-sink — so it never throws and never signals a worker discard. A
 * throwing host sink falls back to the console via the shared {@link logRecordToConsole},
 * mirroring the inline sink, so a logging error can never fail the workflow.
 */
export function deliverForwardedWorkerLog(
  message: WorkerLogMessageCandidate,
  onLog: ((record: WorkflowLogRecord) => void) | undefined,
  maxProtocolMessageBytes: number | undefined,
): void {
  if (!isValidWorkerLogRecord(message.record)) return;
  const record = message.record;
  if (record.workflowId !== message.workflowId) return;
  if (maxProtocolMessageBytes !== undefined) {
    try {
      assertWorkerProtocolMessageWithinLimit(message, maxProtocolMessageBytes);
    } catch {
      return;
    }
  }
  if (onLog === undefined) return;
  try {
    onLog(record);
  } catch {
    logRecordToConsole(record);
  }
}
