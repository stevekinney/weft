import { logRecordToConsole } from './context/workflow-logger.ts';
import type { WorkerOutboundMessage } from './types.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import type { ForwardedWorkerLogOutcome } from './worker-log-abuse-counter.ts';
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
 * the message is within the size cap AND the record is a structurally valid
 * {@link WorkflowLogRecord} whose `workflowId` matches the envelope; then deliver to
 * `onLog`. The log lane is non-fatal per delivery — malformed, identity-mismatched,
 * oversize, throwing-sink — so a SINGLE occurrence never throws and never discards the
 * worker. A throwing host sink falls back to the console via the shared
 * {@link logRecordToConsole}, mirroring the inline sink, so a logging error can never
 * fail the workflow.
 *
 * The size check is intentionally performed BEFORE the structural check so that a huge
 * malformed record is classified `dropped-oversize` rather than `dropped-invalid` (#545):
 * the dominant abuse cost of an oversize record — the runtime's structured clone on
 * receipt — is paid regardless of whether the payload is well-formed.
 *
 * The returned {@link ForwardedWorkerLogOutcome} is what the strategy feeds to the
 * per-worker abuse counter (#545): `accepted-valid` counts a delivered (or, with no
 * sink, would-be-delivered) record; `dropped-oversize`/`dropped-invalid` are anomalies
 * that accumulate lifetime strikes. The helper still NEVER discards a worker — that
 * remediation decision belongs to the counter and the strategy.
 */
export function deliverForwardedWorkerLog(
  message: WorkerLogMessageCandidate,
  onLog: ((record: WorkflowLogRecord) => void) | undefined,
  maxProtocolMessageBytes: number | undefined,
): ForwardedWorkerLogOutcome {
  if (maxProtocolMessageBytes !== undefined) {
    try {
      assertWorkerProtocolMessageWithinLimit(message, maxProtocolMessageBytes);
    } catch {
      return 'dropped-oversize';
    }
  }
  if (!isValidWorkerLogRecord(message.record)) return 'dropped-invalid';
  const record = message.record;
  if (record.workflowId !== message.workflowId) return 'dropped-invalid';
  if (onLog !== undefined) {
    try {
      onLog(record);
    } catch {
      logRecordToConsole(record);
    }
  }
  return 'accepted-valid';
}
