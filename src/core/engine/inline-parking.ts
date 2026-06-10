import type { ContextOperationRequest } from '../context.ts';
import type { WorkerOutboundMessage, WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  resumeWorkflowFromStorage as resumeWorkflowFromStorageFromLifecycle,
  type LifecycleCallbacks,
} from './lifecycle.ts';
import {
  completeWorkflow as completeWorkflowFromTermination,
  failWorkflow as failWorkflowFromTermination,
  type TerminationCallbacks,
} from './termination.ts';

export type ParkedWorkflowResumeDisposition = 'resumable' | 'terminal-or-missing' | 'corrupt';

export type InlineParkingCallbacks = {
  createLifecycleCallbacks: () => LifecycleCallbacks;
  createTerminationCallbacks: () => TerminationCallbacks;
  evaluateConstraints: (workflowId: string) => Promise<boolean>;
  getParkedWorkflowResumeDisposition: (
    workflowId: string,
  ) => Promise<ParkedWorkflowResumeDisposition>;
  hasBufferedSignal: (workflowId: string, signalName: string) => Promise<boolean>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  parkInlineWorkflowAfterCheckpoint: (
    workflowId: string,
    operation: ContextOperationRequest,
  ) => Promise<boolean>;
  persistCheckpoint: (
    workflowId: string,
    operation: ContextOperationRequest,
    workerCheckpointBytes?: ArrayBuffer,
  ) => Promise<void>;
  processOperation: (workflowId: string, operation: ContextOperationRequest) => Promise<void>;
  readCheckpointBytes: (workflowId: string) => Promise<Uint8Array | null>;
  resumeParkedInlineWorkflow: (workflowId: string) => Promise<void>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  translateOperationRequest: (operationRequest: unknown) => ContextOperationRequest;
  validateDevelopmentCheckpoint: (workflowId: string) => void;
};

export async function parkInlineWorkflowAfterCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  callbacks: InlineParkingCallbacks,
): Promise<boolean> {
  if (operation.type !== 'wait-signal' || internals.inlineStrategy === null) {
    return false;
  }

  const inlineStrategy = internals.inlineStrategy;
  const context = inlineStrategy.getContext(workflowId);
  if (context?.hasUpdateHandlers || context?.hasExposedAccessors) {
    return false;
  }

  if (await callbacks.hasBufferedSignal(workflowId, operation.signalName)) {
    return false;
  }

  // Publish the parked marker in the same serialized section that terminal
  // state writes use so cancel/timeout cannot clean up before the add lands.
  const publishedParkedMarker = await callbacks.runSerializedWorkflowStateWrite(
    workflowId,
    async () => {
      const latestState = await callbacks.loadWorkflowState(workflowId);
      if (
        internals.terminalizingWorkflows.has(workflowId) ||
        !latestState ||
        latestState.status !== 'running'
      ) {
        return false;
      }

      // Retain the run's Context so ctx.onQuery handlers stay callable while it
      // is parked on waitForSignal. Other teardown paths, such as suspend, use
      // the default eviction.
      inlineStrategy.parkWorkflow(workflowId, { retainContext: true });
      internals.parkedInlineWorkflows.add(workflowId);
      return true;
    },
  );
  if (!publishedParkedMarker) {
    return false;
  }

  // Close the race where a signal arrives after the pre-park scan above but
  // before the workflow becomes visibly parked. Once the parked marker is
  // published, a second buffered-signal check lets us resume immediately
  // instead of leaving a durable signal stranded in storage.
  if (await callbacks.hasBufferedSignal(workflowId, operation.signalName)) {
    await callbacks.resumeParkedInlineWorkflow(workflowId);
  }

  return true;
}

export async function resumeParkedInlineWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: InlineParkingCallbacks,
): Promise<void> {
  if (!internals.parkedInlineWorkflows.has(workflowId)) {
    return;
  }

  internals.parkedInlineWorkflows.delete(workflowId);
  try {
    await resumeWorkflowFromStorageFromLifecycle(
      internals,
      workflowId,
      false,
      callbacks.createLifecycleCallbacks(),
    );
  } catch (error) {
    const resumeDisposition = await callbacks.getParkedWorkflowResumeDisposition(workflowId);
    if (resumeDisposition === 'resumable') {
      internals.parkedInlineWorkflows.add(workflowId);
      throw error;
    }
    if (resumeDisposition === 'corrupt') {
      throw error;
    }
  }
}

export async function getParkedWorkflowResumeDisposition(
  internals: EngineInternals,
  workflowId: string,
  callbacks: InlineParkingCallbacks,
): Promise<ParkedWorkflowResumeDisposition> {
  if (internals.terminalizingWorkflows.has(workflowId)) {
    return 'terminal-or-missing';
  }

  const state = await callbacks.loadWorkflowState(workflowId);
  if (!state || state.status !== 'running') {
    return 'terminal-or-missing';
  }

  const checkpointBytes = await callbacks.readCheckpointBytes(workflowId);
  if (!checkpointBytes) {
    return 'corrupt';
  }

  return 'resumable';
}

export async function handleStrategyMessage(
  internals: EngineInternals,
  message: WorkerOutboundMessage,
  callbacks: InlineParkingCallbacks,
): Promise<void> {
  switch (message.type) {
    case 'completed':
      await completeWorkflowFromTermination(
        internals,
        message.workflowId,
        message.result,
        callbacks.createTerminationCallbacks(),
      );
      break;

    case 'failed': {
      const failedError = new Error(message.error);
      // Preserve the original error stack from the strategy if available,
      // rather than using the stack pointing to engine internals.
      if (message.errorStack) {
        failedError.stack = message.errorStack;
      }
      await failWorkflowFromTermination(
        internals,
        message.workflowId,
        failedError,
        callbacks.createTerminationCallbacks(),
        message.failureCategory ?? 'system',
      );
      break;
    }

    case 'checkpoint': {
      const operation = callbacks.translateOperationRequest(message.operationRequest);

      // Persist checkpoint at this yield boundary
      await callbacks.persistCheckpoint(message.workflowId, operation, message.checkpoint);

      // Development mode: validate checkpoint round-trip
      callbacks.validateDevelopmentCheckpoint(message.workflowId);

      // Evaluate domain constraints — done after persistence so the
      // checkpoint is durable before any violation reaction.
      const constraintViolated = await callbacks.evaluateConstraints(message.workflowId);
      if (constraintViolated) {
        // Violation already handled (event dispatched, error thrown or logged).
        break;
      }

      if (await callbacks.parkInlineWorkflowAfterCheckpoint(message.workflowId, operation)) {
        break;
      }

      if (operation.type === 'wait-signal' && internals.inlineStrategy === null) {
        void callbacks.processOperation(message.workflowId, operation).catch((error: unknown) => {
          const failedError = error instanceof Error ? error : new Error(String(error));
          return failWorkflowFromTermination(
            internals,
            message.workflowId,
            failedError,
            callbacks.createTerminationCallbacks(),
            'system',
          );
        });
        break;
      }

      // Translate the operation request: worker protocol uses `kind` while the
      // engine uses `type`. Inline strategy already emits ContextOperationRequest.
      await callbacks.processOperation(message.workflowId, operation);
      break;
    }
  }
}
