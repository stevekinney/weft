import type { ContextOperationRequest } from '../context.ts';
import { hasExposedAccessors, hasUpdateHandlers } from '../context/context-presence.ts';
import { attachErrorCode } from '../error-code-of.ts';
import type { WorkerOutboundMessage, WorkflowState } from '../types.ts';
import { beginInFlightOperation, endInFlightOperation } from './in-flight-operation.ts';
import type { EngineInternals } from './internals.ts';
import {
  resumeWorkflowFromStorage as resumeWorkflowFromStorageFromLifecycle,
  type LifecycleCallbacks,
} from './lifecycle.ts';
import { captureSignalWaitRun, recordSignalWaitBegan } from './signal-wait-tracking.ts';
import { notifySignalWaitReadyForTesting } from './signals.ts';
import {
  recordDurableInlineOperation,
  rejectSleepTimerAcknowledgements,
} from './sleep-timer-acknowledgements.ts';
import {
  endRunAfterFailedWrite,
  endRunAfterStrategyError,
  isTerminalWaiterPending,
  settleUnsettledTerminalMessage,
  terminalWriteOf,
} from './terminal-run-exit.ts';
import {
  completeWorkflow as completeWorkflowFromTermination,
  failWorkflow as failWorkflowFromTermination,
  type TerminationCallbacks,
} from './termination.ts';
import { captureTerminatedRun, type TerminatedRun } from './termination/settle-refused-terminal.ts';

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
    pendingStepIndex?: number,
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
  if (context && (hasUpdateHandlers(context) || hasExposedAccessors(context))) {
    return false;
  }

  // The run this park belongs to, captured before the first await (COR-1604). A
  // cancel and a `start-new` replacement that parks can all land during either
  // buffered-signal read below, and the replacement's parked marker then makes
  // `parkedInlineWorkflows` say this id is still waiting.
  const run = captureSignalWaitRun(internals, workflowId);

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
  notifySignalWaitReadyForTesting(internals, workflowId);
  notifyWorkflowParkedForTesting(internals, workflowId);

  // Close the race where a signal arrives after the pre-park scan above but
  // before the workflow becomes visibly parked. Once the parked marker is
  // published, a second buffered-signal check lets us resume immediately
  // instead of leaving a durable signal stranded in storage.
  if (await callbacks.hasBufferedSignal(workflowId, operation.signalName)) {
    await callbacks.resumeParkedInlineWorkflow(workflowId);
    return true;
  }

  // No signal was waiting, so the wait has begun. A delivery that resumes the
  // run before this record is written drops the parked marker first, and the
  // record then leaves the name out.
  await recordSignalWaitBegan(internals, workflowId, run, operation.signalName, () =>
    internals.parkedInlineWorkflows.has(workflowId),
  );
  return true;
}

/**
 * Wake every test waiting on `ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING`
 * for `workflowId`, once the workflow's park marker is published.
 */
function notifyWorkflowParkedForTesting(internals: EngineInternals, workflowId: string): void {
  const readinessWaiters = internals.parkedWorkflowReadyWaitersForTesting?.get(workflowId);
  if (readinessWaiters !== undefined) {
    internals.parkedWorkflowReadyWaitersForTesting?.delete(workflowId);
    for (const notifyReady of readinessWaiters) notifyReady();
  }
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
      undefined,
      { skipEagerRevisionCheck: true },
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

async function dispatchStrategyMessage(
  internals: EngineInternals,
  message: WorkerOutboundMessage,
  callbacks: InlineParkingCallbacks,
  run: TerminatedRun,
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
      // The message alone lost the original error's code; the strategy carried it beside it.
      attachErrorCode(failedError, message.errorCode);
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

      // Record the operation this turn is processing before anything awaits: the history circuit
      // breaker terminates the run from inside `persistCheckpoint` and must already see an
      // activity in flight (COR-1597). The `finally` clears it, which also covers the early
      // `break`s and a `persistCheckpoint` that throws.
      const inFlight = beginInFlightOperation(internals, message.workflowId, operation);
      try {
        // Persist checkpoint at this yield boundary
        await callbacks.persistCheckpoint(
          message.workflowId,
          operation,
          message.checkpoint,
          message.pendingStepIndex,
        );
        recordDurableInlineOperation(internals, message.workflowId, operation);

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
          // The worker's wait-signal loop runs detached from this message, so its rejection ends
          // the run from here, bound to the run the message was dispatched for (`run`): by the
          // time the loop fails, the id may be another run's.
          void callbacks.processOperation(message.workflowId, operation).catch((error: unknown) => {
            const failedError = error instanceof Error ? error : new Error(String(error));
            return endRunAfterFailedWrite(
              internals,
              message.workflowId,
              callbacks,
              failedError,
              'checkpoint',
              run,
              failedError,
            );
          });
          break;
        }

        // Translate the operation request: worker protocol uses `kind` while the
        // engine uses `type`. Inline strategy already emits ContextOperationRequest.
        await callbacks.processOperation(message.workflowId, operation);
        break;
      } finally {
        endInFlightOperation(internals, message.workflowId, inFlight);
      }
    }
  }
}

export async function handleStrategyMessage(
  internals: EngineInternals,
  message: WorkerOutboundMessage,
  callbacks: InlineParkingCallbacks,
): Promise<void> {
  const terminalWrite = terminalWriteOf(message);
  // The run this message belongs to, as it stands before anything awaits: a terminal commit
  // releases what identifies it, and a checkpoint write is retried for most of a second, during
  // which a cancel and a `start-new` replacement, or a relaunch, can put another run under the id.
  // Every exit below ends this run and no other (see `terminal-run-exit.ts`).
  const run = captureTerminatedRun(internals, message.workflowId);
  try {
    await dispatchStrategyMessage(internals, message, callbacks, run);
    // A terminal message that returned with its run's waiter still pending did not settle it.
    if (
      terminalWrite !== undefined &&
      isTerminalWaiterPending(internals, message.workflowId, run)
    ) {
      await settleUnsettledTerminalMessage(internals, message.workflowId, callbacks, run);
    }
  } catch (error) {
    rejectSleepTimerAcknowledgements(internals, message.workflowId, error);
    // The inline strategy contains a handler's rejection so one workflow's failure cannot take
    // down the engine, and recovery runs only at boot, so what is left alone here stays un-driven
    // until the next restart. Every error below therefore ends the run here instead; see
    // `endRunAfterFailedWrite` for how, and for the one case that stays `running` durably.
    //
    // A storage write the engine needs (the checkpoint batch, or a terminal `wf:` write) that
    // storage refused on every attempt is a `CheckpointCommitFailedError`: the write already
    // retried, five attempts over 750 ms. Any other error out of a terminal message ends the run
    // the same way, because the terminal write is the last thing that can settle it.
    //
    // A checkpoint that cannot be encoded is not retryable, since the same state fails on every
    // resume, so left alone it would stay `running` with `result()` pending forever. Fail the
    // workflow with the cause instead.
    //
    // A checkpoint commit that lost its compare-and-swap race means another engine over the same
    // store already advanced this workflow and owns its durable state. `commitCheckpoint` already
    // abandoned the run where it detected the loss (this engine stops driving it and settles its
    // local handle); all that is left is to write nothing: failing the workflow here would
    // overwrite the winner.
    await endRunAfterStrategyError(
      internals,
      message.workflowId,
      callbacks,
      error,
      terminalWrite,
      run,
    );
  }
}
