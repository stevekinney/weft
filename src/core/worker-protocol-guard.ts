import type { FailureCategory, WorkerInboundMessage, WorkerOutboundMessage } from './types.ts';
import {
  assertWorkerOutboundMessageShape,
  assertWorkerProtocolMessageWithinLimit,
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  WorkerProtocolMessageSizeError,
} from './worker-protocol.ts';
import type { WorkerTurnWatchdog } from './worker-turn-watchdog.ts';

export interface WorkerProtocolFailure {
  failureCategory: FailureCategory;
  error: string;
  targetWorkflowId?: string;
  otherError: string;
}

export class WorkerProtocolGuard {
  readonly #maxProtocolMessageBytes: number | undefined;
  readonly #requireProtocolVersion: boolean;
  readonly #turnWatchdog: WorkerTurnWatchdog;

  constructor(
    maxProtocolMessageBytes: number | undefined,
    requireProtocolVersion: boolean,
    turnWatchdog: WorkerTurnWatchdog,
  ) {
    this.#maxProtocolMessageBytes = maxProtocolMessageBytes;
    this.#requireProtocolVersion = requireProtocolVersion;
    this.#turnWatchdog = turnWatchdog;
  }

  validateHostToWorkerMessage(message: WorkerInboundMessage): WorkerProtocolFailure | null {
    try {
      assertWorkerProtocolMessageWithinLimit(message, this.#maxProtocolMessageBytes);
      return null;
    } catch (error) {
      return protocolFailure(error, {
        otherError: 'Worker protocol send failed',
      });
    }
  }

  acceptWorkerMessage(
    worker: Worker,
    message: unknown,
  ):
    | { accepted: true; message: WorkerOutboundMessage }
    | { accepted: false; failure: WorkerProtocolFailure } {
    try {
      assertWorkerOutboundMessageShape(message);
      assertWorkerProtocolMessageWithinLimit(message, this.#maxProtocolMessageBytes);
      if (this.#requireProtocolVersion) {
        this.#assertExpectedWorkerTurn(worker, message);
      }
      return { accepted: true, message };
    } catch (error) {
      const targetWorkflowId = workflowIdFromWorkerMessage(message);
      return {
        accepted: false,
        failure: protocolFailure(error, {
          ...(targetWorkflowId === undefined ? {} : { targetWorkflowId }),
          otherError:
            targetWorkflowId === undefined
              ? 'Worker discarded after protocol violation'
              : `Worker discarded after protocol violation for workflow: ${targetWorkflowId}`,
        }),
      };
    }
  }

  #assertExpectedWorkerTurn(worker: Worker, message: WorkerOutboundMessage): void {
    if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
      throw new WorkerProtocolError('Worker protocol version mismatch');
    }

    const turn = this.#turnWatchdog.get(worker);
    if (!turn) {
      throw new WorkerProtocolError('Worker message arrived outside an active turn');
    }
    // `log` is the only variant without a `turnId` (it is non-terminal observability
    // routed through the lenient lane and never reaches this strict gate, #529); the
    // turn-bearing variants all carry `turnId?`. Narrow before reading so the union
    // stays honest after `log` dropped the field.
    const messageTurnId = message.type === 'log' ? undefined : message.turnId;
    if (messageTurnId !== turn.turnId || message.workflowId !== turn.workflowId) {
      throw new WorkerProtocolError('Worker message did not match the active turn');
    }
  }
}

function protocolFailure(
  error: unknown,
  options: { targetWorkflowId?: string; otherError: string },
): WorkerProtocolFailure {
  return {
    ...(options.targetWorkflowId === undefined
      ? {}
      : { targetWorkflowId: options.targetWorkflowId }),
    failureCategory: error instanceof WorkerProtocolMessageSizeError ? 'resource' : 'system',
    error: error instanceof Error ? error.message : String(error),
    otherError: options.otherError,
  };
}

function workflowIdFromWorkerMessage(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const workflowId = (message as Record<string, unknown>)['workflowId'];
  return typeof workflowId === 'string' ? workflowId : undefined;
}
