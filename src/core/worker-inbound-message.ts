/**
 * Builders for the `run`/`resume` {@link WorkerInboundMessage} envelopes the
 * {@link import('./worker-execution-strategy.ts').WorkerExecutionStrategy} sends to a
 * worker. Extracted as free functions so the strategy stays under the line cap and the
 * envelope-construction rules (protocol version, turn id, size cap, host-log-sink
 * stamping) live in one place. The strategy keeps ownership of the turn-id counter and
 * the assert-and-send; these functions only assemble the message.
 *
 * @module core/worker-inbound-message
 */

import type { OperationOutcome, WorkerInboundMessage } from './types.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';

/** The turn-protocol context every inbound message carries, owned by the strategy. */
export interface WorkerInboundMessageContext {
  turnId: number;
  maxProtocolMessageBytes: number | undefined;
  /** Whether the engine host installed an `onLog` sink; stamps `hostHasLogSink` (#529). */
  hasLogSink: boolean;
}

/** Build a `run` inbound message from start parameters and the turn context. */
export function buildRunMessage(
  parameters: {
    workflowId: string;
    workflowExecutionToken?: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer;
    executionStateOwnerId?: string;
    deadline?: number;
    headers?: [string, string][];
  },
  context: WorkerInboundMessageContext,
): WorkerInboundMessage & { type: 'run' } {
  const message: WorkerInboundMessage & { type: 'run' } = {
    type: 'run',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    turnId: context.turnId,
    workflowId: parameters.workflowId,
    ...(parameters.workflowExecutionToken !== undefined && {
      workflowExecutionToken: parameters.workflowExecutionToken,
    }),
    workflowType: parameters.workflowType,
    checkpoint: parameters.checkpoint,
    input: parameters.input,
    executionStateOwnerId: parameters.executionStateOwnerId ?? parameters.workflowId,
  };
  if (context.maxProtocolMessageBytes !== undefined) {
    message.maxProtocolMessageBytes = context.maxProtocolMessageBytes;
  }
  if (parameters.deadline !== undefined) {
    message.deadline = parameters.deadline;
  }
  if (parameters.headers) {
    message.headers = parameters.headers;
  }
  if (context.hasLogSink) {
    message.hostHasLogSink = true;
  }
  return message;
}

/** Build a `resume` inbound message from resume parameters and the turn context. */
export function buildResumeMessage(
  parameters: { workflowId: string; checkpoint: ArrayBuffer; operationResult: OperationOutcome },
  context: WorkerInboundMessageContext,
): WorkerInboundMessage & { type: 'resume' } {
  const message: WorkerInboundMessage & { type: 'resume' } = {
    type: 'resume',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    turnId: context.turnId,
    workflowId: parameters.workflowId,
    checkpoint: parameters.checkpoint,
    operationResult: parameters.operationResult,
  };
  if (context.maxProtocolMessageBytes !== undefined) {
    message.maxProtocolMessageBytes = context.maxProtocolMessageBytes;
  }
  if (context.hasLogSink) {
    message.hostHasLogSink = true;
  }
  return message;
}
