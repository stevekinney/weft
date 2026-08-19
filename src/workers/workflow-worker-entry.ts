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
import type { WorkerRealmReadyMessage } from '../core/worker-realm-readiness.ts';
import { buildInternalRealmManifest } from '../worker/manifest/internal-realm.ts';
import type { WorkerLogPoster, WorkerWorkflowContext } from './workflow-runner.ts';
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

/**
 * Post a forwarded `ctx.log` message to the host, size-checked first (#529). The runner
 * builds the `log` message (it carries the record and the workflow identity, no turn
 * state) and passes the size cap it captured at run construction; this primitive owns the
 * actual `postMessage`. A throw on oversize is intentional — the shared logger factory
 * catches it and falls the record back to the worker console, so a log never fails the run
 * and an oversize log never reaches the host.
 */
const postLogMessage: WorkerLogPoster = (message, maxProtocolMessageBytes) => {
  assertWorkerProtocolMessageWithinLimit(message, maxProtocolMessageBytes);
  workerPostMessage(message);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A workflow handler. Receives a worker-side {@link WorkerWorkflowContext} as
 * the first argument so it can read `ctx.workflowId` exactly like inline-mode
 * handlers do.
 */
export type WorkflowHandler = (ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator;

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the worker message loop. Call this from within a Web Worker
 * to wire up the message protocol.
 *
 * Sends a {@link WorkerRealmReadyMessage} first (WFT-28), built from exactly the
 * workflow type names in `workflows` — the host validates it against its own
 * expected manifest before this realm can receive its first `run` turn.
 *
 * @param workflows - Map of workflow type name to its async generator
 *   function. This is also the realm's complete workflow-type advertisement:
 *   the same names the ready manifest reports.
 */
export function initializeWorkerMessageLoop(
  workflows: Readonly<Record<string, WorkflowHandler>>,
): void {
  const runnerContext = createWorkflowRunnerContext();
  const getWorkflowHandler = (type: string): WorkflowHandler | undefined => workflows[type];

  const readyMessage: WorkerRealmReadyMessage = {
    type: 'ready',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    realmGeneration: crypto.randomUUID(),
    manifest: buildInternalRealmManifest(Object.keys(workflows)),
  };
  workerPostMessage(readyMessage);

  self.addEventListener('message', async (event: MessageEvent<WorkerInboundMessage>) => {
    const message = event.data;

    switch (message.type) {
      case 'run': {
        const response = await handleRunMessage(
          runnerContext,
          message,
          getWorkflowHandler,
          message.hostHasLogSink ? postLogMessage : undefined,
        );
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
