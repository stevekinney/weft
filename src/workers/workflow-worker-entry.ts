/**
 * Web Worker entry point for workflow execution.
 *
 * Sets up `self.onmessage` to handle {@link WorkerInboundMessage} and posts
 * back {@link WorkerOutboundMessage} via `self.postMessage`. Uses the
 * existing runner helpers from `workflow-runner.ts`.
 *
 * @module workers/workflow-worker-entry
 */

import type { WorkerInboundMessage, WorkerOutboundMessage } from '../core/types.ts';
import {
  assertWorkerProtocolMessageWithinLimit,
  createBoundedWorkerFailureMessage,
  WORKER_PROTOCOL_VERSION,
} from '../core/worker-protocol.ts';
import type { WorkerWorkflowContext } from './workflow-runner.ts';
import {
  cleanupWorkflowRunnerState,
  createWorkflowRunnerContext,
  handleCancelMessage,
  handleResumeMessage,
  handleRunMessage,
} from './workflow-runner.ts';

const workerPostMessage = self.postMessage.bind(self);
const workerClose =
  'close' in self && typeof self.close === 'function' ? self.close.bind(self) : undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Factory that resolves a workflow type name to its handler. Handlers receive
 * a worker-side {@link WorkerWorkflowContext} as the first argument so they
 * can read `ctx.workflowId` exactly like inline-mode handlers do.
 */
export type WorkflowHandlerFactory = (
  type: string,
) => ((ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator) | undefined;

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the worker message loop. Call this from within a Web Worker
 * to wire up the message protocol.
 *
 * @param getWorkflowHandler - Factory that resolves a workflow type name to
 *   its async generator function. Typically backed by a registration map.
 */
export function initializeWorkerMessageLoop(getWorkflowHandler: WorkflowHandlerFactory): void {
  const runnerContext = createWorkflowRunnerContext();

  self.addEventListener('message', async (event: MessageEvent<WorkerInboundMessage>) => {
    const message = event.data;

    switch (message.type) {
      case 'run': {
        const response = await handleRunMessage(runnerContext, message, getWorkflowHandler);
        postOutboundMessage(runnerContext, response, message);
        break;
      }

      case 'resume': {
        const resultValue =
          message.operationResult.status === 'completed'
            ? message.operationResult.value
            : undefined;

        const resumeMessage = {
          workflowId: message.workflowId,
          result: resultValue,
          operationResult: message.operationResult,
          ...(message.maxProtocolMessageBytes === undefined
            ? {}
            : { maxProtocolMessageBytes: message.maxProtocolMessageBytes }),
        };
        const response = await handleResumeMessage(runnerContext, resumeMessage);
        postOutboundMessage(runnerContext, response, message);
        break;
      }

      case 'cancel': {
        await handleCancelMessage(runnerContext, message);
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Post an outbound message back to the main thread, using the checkpoint
 * ArrayBuffer as a Transferable for zero-copy transfer.
 */
function postOutboundMessage(
  runnerContext: ReturnType<typeof createWorkflowRunnerContext>,
  message: WorkerOutboundMessage,
  inboundMessage: Extract<WorkerInboundMessage, { type: 'run' | 'resume' }>,
): void {
  const outboundMessage = attachWorkerProtocol(message, inboundMessage);
  try {
    assertWorkerProtocolMessageWithinLimit(outboundMessage, inboundMessage.maxProtocolMessageBytes);
    if (outboundMessage.type === 'checkpoint') {
      workerPostMessage(outboundMessage, [outboundMessage.checkpoint]);
    } else {
      workerPostMessage(outboundMessage);
    }
  } catch (error) {
    cleanupWorkflowRunnerState(runnerContext, inboundMessage.workflowId);
    const failedMessage = createBoundedWorkerFailureMessage({
      workflowId: inboundMessage.workflowId,
      error: error instanceof Error ? error.message : String(error),
      failureCategory: 'resource',
      ...(inboundMessage.turnId === undefined ? {} : { turnId: inboundMessage.turnId }),
    });
    try {
      workerPostMessage(failedMessage);
    } catch {
      workerClose?.();
    }
  }
}

function attachWorkerProtocol(
  message: WorkerOutboundMessage,
  inboundMessage: Extract<WorkerInboundMessage, { type: 'run' | 'resume' }>,
): WorkerOutboundMessage {
  return {
    ...message,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    ...(inboundMessage.turnId === undefined ? {} : { turnId: inboundMessage.turnId }),
  } as WorkerOutboundMessage;
}
