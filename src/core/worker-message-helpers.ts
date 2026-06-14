import type { WorkerOutboundMessage } from './types.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import { isValidWorkerLogRecord } from './worker-protocol-log.ts';
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
 * Deliver a forwarded worker `ctx.log` to the host `onLog` sink (#529): DELIVER a valid
 * in-budget record, DROP a malformed or oversize one, never throw. A `log` carries no
 * turn-protocol state, so it must never discard the worker; validity uses the shared
 * {@link isValidWorkerLogRecord} and a throwing host sink is swallowed so a logging
 * error can never fail the workflow.
 */
export function deliverWorkerLog(
  message: Extract<WorkerOutboundMessage, { type: 'log' }>,
  onLog: ((record: WorkflowLogRecord) => void) | undefined,
  maxProtocolMessageBytes: number | undefined,
): void {
  if (!isValidWorkerLogRecord(message.record)) return;
  if (maxProtocolMessageBytes !== undefined) {
    try {
      assertWorkerProtocolMessageWithinLimit(message, maxProtocolMessageBytes);
    } catch {
      return;
    }
  }
  try {
    onLog?.(message.record);
  } catch {}
}
